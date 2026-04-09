import {
  getTraceEventKind,
  isSpikeEvent,
  type Process,
  type TraceData,
  type TraceEvent,
  type TraceEventKind,
  type ViewState,
} from "@/lib/trace-types";
import {
  buildTraceAnomalies,
  getVisibleTraceAnomalies,
  summarizeAnomalyKinds,
} from "@/lib/trace-anomalies";
import type {
  BuildViewportSummaryOptions,
  EventInspection,
  IndexedTraceEvent,
  TraceAnomalyInspection,
  TraceCallPathSummary,
  TraceChatContext,
  TraceDiffSummary,
  TraceEventReference,
  TraceHotspotSummary,
  TraceIndex,
  TraceKindCounts,
  TraceMetricDelta,
  TraceProcessSummary,
  TraceSnapshot,
  TraceSpanNode,
  TraceThreadSummary,
  VisibleBucketSummary,
  ViewportSummary,
} from "@/lib/trace-chat";

interface RawThreadEvent {
  event: TraceEvent;
  index: number;
}

interface MutableSpanNode {
  id: string;
  event: IndexedTraceEvent;
  parentId: string | null;
  childIds: string[];
  depth: number;
  selfTime: number;
  callPath: string[];
}

interface HotspotMetricEntry {
  event: IndexedTraceEvent;
  value: number;
}

function compareTraceEvents(left: Pick<TraceEvent, "ts" | "dur" | "ph" | "__lupa">, right: Pick<TraceEvent, "ts" | "dur" | "ph" | "__lupa">): number {
  if (left.ts !== right.ts) return left.ts - right.ts;
  if ((right.dur ?? 0) !== (left.dur ?? 0)) return (right.dur ?? 0) - (left.dur ?? 0);

  const leftKind = getTraceEventKind(left);
  const rightKind = getTraceEventKind(right);
  const priority: Record<TraceEventKind, number> = {
    span: 0,
    spike: 1,
    counter: 2,
    flow: 3,
    marker: 4,
  };

  if (priority[leftKind] !== priority[rightKind]) {
    return priority[leftKind] - priority[rightKind];
  }

  return left.ph.localeCompare(right.ph);
}

function threadKey(pid: number, tid: number): string {
  return `${pid}:${tid}`;
}

function buildNormalizedId(prefix: string, ...parts: Array<string | number>): string {
  return `${prefix}_${parts.join("_")}`;
}

function mergeArgs(
  left: Record<string, unknown> | undefined,
  right: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!left && !right) return undefined;
  return {
    ...(left ?? {}),
    ...(right ?? {}),
  };
}

function createNormalizedEvent(
  event: TraceEvent,
  id: string,
  kind: TraceEventKind,
  sourcePhases: TraceEvent["ph"][]
): TraceEvent {
  return {
    ...event,
    __lupa: {
      id,
      kind,
      sourcePhases,
    },
  };
}

function normalizeRawThreadEvents(events: RawThreadEvent[]): TraceEvent[] {
  const normalized: TraceEvent[] = [];
  const sorted = events.slice().sort((left, right) => {
    if (left.event.ts !== right.event.ts) return left.event.ts - right.event.ts;

    const phasePriority = (phase: TraceEvent["ph"]) => {
      switch (phase) {
        case "B":
          return 0;
        case "X":
          return 1;
        case "i":
        case "I":
        case "R":
          return 2;
        case "C":
          return 3;
        case "s":
        case "t":
        case "f":
          return 4;
        case "E":
          return 5;
        default:
          return 6;
      }
    };

    if (phasePriority(left.event.ph) !== phasePriority(right.event.ph)) {
      return phasePriority(left.event.ph) - phasePriority(right.event.ph);
    }

    return left.index - right.index;
  });

  const stack: RawThreadEvent[] = [];

  for (const item of sorted) {
    const { event, index } = item;

    if (event.ph === "B") {
      stack.push(item);
      continue;
    }

    if (event.ph === "E") {
      const begin = stack.pop();
      if (!begin) {
        normalized.push(
          createNormalizedEvent(
            {
              ...event,
              dur: 0,
            },
            buildNormalizedId("evt", "raw", index),
            "marker",
            [event.ph]
          )
        );
        continue;
      }

      normalized.push(
        createNormalizedEvent(
          {
            ...begin.event,
            ph: "X",
            cat: begin.event.cat || event.cat,
            args: mergeArgs(begin.event.args, event.args),
            cname: begin.event.cname ?? event.cname,
            dur: Math.max(event.ts - begin.event.ts, 0),
          },
          buildNormalizedId("evt", "pair", begin.index, index),
          Math.max(event.ts - begin.event.ts, 0) < 1000 ? "spike" : "span",
          [begin.event.ph, event.ph]
        )
      );
      continue;
    }

    normalized.push(
      createNormalizedEvent(
        {
          ...event,
          dur: event.dur ?? 0,
        },
        buildNormalizedId("evt", "raw", index),
        getTraceEventKind(event),
        [event.ph]
      )
    );
  }

  for (const dangling of stack) {
    normalized.push(
      createNormalizedEvent(
        {
          ...dangling.event,
          dur: 0,
        },
        buildNormalizedId("evt", "raw", dangling.index),
        "marker",
        [dangling.event.ph]
      )
    );
  }

  return normalized;
}

