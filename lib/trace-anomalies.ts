import { formatTimeShort } from "@/lib/trace-types";
import type {
  IndexedTraceEvent,
  TraceAnomaly,
  TraceAnomalyComparison,
  TraceAnomalyCounterSignal,
  TraceAnomalyKindSummary,
  TraceIndex,
} from "@/lib/trace-chat";

interface CounterGroup {
  key: string;
  name: string;
  category: string;
  medianValue: number | null;
  events: Array<{
    event: IndexedTraceEvent;
    value: number;
  }>;
}

type ScoredCounterSignal = TraceAnomalyCounterSignal & {
  score: number;
  sampleEventId: string;
};

interface Interval {
  start: number;
  end: number;
}

const MAX_BASE_ANOMALIES = 24;
const MAX_VISIBLE_ANOMALIES = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function clampConfidence(value: number): number {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

function clampWeirdness(value: number): number {
  return clamp(Math.round(value), 0, 100);
}

function hashString(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function createAnomalyId(kind: TraceAnomaly["kind"], fingerprint: string): string {
  const head = fingerprint.replace(/\s+/g, "_").slice(0, 96);
  return `anomaly:${kind}:${head}:${hashString(fingerprint)}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const position = clamp(p, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function mad(values: number[], baselineMedian: number): number {
  if (values.length === 0) return 0;
  return median(values.map((value) => Math.abs(value - baselineMedian)));
}

function overlaps(startTime: number, endTime: number, rangeStart: number, rangeEnd: number): boolean {
  return endTime >= rangeStart && startTime <= rangeEnd;
}

function numericCounterValue(event: IndexedTraceEvent): number | null {
  if (!event.args) return null;

  for (const value of Object.values(event.args)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

function buildCounterGroups(events: IndexedTraceEvent[]): CounterGroup[] {
  const grouped = new Map<
    string,
    {
      name: string;
      category: string;
      values: number[];
      events: Array<{ event: IndexedTraceEvent; value: number }>;
    }
  >();

  for (const event of events) {
    if (event.kind !== "counter") continue;
    const value = numericCounterValue(event);
    if (value == null) continue;

    const key = `${event.name}::${event.cat}`;
    const entry = grouped.get(key) ?? {
      name: event.name,
      category: event.cat,
      values: [],
      events: [],
    };

    entry.values.push(value);
    entry.events.push({ event, value });
    grouped.set(key, entry);
  }

  return [...grouped.entries()].map(([key, entry]) => ({
    key,
    name: entry.name,
    category: entry.category,
    medianValue: entry.values.length >= 2 ? median(entry.values) : null,
    events: entry.events.sort((left, right) => left.event.ts - right.event.ts),
  }));
}

function findRelatedCounters(
  counterGroups: CounterGroup[],
  startTime: number,
  endTime: number,
  limit = 2
): TraceAnomalyCounterSignal[] {
  const windowDuration = Math.max(endTime - startTime, 1);
  const padding = Math.max(windowDuration * 0.5, 2_000);
  const windowStart = startTime - padding;
  const windowEnd = endTime + padding;

  return counterGroups
    .map((group) => {
      const best = group.events
        .filter(({ event }) => event.ts >= windowStart && event.ts <= windowEnd)
        .map(({ event, value }) => {
          const medianValue = group.medianValue;
          const deltaFromMedian =
            medianValue == null ? null : value - medianValue;
          const deltaRatio =
            medianValue == null
              ? null
              : Math.abs(medianValue) < 1e-9
                ? value === 0
                  ? 0
                  : null
                : (value - medianValue) / medianValue;

          return {
            name: group.name,
            category: group.category,
            value,
            medianValue,
            ts: event.ts,
            deltaFromMedian,
            deltaRatio,
            sampleEventId: event.id,
            score:
              Math.abs(deltaRatio ?? 0) * 40 +
              Math.abs(deltaFromMedian ?? 0) * 0.05,
          };
        })
        .sort((left, right) => right.score - left.score)[0];

      return best ?? null;
    })
    .filter((signal): signal is ScoredCounterSignal => signal !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ score: _score, ...signal }) => signal);
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];

  const sorted = intervals
    .slice()
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Interval[] = [{ ...sorted[0] }];

  for (let index = 1; index < sorted.length; index += 1) {
    const interval = sorted[index];
    const previous = merged[merged.length - 1];
    if (interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
      continue;
    }

    merged.push({ ...interval });
  }

  return merged;
}

function sumIntervals(intervals: Interval[]): number {
  return intervals.reduce((total, interval) => total + Math.max(interval.end - interval.start, 0), 0);
}

function buildDurationOutlierAnomalies(
  traceIndex: TraceIndex,
  spanEvents: IndexedTraceEvent[]
): TraceAnomaly[] {
  const grouped = new Map<string, IndexedTraceEvent[]>();

  for (const event of spanEvents) {
    const key = `${event.name}::${event.cat}`;
    const entry = grouped.get(key);
    if (entry) {
      entry.push(event);
    } else {
      grouped.set(key, [event]);
    }
  }

  const anomalies: TraceAnomaly[] = [];

  for (const [groupKey, groupEvents] of grouped) {
    if (groupEvents.length < 4) continue;

    const durations = groupEvents
      .map((event) => event.dur)
      .filter((value) => value > 0);
    if (durations.length < 4) continue;

    const medianDuration = median(durations);
    if (medianDuration <= 0) continue;

    const p90 = percentile(durations, 0.9);
    const spread = mad(durations, medianDuration);
    const threshold = Math.max(
      medianDuration * 3,
      p90 * 1.15,
      medianDuration + Math.max(spread * 6, 1_000)
    );

    const worstEvent = groupEvents
      .filter((event) => event.dur >= threshold)
      .sort((left, right) => {
        const leftRatio = left.dur / medianDuration;
        const rightRatio = right.dur / medianDuration;
        if (rightRatio !== leftRatio) return rightRatio - leftRatio;
        return right.dur - left.dur;
      })[0];

    if (!worstEvent) continue;

    const ratio = worstEvent.dur / medianDuration;
    const callPath = traceIndex.spanNodeById.get(worstEvent.id)?.callPath;
    const fingerprint = `duration_outlier:${groupKey}:${callPath?.join(" -> ") ?? worstEvent.threadName}`;

    anomalies.push({
      id: createAnomalyId("duration_outlier", fingerprint),
      fingerprint,
      kind: "duration_outlier",
      title: `Outlier duration in ${worstEvent.name}`,
      summary: `${worstEvent.name} reaches ${formatTimeShort(worstEvent.dur)}, about ${ratio.toFixed(1)}x its median ${formatTimeShort(medianDuration)} across ${groupEvents.length} peer spans.`,
      explanation: `This span is much slower than its peers on ${worstEvent.threadName}. The peer p90 is ${formatTimeShort(p90)}, so the worst sample is not just on the tail, it is isolated.`,
      weirdness: clampWeirdness((ratio - 1) * 14 + Math.min(groupEvents.length, 12)),
      confidence: clampConfidence(0.58 + Math.min(groupEvents.length, 16) / 40 + (spread > 0 ? 0.12 : 0)),
      reasonCodes: ["peer_duration_outlier", "high_ratio_to_median", "tail_breach"],
      startTime: worstEvent.ts,
      endTime: worstEvent.endTime,
      duration: worstEvent.dur,
      processName: worstEvent.processName,
      threadName: worstEvent.threadName,
      sampleEventId: worstEvent.id,
      eventIds: [worstEvent.id],
      callPath,
      relatedCounters: [],
      stats: {
        occurrences: groupEvents.length,
        medianDuration,
        p90Duration: p90,
        ratioToMedian: ratio,
      },
    });
  }

  return anomalies;
}

function buildThreadImbalanceAnomalies(
  traceIndex: TraceIndex,
  spanEvents: IndexedTraceEvent[]
): TraceAnomaly[] {
  const processThreadMap = new Map<
    number,
    Map<string, {
      processName: string;
      threadName: string;
      eventIds: string[];
      startTime: number;
      endTime: number;
      selfTime: number;
      totalDuration: number;
    }>
  >();

  for (const event of spanEvents) {
    const processEntry = processThreadMap.get(event.pid) ?? new Map();
    const key = `${event.pid}:${event.tid}`;
    const threadEntry = processEntry.get(key) ?? {
      processName: event.processName,
      threadName: event.threadName,
      eventIds: [],
      startTime: event.ts,
      endTime: event.endTime,
      selfTime: 0,
      totalDuration: 0,
    };

    threadEntry.eventIds.push(event.id);
    threadEntry.startTime = Math.min(threadEntry.startTime, event.ts);
    threadEntry.endTime = Math.max(threadEntry.endTime, event.endTime);
    threadEntry.totalDuration += event.dur;
    threadEntry.selfTime += traceIndex.spanNodeById.get(event.id)?.selfTime ?? 0;
    processEntry.set(key, threadEntry);
    processThreadMap.set(event.pid, processEntry);
  }

  const anomalies: TraceAnomaly[] = [];

  for (const threadMap of processThreadMap.values()) {
    const threads = [...threadMap.values()].filter((thread) => thread.selfTime > 0);
    if (threads.length < 2) continue;

    const sorted = threads.slice().sort((left, right) => right.selfTime - left.selfTime);
    const dominant = sorted[0];
    const selfTimes = sorted.map((thread) => thread.selfTime);
    const medianSelfTime = median(selfTimes);
    const totalSelfTime = selfTimes.reduce((sum, value) => sum + value, 0);
    const share = dominant.selfTime / Math.max(totalSelfTime, 1);
    const ratio = dominant.selfTime / Math.max(medianSelfTime, 1);
    const peerCount = sorted.filter((thread) => thread.selfTime >= dominant.selfTime * 0.2).length;

    if (share < 0.55 || ratio < 2.5 || dominant.selfTime < 5_000) continue;

    const fingerprint = `thread_imbalance:${dominant.processName}:${dominant.threadName}`;

    anomalies.push({
      id: createAnomalyId("thread_imbalance", fingerprint),
      fingerprint,
      kind: "thread_imbalance",
      title: `Thread imbalance on ${dominant.processName}`,
      summary: `${dominant.threadName} owns ${(share * 100).toFixed(0)}% of thread self time, roughly ${ratio.toFixed(1)}x the peer median.`,
      explanation: `The process has ${threads.length} active threads, but ${dominant.threadName} is carrying most of the self time. That usually means one worker or stream is lagging or doing serialized cleanup.`,
      weirdness: clampWeirdness(share * 60 + ratio * 8 + peerCount * 2),
      confidence: clampConfidence(0.55 + Math.min(threads.length, 8) / 20),
      reasonCodes: ["thread_self_time_skew", "dominant_thread_share"],
      startTime: dominant.startTime,
      endTime: dominant.endTime,
      duration: Math.max(dominant.endTime - dominant.startTime, 0),
      processName: dominant.processName,
      threadName: dominant.threadName,
      sampleEventId: dominant.eventIds[0] ?? null,
      eventIds: dominant.eventIds.slice(0, 8),
      relatedCounters: [],
      stats: {
        activeThreadCount: threads.length,
        dominantShare: share,
        ratioToPeerMedian: ratio,
        dominantSelfTime: dominant.selfTime,
        medianPeerSelfTime: medianSelfTime,
      },
    });
  }

  return anomalies;
}

function buildGapClusterAnomalies(spanEventsByThread: Map<string, IndexedTraceEvent[]>): TraceAnomaly[] {
  const anomalies: TraceAnomaly[] = [];

  for (const threadEvents of spanEventsByThread.values()) {
    if (threadEvents.length < 3) continue;
    const durations = threadEvents.map((event) => event.dur).filter((value) => value > 0);
    const gapThreshold = Math.max(1_000, median(durations) * 0.35);
    const grouped = new Map<
      string,
      {
        processName: string;
        threadName: string;
        transition: string;
        eventIds: string[];
        startTime: number;
        endTime: number;
        totalGap: number;
        count: number;
        maxGap: number;
        sampleEventId: string | null;
      }
    >();

    for (let index = 1; index < threadEvents.length; index += 1) {
      const previous = threadEvents[index - 1];
      const current = threadEvents[index];
      const gap = current.ts - previous.endTime;
      if (gap <= gapThreshold) continue;

      const transition = `${previous.name} -> ${current.name}`;
      const key = `${previous.pid}:${previous.tid}:${transition}`;
      const entry = grouped.get(key) ?? {
        processName: current.processName,
        threadName: current.threadName,
        transition,
        eventIds: [],
        startTime: previous.endTime,
        endTime: current.ts,
        totalGap: 0,
        count: 0,
        maxGap: 0,
        sampleEventId: current.id,
      };

      entry.startTime = Math.min(entry.startTime, previous.endTime);
      entry.endTime = Math.max(entry.endTime, current.ts);
      entry.totalGap += gap;
      entry.count += 1;
      entry.maxGap = Math.max(entry.maxGap, gap);
      entry.eventIds.push(previous.id, current.id);
      grouped.set(key, entry);
    }

    for (const entry of grouped.values()) {
      if (entry.count < 2 && entry.totalGap < gapThreshold * 4) continue;

      const fingerprint = `gap_cluster:${entry.processName}:${entry.threadName}:${entry.transition}`;
      anomalies.push({
        id: createAnomalyId("gap_cluster", fingerprint),
        fingerprint,
        kind: "gap_cluster",
        title: `Repeated idle gap before ${entry.transition.split(" -> ")[1]}`,
        summary: `${entry.transition} is separated by ${entry.count} idle gap${entry.count === 1 ? "" : "s"} totaling ${formatTimeShort(entry.totalGap)} on ${entry.threadName}.`,
        explanation: `This thread repeatedly goes idle between the same transition. That often means queueing, host synchronization, or missing overlap before the next stage starts.`,
        weirdness: clampWeirdness(entry.count * 11 + (entry.maxGap / gapThreshold) * 9),
        confidence: clampConfidence(0.5 + Math.min(entry.count, 6) / 15),
        reasonCodes: ["repeated_idle_gaps", "transition_stall_pattern"],
        startTime: entry.startTime,
        endTime: entry.endTime,
        duration: Math.max(entry.endTime - entry.startTime, 0),
        processName: entry.processName,
        threadName: entry.threadName,
        sampleEventId: entry.sampleEventId,
        eventIds: uniqueStrings(entry.eventIds).slice(0, 10),
        relatedCounters: [],
        stats: {
          gapCount: entry.count,
          totalGapDuration: entry.totalGap,
          maxGapDuration: entry.maxGap,
          gapThreshold,
        },
      });
    }
  }

  return anomalies;
}

function buildRarePathAnomalies(traceIndex: TraceIndex): TraceAnomaly[] {
  const pathMap = new Map<
    string,
    {
      totalSelfTime: number;
      occurrences: number;
      maxSelfTime: number;
      processName: string;
      threadName: string;
      sampleEventId: string | null;
      eventIds: string[];
      callPath: string[];
      startTime: number;
      endTime: number;
    }
  >();

  for (const event of traceIndex.events) {
    if (event.kind !== "span") continue;
    const node = traceIndex.spanNodeById.get(event.id);
    if (!node || node.selfTime <= 0 || node.callPath.length === 0) continue;

    const key = node.callPath.join(" -> ");
    const entry = pathMap.get(key) ?? {
      totalSelfTime: 0,
      occurrences: 0,
      maxSelfTime: 0,
      processName: event.processName,
      threadName: event.threadName,
      sampleEventId: event.id,
      eventIds: [],
      callPath: node.callPath,
      startTime: event.ts,
      endTime: event.endTime,
    };

    entry.totalSelfTime += node.selfTime;
    entry.occurrences += 1;
    entry.maxSelfTime = Math.max(entry.maxSelfTime, node.selfTime);
    entry.startTime = Math.min(entry.startTime, event.ts);
    entry.endTime = Math.max(entry.endTime, event.endTime);
    entry.eventIds.push(event.id);
    pathMap.set(key, entry);
  }

  const totals = [...pathMap.values()].map((entry) => entry.totalSelfTime);
  const threshold = Math.max(percentile(totals, 0.75), 2_000);

  return [...pathMap.entries()]
    .filter(([, entry]) => entry.occurrences <= 2 && entry.totalSelfTime >= threshold)
    .map(([key, entry]) => {
      const tail = entry.callPath[entry.callPath.length - 1] ?? key;
      const fingerprint = `rare_expensive_path:${key}`;
      return {
        id: createAnomalyId("rare_expensive_path", fingerprint),
        fingerprint,
        kind: "rare_expensive_path" as const,
        title: `Rare expensive path ending in ${tail}`,
        summary: `${key} appears only ${entry.occurrences} time${entry.occurrences === 1 ? "" : "s"} but still burns ${formatTimeShort(entry.totalSelfTime)} of self time.`,
        explanation: `This path is not hot because it is frequent. It is hot because each occurrence is unusually expensive, which makes it easy to miss in simple top-N views.`,
        weirdness: clampWeirdness(42 + entry.totalSelfTime / Math.max(threshold, 1) * 15),
        confidence: clampConfidence(0.62 + (entry.occurrences === 1 ? 0.08 : 0)),
        reasonCodes: ["rare_heavy_call_path", "high_self_time_low_frequency"],
        startTime: entry.startTime,
        endTime: entry.endTime,
        duration: Math.max(entry.endTime - entry.startTime, 0),
        processName: entry.processName,
        threadName: entry.threadName,
        sampleEventId: entry.sampleEventId,
        eventIds: uniqueStrings(entry.eventIds).slice(0, 8),
        callPath: entry.callPath,
        relatedCounters: [],
        stats: {
          occurrences: entry.occurrences,
          totalSelfTime: entry.totalSelfTime,
          maxSelfTime: entry.maxSelfTime,
        },
      };
    });
}

function buildMicroFragmentationAnomalies(eventsByThread: Map<string, IndexedTraceEvent[]>): TraceAnomaly[] {
  const anomalies: TraceAnomaly[] = [];

  for (const threadEvents of eventsByThread.values()) {
    const candidateEvents = threadEvents
      .filter((event) => event.kind === "spike" || (event.kind === "span" && event.dur <= 1_000))
      .sort((left, right) => left.ts - right.ts);

    if (candidateEvents.length < 6) continue;

    const windowSize = Math.max(5_000, percentile(candidateEvents.map((event) => Math.max(event.dur, 1)), 0.75) * 24);
    let best:
      | {
          startIndex: number;
          endIndex: number;
          count: number;
          uniqueNames: number;
          startTime: number;
          endTime: number;
          totalDuration: number;
        }
      | null = null;

    let right = 0;
    let totalDuration = 0;
    const nameCounts = new Map<string, number>();

    for (let left = 0; left < candidateEvents.length; left += 1) {
      if (left > 0) {
        const previous = candidateEvents[left - 1];
        totalDuration -= Math.max(previous.dur, 1);
        const count = (nameCounts.get(previous.name) ?? 1) - 1;
        if (count <= 0) {
          nameCounts.delete(previous.name);
        } else {
          nameCounts.set(previous.name, count);
        }
      }

      while (
        right < candidateEvents.length &&
        candidateEvents[right].ts - candidateEvents[left].ts <= windowSize
      ) {
        const event = candidateEvents[right];
        totalDuration += Math.max(event.dur, 1);
        nameCounts.set(event.name, (nameCounts.get(event.name) ?? 0) + 1);
        right += 1;
      }

      const count = right - left;
      const uniqueNames = nameCounts.size;
      if (count < 6 || uniqueNames < 2) continue;

      const startTime = candidateEvents[left].ts;
      const endTime = Math.max(candidateEvents[right - 1]?.endTime ?? startTime, startTime + 1);
      const score = count * 3 + uniqueNames * 4 + totalDuration / Math.max(windowSize, 1);

      if (
        !best ||
        score >
          best.count * 3 + best.uniqueNames * 4 + best.totalDuration / Math.max(best.endTime - best.startTime, 1)
      ) {
        best = {
          startIndex: left,
          endIndex: right,
          count,
          uniqueNames,
          startTime,
          endTime,
          totalDuration,
        };
      }
    }

    if (!best || (best.count < 8 && best.uniqueNames < 3)) continue;

    const burstEvents = candidateEvents.slice(best.startIndex, best.endIndex);
    const dominantName = burstEvents
      .reduce<Map<string, number>>((accumulator, event) => {
        accumulator.set(event.name, (accumulator.get(event.name) ?? 0) + 1);
        return accumulator;
      }, new Map())
      .entries()
      .next().value?.[0] ?? burstEvents[0].name;
    const firstEvent = burstEvents[0];
    const fingerprint = `micro_fragmentation:${firstEvent.processName}:${firstEvent.threadName}:${dominantName}`;

    anomalies.push({
      id: createAnomalyId("micro_fragmentation", fingerprint),
      fingerprint,
      kind: "micro_fragmentation",
      title: `Fragmented burst on ${firstEvent.threadName}`,
      summary: `${best.count} tiny spans or spikes are packed into ${formatTimeShort(best.endTime - best.startTime)} on ${firstEvent.threadName}.`,
      explanation: `This looks like orchestration overhead, retries, or launch chatter. The work is fragmented enough that scheduling and dispatch can dominate the actual useful work.`,
      weirdness: clampWeirdness(best.count * 5 + best.uniqueNames * 4),
      confidence: clampConfidence(0.48 + Math.min(best.count, 12) / 20),
      reasonCodes: ["short_event_burst", "fragmented_execution_window"],
      startTime: best.startTime,
      endTime: best.endTime,
      duration: Math.max(best.endTime - best.startTime, 0),
      processName: firstEvent.processName,
      threadName: firstEvent.threadName,
      sampleEventId: firstEvent.id,
      eventIds: burstEvents.map((event) => event.id),
      relatedCounters: [],
      stats: {
        eventCount: best.count,
        uniqueNames: best.uniqueNames,
        totalShortEventDuration: best.totalDuration,
        windowSize: best.endTime - best.startTime,
      },
    });
  }

  return anomalies;
}

function buildPhaseShiftAnomalies(spanEventsByThread: Map<string, IndexedTraceEvent[]>): TraceAnomaly[] {
  const anomalies: TraceAnomaly[] = [];

  for (const threadEvents of spanEventsByThread.values()) {
    if (threadEvents.length < 6) continue;

    const startTime = threadEvents[0]?.ts ?? 0;
    const endTime = threadEvents.reduce((max, event) => Math.max(max, event.endTime), startTime);
    const duration = Math.max(endTime - startTime, 0);
    if (duration <= 0) continue;

    const bucketCount = clamp(Math.round(Math.sqrt(threadEvents.length)), 6, 12);
    const bucketDuration = duration / bucketCount;
    const firstEvent = threadEvents[0];
    const buckets = Array.from({ length: bucketCount }, (_, index) => {
      const bucketStart = startTime + bucketDuration * index;
      const bucketEnd = index === bucketCount - 1 ? endTime : bucketStart + bucketDuration;
      const byName = new Map<string, { overlap: number; sampleEventId: string | null }>();
      let totalOverlap = 0;

      for (const event of threadEvents) {
        const overlap = Math.max(
          0,
          Math.min(event.endTime, bucketEnd) - Math.max(event.ts, bucketStart)
        );
        if (overlap <= 0) continue;

        const entry = byName.get(event.name) ?? {
          overlap: 0,
          sampleEventId: event.id,
        };

        entry.overlap += overlap;
        byName.set(event.name, entry);
        totalOverlap += overlap;
      }

      const dominant = [...byName.entries()]
        .sort((left, right) => right[1].overlap - left[1].overlap)[0];

      return {
        bucketStart,
        bucketEnd,
        totalOverlap,
        dominantName: dominant?.[0] ?? null,
        dominantOverlap: dominant?.[1].overlap ?? 0,
        sampleEventId: dominant?.[1].sampleEventId ?? null,
      };
    });

    for (let index = 1; index < buckets.length; index += 1) {
      const previous = buckets[index - 1];
      const current = buckets[index];
      if (!previous.dominantName || !current.dominantName) continue;
      if (previous.dominantName === current.dominantName) continue;
      if (
        previous.totalOverlap <= bucketDuration * 0.2 ||
        current.totalOverlap <= bucketDuration * 0.2
      ) {
        continue;
      }

      const previousShare = previous.dominantOverlap / Math.max(previous.totalOverlap, 1);
      const currentShare = current.dominantOverlap / Math.max(current.totalOverlap, 1);
      if (previousShare < 0.4 || currentShare < 0.4) continue;

      const fingerprint = `phase_shift:${firstEvent.processName}:${firstEvent.threadName}:${previous.dominantName}->${current.dominantName}`;
      anomalies.push({
        id: createAnomalyId("phase_shift", `${fingerprint}:${index}`),
        fingerprint,
        kind: "phase_shift",
        title: `Phase shift from ${previous.dominantName} to ${current.dominantName}`,
        summary: `The dominant work on ${firstEvent.threadName} switches sharply from ${previous.dominantName} to ${current.dominantName}.`,
        explanation: `This usually marks a handoff, barrier, or pipeline transition on a single execution lane, which is more actionable than a whole-trace hotspot shuffle.`,
        weirdness: clampWeirdness((previousShare + currentShare) * 38),
        confidence: clampConfidence(0.46 + (previousShare + currentShare) * 0.25),
        reasonCodes: ["dominant_hotspot_shift", "bucket_composition_change"],
        startTime: previous.bucketStart,
        endTime: current.bucketEnd,
        duration: Math.max(current.bucketEnd - previous.bucketStart, 0),
        processName: firstEvent.processName,
        threadName: firstEvent.threadName,
        sampleEventId: current.sampleEventId ?? previous.sampleEventId,
        eventIds: uniqueStrings(
          [previous.sampleEventId, current.sampleEventId].filter(
            (value): value is string => Boolean(value)
          )
        ),
        relatedCounters: [],
        stats: {
          previousShare,
          currentShare,
          previousDominantOverlap: previous.dominantOverlap,
          currentDominantOverlap: current.dominantOverlap,
        },
      });
    }
  }

  const deduped = new Map<string, TraceAnomaly>();
  for (const anomaly of anomalies) {
    const existing = deduped.get(anomaly.fingerprint);
    if (!existing || anomaly.weirdness > existing.weirdness) {
      deduped.set(anomaly.fingerprint, anomaly);
    }
  }

  return [...deduped.values()];
}

function buildSerializationAnomalies(spanEventsByThread: Map<string, IndexedTraceEvent[]>): TraceAnomaly[] {
  const processMap = new Map<
    string,
    {
      processName: string;
      threads: Array<{
        threadName: string;
        intervals: Interval[];
        coverage: number;
        eventIds: string[];
      }>;
    }
  >();

  for (const threadEvents of spanEventsByThread.values()) {
    if (threadEvents.length === 0) continue;
    const firstEvent = threadEvents[0];
    const key = `${firstEvent.pid}`;
    const intervals = mergeIntervals(
      threadEvents.map((event) => ({
        start: event.ts,
        end: event.endTime,
      }))
    );
    const processEntry = processMap.get(key) ?? {
      processName: firstEvent.processName,
      threads: [],
    };

    processEntry.threads.push({
      threadName: firstEvent.threadName,
      intervals,
      coverage: sumIntervals(intervals),
      eventIds: threadEvents.map((event) => event.id).slice(0, 6),
    });
    processMap.set(key, processEntry);
  }

  const anomalies: TraceAnomaly[] = [];

  for (const processEntry of processMap.values()) {
    const heavyThreads = processEntry.threads
      .filter((thread) => thread.coverage > 0)
      .sort((left, right) => right.coverage - left.coverage);
    if (heavyThreads.length < 2) continue;

    const threshold = heavyThreads[0].coverage * 0.2;
    const materiallyActive = heavyThreads.filter((thread) => thread.coverage >= threshold);
    if (materiallyActive.length < 2) continue;

    const allIntervals: Interval[] = [];
    const eventIds: string[] = [];
    let startTime = Number.POSITIVE_INFINITY;
    let endTime = Number.NEGATIVE_INFINITY;

    for (const thread of materiallyActive) {
      for (const interval of thread.intervals) {
        allIntervals.push(interval);
        startTime = Math.min(startTime, interval.start);
        endTime = Math.max(endTime, interval.end);
      }

      for (const eventId of thread.eventIds) {
        if (eventIds.length >= 10) break;
        eventIds.push(eventId);
      }
    }

    const unionCoverage = sumIntervals(mergeIntervals(allIntervals));
    if (unionCoverage <= 0) continue;

    const sumCoverage = materiallyActive.reduce((sum, thread) => sum + thread.coverage, 0);
    const concurrencyRatio = sumCoverage / unionCoverage;
    if (concurrencyRatio > 1.1) continue;
    const fingerprint = `serialization:${processEntry.processName}`;

    anomalies.push({
      id: createAnomalyId("serialization", fingerprint),
      fingerprint,
      kind: "serialization",
      title: `${processEntry.processName} looks serialized across threads`,
      summary: `${materiallyActive.length} material threads are active, but their overlap ratio is only ${concurrencyRatio.toFixed(2)}x.`,
      explanation: `Sum of per-thread active coverage is ${formatTimeShort(sumCoverage)}, while the union is ${formatTimeShort(unionCoverage)}. That means the threads mostly take turns instead of overlapping.`,
      weirdness: clampWeirdness((1.15 - concurrencyRatio) * 180 + materiallyActive.length * 6),
      confidence: clampConfidence(0.5 + materiallyActive.length / 20),
      reasonCodes: ["low_thread_overlap", "serialization_suspected"],
      startTime,
      endTime,
      duration: Math.max(endTime - startTime, 0),
      processName: processEntry.processName,
      sampleEventId: materiallyActive[0]?.eventIds[0] ?? null,
      eventIds: uniqueStrings(eventIds).slice(0, 10),
      relatedCounters: [],
      stats: {
        materialThreadCount: materiallyActive.length,
        concurrencyRatio,
        sumCoverage,
        unionCoverage,
      },
    });
  }

  return anomalies;
}

function buildCounterCorrelationAnomalies(anomalies: TraceAnomaly[]): TraceAnomaly[] {
  return anomalies
    .flatMap((anomaly) => {
      const signal = anomaly.relatedCounters[0];
      if (!signal) return [];

      const signalMagnitude = Math.abs(signal.deltaRatio ?? 0);
      if (signalMagnitude < 0.25 && Math.abs(signal.deltaFromMedian ?? 0) < 10) {
        return [];
      }

      const fingerprint = `counter_correlation:${signal.name}:${anomaly.fingerprint}`;
      return [
        {
          id: createAnomalyId("counter_correlation", fingerprint),
          fingerprint,
          kind: "counter_correlation" as const,
          title: `Counter shift near ${anomaly.title}`,
          summary: `${signal.name} moves to ${signal.value.toFixed(2)} near the anomaly window, away from its median ${signal.medianValue?.toFixed(2) ?? "n/a"}.`,
          explanation: `The counter excursion lines up with the suspicious region. That gives the agent a concrete correlation to inspect instead of treating the bottleneck as an isolated hotspot.`,
          weirdness: clampWeirdness(anomaly.weirdness * 0.7 + signalMagnitude * 30),
          confidence: clampConfidence(Math.min(anomaly.confidence, 0.82)),
          reasonCodes: ["counter_shift_alignment", "counter_to_span_correlation"],
          startTime: anomaly.startTime,
          endTime: anomaly.endTime,
          duration: anomaly.duration,
          processName: anomaly.processName,
          threadName: anomaly.threadName,
          sampleEventId: signal.sampleEventId,
          eventIds: uniqueStrings([
            anomaly.sampleEventId ?? "",
            signal.sampleEventId ?? "",
            ...anomaly.eventIds,
          ]).slice(0, 8),
          callPath: anomaly.callPath,
          relatedCounters: [signal],
          stats: {
            sourceAnomaly: anomaly.kind,
            deltaFromMedian: signal.deltaFromMedian,
            deltaRatio: signal.deltaRatio,
          },
        },
      ];
    })
    .slice(0, 8);
}

function annotateCounters(
  anomalies: TraceAnomaly[],
  counterGroups: CounterGroup[]
): TraceAnomaly[] {
  return anomalies.map((anomaly) => ({
    ...anomaly,
    relatedCounters: findRelatedCounters(counterGroups, anomaly.startTime, anomaly.endTime),
  }));
}

function sortAnomalies(anomalies: TraceAnomaly[]): TraceAnomaly[] {
  return anomalies.slice().sort((left, right) => {
    if (right.weirdness !== left.weirdness) {
      return right.weirdness - left.weirdness;
    }
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return left.startTime - right.startTime;
  });
}

export function buildTraceAnomalies(traceIndex: TraceIndex): TraceAnomaly[] {
  const spanEvents = traceIndex.events
    .filter((event) => event.kind === "span")
    .sort((left, right) => left.ts - right.ts);
  if (spanEvents.length === 0) return [];

  const spanEventsByThread = new Map<string, IndexedTraceEvent[]>();
  for (const [key, threadEvents] of traceIndex.eventsByThread) {
    const spans = threadEvents.filter((event) => event.kind === "span");
    if (spans.length > 0) {
      spanEventsByThread.set(key, spans);
    }
  }

  const baseAnomalies = [
    ...buildDurationOutlierAnomalies(traceIndex, spanEvents),
    ...buildThreadImbalanceAnomalies(traceIndex, spanEvents),
    ...buildGapClusterAnomalies(spanEventsByThread),
    ...buildRarePathAnomalies(traceIndex),
    ...buildMicroFragmentationAnomalies(traceIndex.eventsByThread),
    ...buildPhaseShiftAnomalies(spanEventsByThread),
    ...buildSerializationAnomalies(spanEventsByThread),
  ];

  const counterGroups = buildCounterGroups(traceIndex.events);
  const annotatedBaseAnomalies = annotateCounters(baseAnomalies, counterGroups);
  const counterCorrelationAnomalies = buildCounterCorrelationAnomalies(annotatedBaseAnomalies);
  const allAnomalies = [...annotatedBaseAnomalies, ...counterCorrelationAnomalies];
  const deduped = new Map<string, TraceAnomaly>();

  for (const anomaly of sortAnomalies(allAnomalies)) {
    const existing = deduped.get(anomaly.id);
    if (!existing || anomaly.weirdness > existing.weirdness) {
      deduped.set(anomaly.id, anomaly);
    }
  }

  return sortAnomalies([...deduped.values()]).slice(0, MAX_BASE_ANOMALIES);
}

export function summarizeAnomalyKinds(anomalies: TraceAnomaly[]): TraceAnomalyKindSummary[] {
  const grouped = new Map<
    TraceAnomaly["kind"],
    {
      count: number;
      maxWeirdness: number;
      sampleAnomalyId: string | null;
    }
  >();

  for (const anomaly of anomalies) {
    const entry = grouped.get(anomaly.kind) ?? {
      count: 0,
      maxWeirdness: 0,
      sampleAnomalyId: null,
    };

    entry.count += 1;
    if (anomaly.weirdness > entry.maxWeirdness) {
      entry.maxWeirdness = anomaly.weirdness;
      entry.sampleAnomalyId = anomaly.id;
    }
    grouped.set(anomaly.kind, entry);
  }

  return [...grouped.entries()]
    .map(([kind, entry]) => ({
      kind,
      count: entry.count,
      maxWeirdness: entry.maxWeirdness,
      sampleAnomalyId: entry.sampleAnomalyId,
    }))
    .sort((left, right) => {
      if (right.maxWeirdness !== left.maxWeirdness) {
        return right.maxWeirdness - left.maxWeirdness;
      }
      return right.count - left.count;
    });
}

export function getVisibleTraceAnomalies(
  anomalies: TraceAnomaly[],
  startTime: number,
  endTime: number,
  limit = MAX_VISIBLE_ANOMALIES
): TraceAnomaly[] {
  return sortAnomalies(
    anomalies.filter((anomaly) =>
      overlaps(anomaly.startTime, Math.max(anomaly.endTime, anomaly.startTime + 1), startTime, endTime)
    )
  ).slice(0, limit);
}

export function compareTraceAnomalies(
  baselineAnomalies: TraceAnomaly[],
  candidateAnomalies: TraceAnomaly[],
  limit: number
): TraceAnomalyComparison[] {
  const baselineByFingerprint = new Map(
    baselineAnomalies.map((anomaly) => [anomaly.fingerprint, anomaly] as const)
  );
  const candidateByFingerprint = new Map(
    candidateAnomalies.map((anomaly) => [anomaly.fingerprint, anomaly] as const)
  );
  const fingerprints = new Set([
    ...baselineByFingerprint.keys(),
    ...candidateByFingerprint.keys(),
  ]);

  const comparisons: TraceAnomalyComparison[] = [];

  for (const fingerprint of fingerprints) {
    const baseline = baselineByFingerprint.get(fingerprint) ?? null;
    const candidate = candidateByFingerprint.get(fingerprint) ?? null;

    let status: TraceAnomalyComparison["status"];
    let weirdnessDelta: number | null = null;
    let confidenceDelta: number | null = null;

    if (!baseline && candidate) {
      status = "new";
    } else if (baseline && !candidate) {
      status = "resolved";
    } else if (baseline && candidate) {
      weirdnessDelta = candidate.weirdness - baseline.weirdness;
      confidenceDelta = candidate.confidence - baseline.confidence;
      if (weirdnessDelta >= 8) {
        status = "regressed";
      } else if (weirdnessDelta <= -8) {
        status = "improved";
      } else {
        status = "changed";
      }
    } else {
      continue;
    }

    const exemplar = candidate ?? baseline!;
    comparisons.push({
      fingerprint,
      kind: exemplar.kind,
      title: exemplar.title,
      status,
      baseline,
      candidate,
      weirdnessDelta,
      confidenceDelta,
    });
  }

  return comparisons
    .sort((left, right) => {
      const leftMagnitude =
        left.status === "new" || left.status === "resolved"
          ? (left.candidate ?? left.baseline)?.weirdness ?? 0
          : Math.abs(left.weirdnessDelta ?? 0);
      const rightMagnitude =
        right.status === "new" || right.status === "resolved"
          ? (right.candidate ?? right.baseline)?.weirdness ?? 0
          : Math.abs(right.weirdnessDelta ?? 0);
      return rightMagnitude - leftMagnitude;
    })
    .slice(0, limit);
}
