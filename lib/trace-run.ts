import type { TraceData, TraceEvent } from "@/lib/trace-types";

export interface TraceRunSourceSummary {
  id: string;
  label: string;
  filename?: string;
  eventCount: number;
  processCount: number;
  bounds: {
    startTime: number;
    endTime: number;
    duration: number;
  };
}

export interface TraceRunInput {
  traceData: TraceData;
  filename?: string;
}

export interface CombinedTraceRun {
  traceData: TraceData;
  sources: TraceRunSourceSummary[];
  displayName: string;
}

export interface TraceRunBuilder {
  nextPid: number;
  combinedEvents: TraceEvent[];
  sources: TraceRunSourceSummary[];
  metadata?: TraceData["metadata"];
}

function createSourceId(index: number, label: string): string {
  return `source_${index}_${label.replace(/[^a-zA-Z0-9_-]+/g, "_")}`;
}

function stripTraceExtension(filename: string): string {
  return filename.replace(/\.json(\.gz)?$/i, "");
}

export function createRunDisplayName(
  sourceLabels: string[],
  fallbackLabel: string
): string {
  if (sourceLabels.length === 0) return fallbackLabel;
  if (sourceLabels.length === 1) return sourceLabels[0];
  return `${sourceLabels[0]} + ${sourceLabels.length - 1} more`;
}

export function createTraceRunBuilder(): TraceRunBuilder {
  return {
    nextPid: 1,
    combinedEvents: [],
    sources: [],
    metadata: undefined,
  };
}

function getTraceBounds(traceData: TraceData): {
  startTime: number;
  endTime: number;
  duration: number;
} {
  const nonMetadataEvents = traceData.traceEvents.filter((event) => event.ph !== "M");
  if (nonMetadataEvents.length === 0) {
    return {
      startTime: 0,
      endTime: 0,
      duration: 0,
    };
  }

  const startTime = nonMetadataEvents.reduce(
    (min, event) => Math.min(min, event.ts),
    nonMetadataEvents[0].ts
  );
  const endTime = nonMetadataEvents.reduce(
    (max, event) => Math.max(max, event.ts + (event.dur ?? 0)),
    startTime
  );

  return {
    startTime,
    endTime,
    duration: Math.max(endTime - startTime, 0),
  };
}

function cloneEventWithPid(
  event: TraceEvent,
  pidMap: Map<number, number>,
  timeShift: number,
  sourceLabel: string
): TraceEvent {
  const nextPid = pidMap.get(event.pid) ?? event.pid;
  const baseEvent: TraceEvent = {
    ...event,
    pid: nextPid,
    ts: event.ph === "M" ? 0 : event.ts + timeShift,
  };

  if (event.ph === "M" && event.name === "process_name") {
    return {
      ...baseEvent,
      args: {
        ...(event.args ?? {}),
        name: `[${sourceLabel}] ${String(event.args?.name || `Process ${event.pid}`)}`,
      },
    };
  }

  return baseEvent;
}

export function combineTraceRunSources(
  inputs: TraceRunInput[],
  fallbackLabel: string
): CombinedTraceRun | null {
  const builder = createTraceRunBuilder();
  for (const [index, input] of inputs.entries()) {
    appendTraceRunSource(builder, input, index);
  }

  return finalizeTraceRunBuilder(builder, fallbackLabel);
}

export function appendTraceRunSource(
  builder: TraceRunBuilder,
  input: TraceRunInput,
  sourceIndex = builder.sources.length
): void {
  const label = input.filename ? stripTraceExtension(input.filename) : `trace-${sourceIndex + 1}`;
  const sourceBounds = getTraceBounds(input.traceData);
  const timeShift = -sourceBounds.startTime;
  const pidMap = new Map<number, number>();
  let eventCount = 0;

  for (const event of input.traceData.traceEvents) {
    if (!pidMap.has(event.pid)) {
      pidMap.set(event.pid, builder.nextPid);
      builder.nextPid += 1;
    }

    if (event.ph !== "M") {
      eventCount += 1;
    }
  }

  const processNameMetadata = new Set<number>();
  for (const event of input.traceData.traceEvents) {
    const remappedEvent = cloneEventWithPid(event, pidMap, timeShift, label);
    builder.combinedEvents.push(remappedEvent);

    if (remappedEvent.ph === "M" && remappedEvent.name === "process_name") {
      processNameMetadata.add(remappedEvent.pid);
    }
  }

  for (const [originalPid, remappedPid] of pidMap) {
    if (processNameMetadata.has(remappedPid)) continue;

    builder.combinedEvents.push({
      name: "process_name",
      cat: "__metadata",
      ph: "M",
      ts: 0,
      pid: remappedPid,
      tid: 0,
      args: {
        name: `[${label}] Process ${originalPid}`,
      },
    });
  }

  builder.sources.push({
    id: createSourceId(sourceIndex, label),
    label,
    filename: input.filename,
    eventCount,
    processCount: pidMap.size,
    bounds: {
      startTime: 0,
      endTime: sourceBounds.duration,
      duration: sourceBounds.duration,
    },
  });

  if (!builder.metadata && input.traceData.metadata) {
    builder.metadata = input.traceData.metadata;
  }
}

export function finalizeTraceRunBuilder(
  builder: TraceRunBuilder,
  fallbackLabel: string
): CombinedTraceRun | null {
  if (builder.sources.length === 0) return null;

  return {
    traceData: {
      traceEvents: builder.combinedEvents,
      metadata: builder.metadata,
    },
    sources: builder.sources,
    displayName: createRunDisplayName(
      builder.sources.map((source) => source.label),
      fallbackLabel
    ),
  };
}