export function normalizeTraceEvents(traceData: TraceData | null): TraceEvent[] {
  if (!traceData) return [];

  const eventsByThread = new Map<string, RawThreadEvent[]>();

  traceData.traceEvents.forEach((event, index) => {
    if (event.ph === "M") return;
    const key = threadKey(event.pid, event.tid);
    const existing = eventsByThread.get(key);
    if (existing) {
      existing.push({
        event,
        index,
      });
      return;
    }

    eventsByThread.set(key, [
      {
        event,
        index,
      },
    ]);
  });

  const normalized = [...eventsByThread.values()].flatMap(normalizeRawThreadEvents);
  normalized.sort(compareTraceEvents);
  return normalized;
}

export function buildProcessMap(traceData: TraceData | null): Map<number, Process> {
  if (!traceData) return new Map<number, Process>();

  const processMap = new Map<number, Process>();

  for (const event of traceData.traceEvents) {
    if (event.ph !== "M") continue;

    if (event.name === "process_name") {
      if (!processMap.has(event.pid)) {
        processMap.set(event.pid, {
          pid: event.pid,
          name: String(event.args?.name || `Process ${event.pid}`),
          threads: new Map(),
        });
      } else {
        const process = processMap.get(event.pid)!;
        process.name = String(event.args?.name || process.name);
      }
      continue;
    }

    if (event.name === "thread_name") {
      if (!processMap.has(event.pid)) {
        processMap.set(event.pid, {
          pid: event.pid,
          name: `Process ${event.pid}`,
          threads: new Map(),
        });
      }

      const process = processMap.get(event.pid)!;
      if (!process.threads.has(event.tid)) {
        process.threads.set(event.tid, {
          pid: event.pid,
          tid: event.tid,
          name: String(event.args?.name || `Thread ${event.tid}`),
          events: [],
        });
      } else {
        const thread = process.threads.get(event.tid)!;
        thread.name = String(event.args?.name || thread.name);
      }
    }
  }

  for (const event of normalizeTraceEvents(traceData)) {
    if (!processMap.has(event.pid)) {
      processMap.set(event.pid, {
        pid: event.pid,
        name: `Process ${event.pid}`,
        threads: new Map(),
      });
    }

    const process = processMap.get(event.pid)!;
    if (!process.threads.has(event.tid)) {
      process.threads.set(event.tid, {
        pid: event.pid,
        tid: event.tid,
        name: `Thread ${event.tid}`,
        events: [],
      });
    }

    process.threads.get(event.tid)!.events.push(event);
  }

  for (const process of processMap.values()) {
    for (const [tid, thread] of process.threads) {
      if (thread.events.length === 0) {
        process.threads.delete(tid);
        continue;
      }

      thread.events.sort(compareTraceEvents);
    }
  }

  for (const [pid, process] of processMap) {
    if (process.threads.size === 0) {
      processMap.delete(pid);
    }
  }

  return processMap;
}

function getIndexedEventKind(event: IndexedTraceEvent): TraceEventKind {
  return event.kind;
}

function getIndexedEventThreadKey(event: IndexedTraceEvent): string {
  return threadKey(event.pid, event.tid);
}

function buildSpanNodeIndex(
  eventsByThread: Map<string, IndexedTraceEvent[]>
): Map<string, TraceSpanNode> {
  const spanNodeById = new Map<string, TraceSpanNode>();

  for (const threadEvents of eventsByThread.values()) {
    const spanEvents = threadEvents
      .filter((event) => getIndexedEventKind(event) === "span")
      .slice()
      .sort((left, right) => {
        if (left.ts !== right.ts) return left.ts - right.ts;
        return right.dur - left.dur;
      });

    const mutableNodes = new Map<string, MutableSpanNode>();
    const roots: MutableSpanNode[] = [];
    const stack: MutableSpanNode[] = [];

    for (const event of spanEvents) {
      while (stack.length > 0 && event.ts >= stack[stack.length - 1].event.endTime) {
        stack.pop();
      }

      while (
        stack.length > 0 &&
        event.endTime > stack[stack.length - 1].event.endTime
      ) {
        stack.pop();
      }

      const parent = stack[stack.length - 1] ?? null;
      const node: MutableSpanNode = {
        id: event.id,
        event,
        parentId: parent?.id ?? null,
        childIds: [],
        depth: parent ? parent.depth + 1 : 0,
        selfTime: event.dur,
        callPath: parent ? [...parent.callPath, event.name] : [event.name],
      };

      if (parent) {
        parent.childIds.push(node.id);
      } else {
        roots.push(node);
      }

      mutableNodes.set(node.id, node);
      stack.push(node);
    }

    const computeSelfTime = (node: MutableSpanNode) => {
      if (node.childIds.length === 0) {
        node.selfTime = node.event.dur;
        return;
      }

      for (const childId of node.childIds) {
        const child = mutableNodes.get(childId);
        if (child) {
          computeSelfTime(child);
        }
      }

      const mergedIntervals = node.childIds
        .map((childId) => mutableNodes.get(childId))
        .filter((child): child is MutableSpanNode => Boolean(child))
        .map((child) => ({
          start: child.event.ts,
          end: Math.min(node.event.endTime, child.event.endTime),
        }))
        .sort((left, right) => left.start - right.start);

      if (mergedIntervals.length === 0) {
        node.selfTime = node.event.dur;
        return;
      }

      let covered = 0;
      let currentStart = mergedIntervals[0].start;
      let currentEnd = mergedIntervals[0].end;

      for (let index = 1; index < mergedIntervals.length; index += 1) {
        const interval = mergedIntervals[index];
        if (interval.start <= currentEnd) {
          currentEnd = Math.max(currentEnd, interval.end);
        } else {
          covered += currentEnd - currentStart;
          currentStart = interval.start;
          currentEnd = interval.end;
        }
      }

      covered += currentEnd - currentStart;
      node.selfTime = Math.max(0, node.event.dur - covered);
    };

    for (const root of roots) {
      computeSelfTime(root);
    }

    for (const node of mutableNodes.values()) {
      spanNodeById.set(node.id, {
        id: node.id,
        parentId: node.parentId,
        childIds: node.childIds,
        depth: node.depth,
        selfTime: node.selfTime,
        callPath: node.callPath,
      });
    }
  }

  return spanNodeById;
}

