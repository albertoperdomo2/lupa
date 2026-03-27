import {
  isSpikeEvent,
  type Process,
  type TraceData,
  type TraceEvent,
  type ViewState,
} from "@/lib/trace-types";
import type {
  BuildViewportSummaryOptions,
  EventInspection,
  IndexedTraceEvent,
  TraceChatContext,
  TraceDiffSummary,
  TraceEventReference,
  TraceHotspotSummary,
  TraceIndex,
  TraceMetricDelta,
  TraceProcessSummary,
  TraceSnapshot,
  VisibleBucketSummary,
  ViewportSummary,
} from "@/lib/trace-chat";

function toReference(event: IndexedTraceEvent): TraceEventReference {
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

  traceData.traceEvents.forEach((event, index) => {
    if (event.ph === "M") return;

    const process = processes.get(event.pid);
    const thread = process?.threads.get(event.tid);
    const id = `evt_${index}`;
    const dur = event.dur ?? 0;
    const indexedEvent: IndexedTraceEvent = {
      id,
      event,
      name: event.name,
      cat: event.cat,
      ph: event.ph,
      ts: event.ts,
      dur,
      endTime: event.ts + dur,
      pid: event.pid,
      tid: event.tid,
      processName: process?.name ?? `Process ${event.pid}`,
      threadName: thread?.name ?? `Thread ${event.tid}`,
      args: event.args,
      cname: event.cname,
    };

    events.push(indexedEvent);
    eventById.set(id, indexedEvent);
    idByEvent.set(event, id);
  });

  events.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return b.dur - a.dur;
  });

  return {
    events,
    eventById,
    idByEvent,
  };
}