function toReference(
  event: IndexedTraceEvent,
  traceIndex?: TraceIndex
): TraceEventReference {
  const spanNode = traceIndex?.spanNodeById.get(event.id);

  return {
    id: event.id,
    name: event.name,
    cat: event.cat,
    ph: event.ph,
    ts: event.ts,
    dur: event.dur,
    endTime: event.endTime,
    pid: event.pid,
    tid: event.tid,
    processName: event.processName,
    threadName: event.threadName,
    kind: event.kind,
    sourcePhases: event.sourcePhases,
    selfTime: spanNode?.selfTime,
    depth: spanNode?.depth,
    callPath: spanNode?.callPath,
    cname: event.cname,
    args: event.args,
  };
}

export function buildTraceIndex(
  traceData: TraceData | null,
  processes: Map<number, Process>
): TraceIndex | null {
  if (!traceData) return null;

  const events: IndexedTraceEvent[] = [];
  const eventById = new Map<string, IndexedTraceEvent>();
  const idByEvent = new WeakMap<TraceEvent, string>();

  for (const process of processes.values()) {
    for (const thread of process.threads.values()) {
      for (const event of thread.events) {
        const id = event.__lupa?.id ?? buildNormalizedId("evt", "generated", events.length);
        const indexedEvent: IndexedTraceEvent = {
          id,
          event,
          name: event.name,
          cat: event.cat,
          ph: event.ph,
          ts: event.ts,
          dur: event.dur ?? 0,
          endTime: event.ts + (event.dur ?? 0),
          pid: event.pid,
          tid: event.tid,
          processName: process.name,
          threadName: thread.name,
          kind: getTraceEventKind(event),
          sourcePhases: event.__lupa?.sourcePhases ?? [event.ph],
          args: event.args,
          cname: event.cname,
        };

        events.push(indexedEvent);
        eventById.set(id, indexedEvent);
        idByEvent.set(event, id);
      }
    }
  }

  events.sort((left, right) => {
    if (left.ts !== right.ts) return left.ts - right.ts;
    if (right.dur !== left.dur) return right.dur - left.dur;
    return left.id.localeCompare(right.id);
  });

  const eventsByThread = new Map<string, IndexedTraceEvent[]>();
  for (const event of events) {
    const key = getIndexedEventThreadKey(event);
    const existing = eventsByThread.get(key);
    if (existing) {
      existing.push(event);
    } else {
      eventsByThread.set(key, [event]);
    }
  }

  for (const threadEvents of eventsByThread.values()) {
    threadEvents.sort((left, right) => {
      if (left.ts !== right.ts) return left.ts - right.ts;
      if (right.dur !== left.dur) return right.dur - left.dur;
      return left.id.localeCompare(right.id);
    });
  }

  const baseIndex: TraceIndex = {
    events,
    eventById,
    idByEvent,
    eventsByThread,
    spanNodeById: buildSpanNodeIndex(eventsByThread),
    anomalies: [],
    anomalyById: new Map(),
  };
  const anomalies = buildTraceAnomalies(baseIndex);
  const anomalyById = new Map(anomalies.map((anomaly) => [anomaly.id, anomaly]));

  return {
    ...baseIndex,
    anomalies,
    anomalyById,
  };
}