function aggregateHotspots(events: IndexedTraceEvent[]): TraceHotspotSummary[] {
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

  for (const event of events) {
    const entry = hotspotMap.get(event.name) ?? {
      totalDuration: 0,
      occurrences: 0,
      maxDuration: 0,
      sampleEventId: null,
      categories: new Set<string>(),
      processes: new Set<string>(),
      threads: new Set<string>(),
    };

    entry.totalDuration += Math.max(event.dur, 1);
    entry.occurrences += 1;
    entry.maxDuration = Math.max(entry.maxDuration, event.dur);
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
      averageDuration: value.totalDuration / value.occurrences,
      maxDuration: value.maxDuration,
      sampleEventId: value.sampleEventId,
      categories: [...value.categories].sort(),
      processes: [...value.processes].sort(),
      threads: [...value.threads].sort(),
    }))
    .sort((a, b) => {
      if (b.totalDuration !== a.totalDuration) return b.totalDuration - a.totalDuration;
      return b.occurrences - a.occurrences;
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
    process.totalDuration += Math.max(event.dur, 1);

    const thread = process.threads.get(event.tid) ?? {
      name: event.threadName,
      eventCount: 0,
      totalDuration: 0,
    };

    thread.eventCount += 1;
    thread.totalDuration += Math.max(event.dur, 1);
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
        .sort((a, b) => {
          if (b.totalDuration !== a.totalDuration) return b.totalDuration - a.totalDuration;
          return b.eventCount - a.eventCount;
        })
        .slice(0, 5),
    }))
    .sort((a, b) => {
      if (b.totalDuration !== a.totalDuration) return b.totalDuration - a.totalDuration;
      return b.eventCount - a.eventCount;
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
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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
  const startTime = events[0]?.ts ?? 0;
  const endTime = events.reduce((max, event) => Math.max(max, event.endTime), startTime);
  const topCategories = countCategories(events);
  const loadedAt = options.loadedAt ?? new Date().toISOString();
  const label = options.label ?? options.filename ?? "Untitled trace";

  return {
    id: `${loadedAt}:${label}`,
    label,
    filename: options.filename,
    loadedAt,
    eventCount: events.length,
    processCount: new Set(events.map((event) => event.pid)).size,
    threadCount: new Set(events.map((event) => `${event.pid}:${event.tid}`)).size,
    bounds: {
      startTime,
      endTime,
      duration: Math.max(endTime - startTime, 0),
    },
    metadata: traceData.metadata ?? null,
    categories: topCategories.map((category) => category.name),
    topCategories: topCategories.slice(0, 12),
    topHotspots: aggregateHotspots(events).slice(0, 12),
    topProcesses: aggregateProcesses(events).slice(0, 8),
  };
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
  const lowerQuery = searchQuery.trim().toLowerCase();
  const searchMatches = lowerQuery
    ? visibleEvents.filter((event) =>
        [
          event.name,
          event.cat,
          event.processName,
          event.threadName,
        ].some((value) => value.toLowerCase().includes(lowerQuery))
      )
    : [];

  const weightedVisibleEvents = visibleEvents.map((event) => {
    const overlap = overlapDuration(event, startTime, endTime);
    return {
      ...event,
      weightedDuration: Math.max(overlap, 1),
    };
  });

  const weightedHotspots = aggregateHotspots(
    weightedVisibleEvents.map((event) => ({
      ...event,
      dur: event.weightedDuration,
      endTime: event.ts + event.weightedDuration,
    }))
  );
  const visibleSpikeEvents = visibleEvents.filter((event) => isSpikeEvent(event));
  const weightedSpikeHotspots = aggregateHotspots(
    visibleSpikeEvents.map((event) => ({
      ...event,
      dur: Math.max(overlapDuration(event, startTime, endTime), 1),
      endTime: event.ts + Math.max(overlapDuration(event, startTime, endTime), 1),
    }))
  );

  const longestVisibleEvents = [...visibleEvents]
    .sort((a, b) => {
      if (b.dur !== a.dur) return b.dur - a.dur;
      return a.ts - b.ts;
    })
    .slice(0, 12)
    .map(toReference);
  const selectedEvent = selectedEventId
    ? traceIndex.eventById.get(selectedEventId) ?? null
    : null;

  return {
    startTime,
    endTime,
    duration: Math.max(endTime - startTime, 0),
    visibleEventCount: visibleEvents.length,
    visibleSpikeCount: visibleSpikeEvents.length,
    selectedEvent: selectedEvent ? toReference(selectedEvent) : null,
    topVisibleHotspots: weightedHotspots.slice(0, 10),
    topVisibleSpikeHotspots: weightedSpikeHotspots.slice(0, 10),
    longestVisibleEvents,
    sampleVisibleSpikeEvents: visibleSpikeEvents
      .slice()
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 12)
      .map(toReference),
    visibleProcesses: aggregateProcesses(visibleEvents).slice(0, 6),
    searchQuery,
    searchMatchCount: searchMatches.length,
    searchMatches: searchMatches.slice(0, 8).map(toReference),
    timeBuckets: buildVisibleBuckets(visibleEvents, startTime, endTime),
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

  const matches = traceIndex.events
    .map((event) => {
      const searchable = [
        event.name,
        event.cat,
        event.processName,
        event.threadName,
      ].join(" ").toLowerCase();

      if (!searchable.includes(normalizedQuery)) return null;

      let score = 0;
      if (event.name.toLowerCase() === normalizedQuery) score += 10;
      if (event.name.toLowerCase().includes(normalizedQuery)) score += 5;
      if (event.processName.toLowerCase().includes(normalizedQuery)) score += 2;
      if (
        viewState &&
        overlapsRange(event, viewState.startTime, viewState.endTime)
      ) {
        score += 3;
      }

      return {
        event,
        score,
      };
    })
    .filter((entry): entry is { event: IndexedTraceEvent; score: number } => Boolean(entry))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.event.dur !== a.event.dur) return b.event.dur - a.event.dur;
      return a.event.ts - b.event.ts;
    })
    .slice(0, limit);

  return matches.map(({ event }) => toReference(event));
}

export function inspectTraceEvent(
  traceIndex: TraceIndex,
  eventId: string
): EventInspection | null {
  const event = traceIndex.eventById.get(eventId);
  if (!event) return null;

  const threadEvents = traceIndex.events
    .filter((candidate) => candidate.pid === event.pid && candidate.tid === event.tid)
    .sort((a, b) => a.ts - b.ts);
  const targetIndex = threadEvents.findIndex((candidate) => candidate.id === eventId);
  const previousInThread = threadEvents
    .slice(Math.max(0, targetIndex - 3), targetIndex)
    .map(toReference);
  const nextInThread = threadEvents.slice(targetIndex + 1, targetIndex + 4).map(toReference);
  const overlappingInThread = threadEvents
    .filter(
      (candidate) =>
        candidate.id !== event.id &&
        overlapsRange(candidate, event.ts, event.endTime)
    )
    .slice(0, 8)
    .map(toReference);

  return {
    event: toReference(event),
    previousInThread,
    nextInThread,
    overlappingInThread,
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
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
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
      durationDelta: buildMetricDelta(
        "duration",
        0,
        currentTrace.bounds.duration
      ),
      processCountDelta: buildMetricDelta(
        "process_count",
        0,
        currentTrace.processCount
      ),
      threadCountDelta: buildMetricDelta(
        "thread_count",
        0,
        currentTrace.threadCount
      ),
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