function aggregateHotspots(entries: HotspotMetricEntry[]): TraceHotspotSummary[] {
  const hotspotMap = new Map<
    string,
    {
      totalDuration: number;
      occurrences: number;
      maxDuration: number;
      sampleEventId: string | null;
      categories: Set<string>;
      processes: Set<string>;
      threads: Set<string>;
    }
  >();

  for (const { event, value } of entries) {
    if (value <= 0) continue;

    const entry = hotspotMap.get(event.name) ?? {
      totalDuration: 0,
      occurrences: 0,
      maxDuration: 0,
      sampleEventId: null,
      categories: new Set<string>(),
      processes: new Set<string>(),
      threads: new Set<string>(),
    };

    entry.totalDuration += value;
    entry.occurrences += 1;
    entry.maxDuration = Math.max(entry.maxDuration, value);
    entry.sampleEventId ??= event.id;

    if (event.cat) {
      for (const category of event.cat.split(",")) {
        const trimmed = category.trim();
        if (trimmed) entry.categories.add(trimmed);
      }
    }

    entry.processes.add(event.processName);
    entry.threads.add(event.threadName);
    hotspotMap.set(event.name, entry);
  }

  return [...hotspotMap.entries()]
    .map(([name, value]) => ({
      name,
      totalDuration: value.totalDuration,
      occurrences: value.occurrences,
      averageDuration: value.totalDuration / Math.max(value.occurrences, 1),
      maxDuration: value.maxDuration,
      sampleEventId: value.sampleEventId,
      categories: [...value.categories].sort(),
      processes: [...value.processes].sort(),
      threads: [...value.threads].sort(),
    }))
    .sort((left, right) => {
      if (right.totalDuration !== left.totalDuration) {
        return right.totalDuration - left.totalDuration;
      }
      return right.occurrences - left.occurrences;
    });
}

function aggregateProcesses(events: IndexedTraceEvent[]): TraceProcessSummary[] {
  const processMap = new Map<
    number,
    {
      name: string;
      eventCount: number;
      totalDuration: number;
      threads: Map<number, { name: string; eventCount: number; totalDuration: number }>;
    }
  >();

  for (const event of events) {
    const process = processMap.get(event.pid) ?? {
      name: event.processName,
      eventCount: 0,
      totalDuration: 0,
      threads: new Map(),
    };

    process.eventCount += 1;
    process.totalDuration += Math.max(event.dur, 0);

    const thread = process.threads.get(event.tid) ?? {
      name: event.threadName,
      eventCount: 0,
      totalDuration: 0,
    };

    thread.eventCount += 1;
    thread.totalDuration += Math.max(event.dur, 0);
    process.threads.set(event.tid, thread);
    processMap.set(event.pid, process);
  }

  return [...processMap.entries()]
    .map(([pid, value]) => ({
      pid,
      name: value.name,
      threadCount: value.threads.size,
      eventCount: value.eventCount,
      totalDuration: value.totalDuration,
      topThreads: [...value.threads.entries()]
        .map(([tid, thread]) => ({
          tid,
          name: thread.name,
          eventCount: thread.eventCount,
          totalDuration: thread.totalDuration,
        }))
        .sort((left, right) => {
          if (right.totalDuration !== left.totalDuration) {
            return right.totalDuration - left.totalDuration;
          }
          return right.eventCount - left.eventCount;
        })
        .slice(0, 5),
    }))
    .sort((left, right) => {
      if (right.totalDuration !== left.totalDuration) {
        return right.totalDuration - left.totalDuration;
      }
      return right.eventCount - left.eventCount;
    });
}

function aggregateThreads(
  traceIndex: TraceIndex,
  events: IndexedTraceEvent[]
): TraceThreadSummary[] {
  const threadMap = new Map<
    string,
    TraceThreadSummary
  >();

  for (const event of events) {
    const key = getIndexedEventThreadKey(event);
    const spanNode = traceIndex.spanNodeById.get(event.id);
    const entry = threadMap.get(key) ?? {
      key,
      pid: event.pid,
      tid: event.tid,
      processName: event.processName,
      threadName: event.threadName,
      spanCount: 0,
      totalDuration: 0,
      totalSelfTime: 0,
      sampleEventId: null,
    };

    entry.spanCount += 1;
    entry.totalDuration += Math.max(event.dur, 0);
    entry.totalSelfTime += spanNode?.selfTime ?? 0;
    entry.sampleEventId ??= event.id;
    threadMap.set(key, entry);
  }

  return [...threadMap.values()].sort((left, right) => {
    if (right.totalSelfTime !== left.totalSelfTime) {
      return right.totalSelfTime - left.totalSelfTime;
    }
    return right.totalDuration - left.totalDuration;
  });
}

function aggregateCallPaths(
  traceIndex: TraceIndex,
  entries: HotspotMetricEntry[]
): TraceCallPathSummary[] {
  const pathMap = new Map<
    string,
    {
      totalSelfTime: number;
      occurrences: number;
      sampleEventId: string | null;
    }
  >();

  for (const { event, value } of entries) {
    if (value <= 0) continue;
    const spanNode = traceIndex.spanNodeById.get(event.id);
    const callPath = spanNode?.callPath.join(" -> ");
    if (!callPath) continue;

    const entry = pathMap.get(callPath) ?? {
      totalSelfTime: 0,
      occurrences: 0,
      sampleEventId: null,
    };

    entry.totalSelfTime += value;
    entry.occurrences += 1;
    entry.sampleEventId ??= event.id;
    pathMap.set(callPath, entry);
  }

  return [...pathMap.entries()]
    .map(([callPath, value]) => ({
      callPath,
      totalSelfTime: value.totalSelfTime,
      occurrences: value.occurrences,
      sampleEventId: value.sampleEventId,
    }))
    .sort((left, right) => {
      if (right.totalSelfTime !== left.totalSelfTime) {
        return right.totalSelfTime - left.totalSelfTime;
      }
      return right.occurrences - left.occurrences;
    });
}

function countCategories(events: IndexedTraceEvent[]) {
  const counts = new Map<string, number>();

  for (const event of events) {
    if (!event.cat) continue;
    for (const rawCategory of event.cat.split(",")) {
      const category = rawCategory.trim();
      if (!category) continue;
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function countKinds(events: IndexedTraceEvent[]): TraceKindCounts {
  const counts: TraceKindCounts = {
    span: 0,
    spike: 0,
    counter: 0,
    flow: 0,
    marker: 0,
  };

  for (const event of events) {
    counts[event.kind] += 1;
  }

  return counts;
}

function overlapsRange(
  event: IndexedTraceEvent,
  startTime: number,
  endTime: number
): boolean {
  if (event.dur <= 0) {
    return event.ts >= startTime && event.ts <= endTime;
  }

  return event.endTime >= startTime && event.ts <= endTime;
}

function overlapDuration(
  event: IndexedTraceEvent,
  startTime: number,
  endTime: number
): number {
  if (event.dur <= 0) {
    return event.ts >= startTime && event.ts <= endTime ? 1 : 0;
  }

  return Math.max(0, Math.min(event.endTime, endTime) - Math.max(event.ts, startTime));
}

function buildVisibleBuckets(
  events: IndexedTraceEvent[],
  startTime: number,
  endTime: number
): VisibleBucketSummary[] {
  const bucketCount = 12;
  const duration = Math.max(endTime - startTime, 1);
  const buckets: VisibleBucketSummary[] = [];

  for (let index = 0; index < bucketCount; index += 1) {
    const bucketStart = startTime + (duration / bucketCount) * index;
    const bucketEnd =
      index === bucketCount - 1
        ? endTime
        : startTime + (duration / bucketCount) * (index + 1);

    const hotspotDurations = new Map<string, number>();
    let eventCount = 0;
    let totalOverlap = 0;

    for (const event of events) {
      const overlap = overlapDuration(event, bucketStart, bucketEnd);
      if (overlap <= 0) continue;
      eventCount += 1;
      totalOverlap += overlap;
      hotspotDurations.set(event.name, (hotspotDurations.get(event.name) ?? 0) + overlap);
    }

    let dominantHotspot: string | null = null;
    let dominantDuration = -1;

    for (const [name, value] of hotspotDurations) {
      if (value > dominantDuration) {
        dominantHotspot = name;
        dominantDuration = value;
      }
    }

    buckets.push({
      startTime: bucketStart,
      endTime: bucketEnd,
      eventCount,
      dominantHotspot,
      overlapDuration: totalOverlap,
    });
  }

  return buckets;
}

function getSearchableText(
  event: IndexedTraceEvent,
  traceIndex: TraceIndex
): string {
  const spanNode = traceIndex.spanNodeById.get(event.id);
  return [
    event.name,
    event.cat,
    event.processName,
    event.threadName,
    event.kind,
    spanNode?.callPath.join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getSpanEvents(events: IndexedTraceEvent[]): IndexedTraceEvent[] {
  return events.filter((event) => event.kind === "span");
}

function getSpikeEvents(events: IndexedTraceEvent[]): IndexedTraceEvent[] {
  return events.filter((event) => event.kind === "spike");
}

function getNonMarkerEvents(events: IndexedTraceEvent[]): IndexedTraceEvent[] {
  return events.filter((event) => event.kind !== "marker");
}

function getBounds(events: IndexedTraceEvent[]): { startTime: number; endTime: number; duration: number } {
  const source = events.length > 0 ? events : [];
  const startTime = source[0]?.ts ?? 0;
  const endTime = source.reduce(
    (max, event) => Math.max(max, event.endTime, event.ts),
    startTime
  );

  return {
    startTime,
    endTime,
    duration: Math.max(endTime - startTime, 0),
  };
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }

  return deduped;
}

export function buildTraceSnapshot(
  traceData: TraceData,
  traceIndex: TraceIndex,
  options: {
    label?: string;
    filename?: string;
    loadedAt?: string;
  } = {}
): TraceSnapshot {
  const events = traceIndex.events;
  const nonMarkerEvents = getNonMarkerEvents(events);
  const spanEvents = getSpanEvents(events);
  const topCategories = countCategories(nonMarkerEvents);
  const loadedAt = options.loadedAt ?? new Date().toISOString();
  const label = options.label ?? options.filename ?? "Untitled trace";
  const boundsSource = spanEvents.length > 0 ? spanEvents : nonMarkerEvents;
  const spanEntries = spanEvents.map((event) => ({
    event,
    value: Math.max(event.dur, 0),
  }));
  const selfTimeEntries = spanEvents.map((event) => ({
    event,
    value: traceIndex.spanNodeById.get(event.id)?.selfTime ?? 0,
  }));

  return {
    id: `${loadedAt}:${label}`,
    label,
    filename: options.filename,
    loadedAt,
    eventCount: nonMarkerEvents.length,
    processCount: new Set(nonMarkerEvents.map((event) => event.pid)).size,
    threadCount: new Set(nonMarkerEvents.map((event) => getIndexedEventThreadKey(event))).size,
    countsByKind: countKinds(events),
    bounds: getBounds(boundsSource),
    metadata: traceData.metadata ?? null,
    categories: topCategories.map((category) => category.name),
    topCategories: topCategories.slice(0, 12),
    topHotspots: aggregateHotspots(spanEntries).slice(0, 12),
    topSelfTimeHotspots: aggregateHotspots(selfTimeEntries).slice(0, 12),
    topCallPaths: aggregateCallPaths(traceIndex, selfTimeEntries).slice(0, 10),
    topAnomalies: traceIndex.anomalies.slice(0, 8),
    anomalyKindSummary: summarizeAnomalyKinds(traceIndex.anomalies).slice(0, 8),
    topThreads: aggregateThreads(traceIndex, spanEvents).slice(0, 8),
    topProcesses: aggregateProcesses(spanEvents).slice(0, 8),
  };
}

function buildWeightedSpanEntries(
  traceIndex: TraceIndex,
  events: IndexedTraceEvent[],
  startTime: number,
  endTime: number
): {
  durationEntries: HotspotMetricEntry[];
  selfTimeEntries: HotspotMetricEntry[];
} {
  const durationEntries: HotspotMetricEntry[] = [];
  const selfTimeEntries: HotspotMetricEntry[] = [];

  for (const event of events) {
    const overlap = overlapDuration(event, startTime, endTime);
    if (overlap <= 0) continue;

    durationEntries.push({
      event,
      value: overlap,
    });

    const selfTime = traceIndex.spanNodeById.get(event.id)?.selfTime ?? 0;
    const overlapRatio = event.dur > 0 ? Math.min(1, overlap / event.dur) : 0;
    selfTimeEntries.push({
      event,
      value: selfTime * overlapRatio,
    });
  }

  return {
    durationEntries,
    selfTimeEntries,
  };
}

export function buildViewportSummary(
  traceIndex: TraceIndex,
  options: BuildViewportSummaryOptions
): ViewportSummary {
  const { viewState, selectedEventId, searchQuery } = options;
  const startTime = viewState.startTime;
  const endTime = viewState.endTime;
  const visibleEvents = traceIndex.events.filter((event) =>
    overlapsRange(event, startTime, endTime)
  );
  const visibleNonMarkerEvents = getNonMarkerEvents(visibleEvents);
  const visibleSpanEvents = getSpanEvents(visibleEvents);
  const visibleSpikeEvents = getSpikeEvents(visibleEvents);
  const lowerQuery = searchQuery.trim().toLowerCase();
  const searchMatches = lowerQuery
    ? visibleNonMarkerEvents.filter((event) =>
        getSearchableText(event, traceIndex).includes(lowerQuery)
      )
    : [];

  const weightedSpans = buildWeightedSpanEntries(
    traceIndex,
    visibleSpanEvents,
    startTime,
    endTime
  );
  const weightedSpikeEntries: HotspotMetricEntry[] = visibleSpikeEvents.map((event) => ({
    event,
    value: Math.max(overlapDuration(event, startTime, endTime), 1),
  }));
  const longestVisibleEvents = [...(visibleSpanEvents.length > 0 ? visibleSpanEvents : visibleNonMarkerEvents)]
    .sort((left, right) => {
      if (right.dur !== left.dur) return right.dur - left.dur;
      return left.ts - right.ts;
    })
    .slice(0, 12)
    .map((event) => toReference(event, traceIndex));
  const selectedEvent = selectedEventId
    ? traceIndex.eventById.get(selectedEventId) ?? null
    : null;

  return {
    startTime,
    endTime,
    duration: Math.max(endTime - startTime, 0),
    visibleEventCount: visibleNonMarkerEvents.length,
    visibleSpanCount: visibleSpanEvents.length,
    visibleSpikeCount: visibleSpikeEvents.length,
    visibleCounterCount: visibleEvents.filter((event) => event.kind === "counter").length,
    visibleFlowCount: visibleEvents.filter((event) => event.kind === "flow").length,
    visibleMarkerCount: visibleEvents.filter((event) => event.kind === "marker").length,
    selectedEvent: selectedEvent ? toReference(selectedEvent, traceIndex) : null,
    topVisibleHotspots: aggregateHotspots(weightedSpans.durationEntries).slice(0, 10),
    topVisibleSelfTimeHotspots: aggregateHotspots(weightedSpans.selfTimeEntries).slice(0, 10),
    topVisibleCallPaths: aggregateCallPaths(traceIndex, weightedSpans.selfTimeEntries).slice(0, 8),
    topVisibleSpikeHotspots: aggregateHotspots(weightedSpikeEntries).slice(0, 10),
    visibleAnomalies: getVisibleTraceAnomalies(traceIndex.anomalies, startTime, endTime),
    longestVisibleEvents,
    sampleVisibleSpikeEvents: visibleSpikeEvents
      .slice()
      .sort((left, right) => left.ts - right.ts)
      .slice(0, 12)
      .map((event) => toReference(event, traceIndex)),
    visibleThreads: aggregateThreads(traceIndex, visibleSpanEvents).slice(0, 6),
    visibleProcesses: aggregateProcesses(visibleSpanEvents).slice(0, 6),
    searchQuery,
    searchMatchCount: searchMatches.length,
    searchMatches: searchMatches.slice(0, 8).map((event) => toReference(event, traceIndex)),
    timeBuckets: buildVisibleBuckets(visibleSpanEvents, startTime, endTime),
  };
}

export function searchTraceEvents(
  traceIndex: TraceIndex,
  query: string,
  limit: number,
  viewState: ViewState | null
): TraceEventReference[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const matches = getNonMarkerEvents(traceIndex.events)
    .map((event) => {
      const searchable = getSearchableText(event, traceIndex);
      if (!searchable.includes(normalizedQuery)) return null;

      let score = 0;
      if (event.name.toLowerCase() === normalizedQuery) score += 12;
      if (event.name.toLowerCase().includes(normalizedQuery)) score += 6;
      if (event.processName.toLowerCase().includes(normalizedQuery)) score += 2;
      if (event.threadName.toLowerCase().includes(normalizedQuery)) score += 2;
      if (event.kind === "span") score += 2;
      if (viewState && overlapsRange(event, viewState.startTime, viewState.endTime)) {
        score += 3;
      }

      return {
        event,
        score,
      };
    })
    .filter((entry): entry is { event: IndexedTraceEvent; score: number } => Boolean(entry))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.event.dur !== left.event.dur) return right.event.dur - left.event.dur;
      return left.event.ts - right.event.ts;
    })
    .slice(0, limit);

  return matches.map(({ event }) => toReference(event, traceIndex));
}

function countDescendants(traceIndex: TraceIndex, eventId: string): number {
  const node = traceIndex.spanNodeById.get(eventId);
  if (!node) return 0;

  let total = 0;
  for (const childId of node.childIds) {
    total += 1 + countDescendants(traceIndex, childId);
  }

  return total;
}

export function inspectTraceEvent(
  traceIndex: TraceIndex,
  eventId: string
): EventInspection | null {
  const event = traceIndex.eventById.get(eventId);
  if (!event) return null;

  const threadEvents = traceIndex.eventsByThread.get(getIndexedEventThreadKey(event)) ?? [];
  const targetIndex = threadEvents.findIndex((candidate) => candidate.id === eventId);
  const previousInThread = threadEvents
    .slice(Math.max(0, targetIndex - 3), targetIndex)
    .map((candidate) => toReference(candidate, traceIndex));
  const nextInThread = threadEvents
    .slice(targetIndex + 1, targetIndex + 4)
    .map((candidate) => toReference(candidate, traceIndex));
  const overlappingInThread = threadEvents
    .filter(
      (candidate) =>
        candidate.id !== event.id &&
        overlapsRange(candidate, event.ts, Math.max(event.endTime, event.ts + 1))
    )
    .slice(0, 8)
    .map((candidate) => toReference(candidate, traceIndex));

  const spanNode = traceIndex.spanNodeById.get(event.id);
  const parentChain: TraceEventReference[] = [];
  let cursor = spanNode?.parentId ?? null;

  while (cursor) {
    const parentEvent = traceIndex.eventById.get(cursor);
    if (!parentEvent) break;
    parentChain.unshift(toReference(parentEvent, traceIndex));
    cursor = traceIndex.spanNodeById.get(cursor)?.parentId ?? null;
  }

  const directChildren = (spanNode?.childIds ?? [])
    .map((childId) => traceIndex.eventById.get(childId))
    .filter((child): child is IndexedTraceEvent => Boolean(child))
    .map((child) => toReference(child, traceIndex));

  const childHotspots = aggregateHotspots(
    (spanNode?.childIds ?? [])
      .map((childId) => traceIndex.eventById.get(childId))
      .filter((child): child is IndexedTraceEvent => Boolean(child))
      .map((child) => ({
        event: child,
        value: Math.max(child.dur, 0),
      }))
  ).slice(0, 8);

  return {
    event: toReference(event, traceIndex),
    parentChain,
    directChildren,
    childHotspots,
    threadCallPath: spanNode?.callPath ?? [event.name],
    selfTime: spanNode?.selfTime ?? null,
    descendantCount: countDescendants(traceIndex, event.id),
    previousInThread,
    nextInThread,
    overlappingInThread,
  };
}

export function inspectTraceAnomaly(
  traceIndex: TraceIndex,
  anomalyId: string
): TraceAnomalyInspection | null {
  const anomaly = traceIndex.anomalyById.get(anomalyId);
  if (!anomaly) return null;

  const sampleEvent = anomaly.sampleEventId
    ? traceIndex.eventById.get(anomaly.sampleEventId) ?? null
    : null;
  const relatedEvents = uniqueById(
    anomaly.eventIds
      .map((eventId) => traceIndex.eventById.get(eventId))
      .filter((event): event is IndexedTraceEvent => Boolean(event))
      .map((event) => toReference(event, traceIndex))
  ).slice(0, 8);

  const nearbyEvents = traceIndex.events
    .filter(
      (event) =>
        event.kind !== "marker" &&
        anomaly.sampleEventId !== event.id &&
        overlapsRange(
          event,
          anomaly.startTime,
          Math.max(anomaly.endTime, anomaly.startTime + 1)
        )
    )
    .sort((left, right) => {
      if (right.dur !== left.dur) return right.dur - left.dur;
      return left.ts - right.ts;
    })
    .slice(0, 8)
    .map((event) => toReference(event, traceIndex));

  return {
    anomaly,
    sampleEvent: sampleEvent ? toReference(sampleEvent, traceIndex) : null,
    relatedEvents,
    nearbyEvents,
  };
}

function buildMetricDelta(name: string, previous: number, current: number): TraceMetricDelta {
  const delta = current - previous;
  const deltaPercent = previous === 0 ? null : (delta / previous) * 100;

  return {
    name,
    previous,
    current,
    delta,
    deltaPercent,
  };
}

function buildChangeList(
  previousValues: Array<{ name: string; totalDuration?: number; count?: number }>,
  currentValues: Array<{ name: string; totalDuration?: number; count?: number }>,
  limit: number
): TraceMetricDelta[] {
  const previousMap = new Map<string, number>();
  const currentMap = new Map<string, number>();

  for (const value of previousValues) {
    previousMap.set(value.name, value.totalDuration ?? value.count ?? 0);
  }

  for (const value of currentValues) {
    currentMap.set(value.name, value.totalDuration ?? value.count ?? 0);
  }

  const names = new Set([...previousMap.keys(), ...currentMap.keys()]);

  return [...names]
    .map((name) =>
      buildMetricDelta(name, previousMap.get(name) ?? 0, currentMap.get(name) ?? 0)
    )
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
    .slice(0, limit);
}

export function buildTraceDiffSummary(
  previousTrace: TraceSnapshot | null,
  currentTrace: TraceSnapshot | null
): TraceDiffSummary | null {
  if (!currentTrace) return null;

  if (!previousTrace) {
    return {
      available: false,
      previousLabel: null,
      currentLabel: currentTrace.label,
      eventCountDelta: buildMetricDelta("event_count", 0, currentTrace.eventCount),
      durationDelta: buildMetricDelta("duration", 0, currentTrace.bounds.duration),
      processCountDelta: buildMetricDelta("process_count", 0, currentTrace.processCount),
      threadCountDelta: buildMetricDelta("thread_count", 0, currentTrace.threadCount),
      hotspotChanges: [],
      processChanges: [],
      categoryChanges: [],
    };
  }

  return {
    available: true,
    previousLabel: previousTrace.label,
    currentLabel: currentTrace.label,
    eventCountDelta: buildMetricDelta(
      "event_count",
      previousTrace.eventCount,
      currentTrace.eventCount
    ),
    durationDelta: buildMetricDelta(
      "duration",
      previousTrace.bounds.duration,
      currentTrace.bounds.duration
    ),
    processCountDelta: buildMetricDelta(
      "process_count",
      previousTrace.processCount,
      currentTrace.processCount
    ),
    threadCountDelta: buildMetricDelta(
      "thread_count",
      previousTrace.threadCount,
      currentTrace.threadCount
    ),
    hotspotChanges: buildChangeList(
      previousTrace.topHotspots,
      currentTrace.topHotspots,
      10
    ),
    processChanges: buildChangeList(
      previousTrace.topProcesses,
      currentTrace.topProcesses,
      8
    ),
    categoryChanges: buildChangeList(
      previousTrace.topCategories,
      currentTrace.topCategories,
      8
    ),
  };
}

export function buildTraceChatContext(
  traceData: TraceData | null,
  traceIndex: TraceIndex | null,
  previousTrace: TraceSnapshot | null,
  viewState: ViewState,
  selectedEvent: TraceEvent | null,
  searchQuery: string,
  filename?: string
): TraceChatContext {
  if (!traceData || !traceIndex) {
    return {
      currentTrace: null,
      previousTrace,
      currentView: null,
      comparisonToPrevious: null,
    };
  }

  const selectedEventId = selectedEvent
    ? traceIndex.idByEvent.get(selectedEvent) ?? null
    : null;
  const currentTrace = buildTraceSnapshot(traceData, traceIndex, {
    label: filename ?? "Current trace",
    filename,
  });
  const currentView = buildViewportSummary(traceIndex, {
    viewState,
    selectedEventId,
    searchQuery,
  });
  const comparisonToPrevious = buildTraceDiffSummary(previousTrace, currentTrace);

  return {
    currentTrace,
    previousTrace,
    currentView,
    comparisonToPrevious,
  };
}
