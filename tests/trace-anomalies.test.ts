import { describe, expect, it } from "vitest";
import {
  buildProcessMap,
  buildTraceIndex,
  buildTraceSnapshot,
  buildViewportSummary,
  inspectTraceAnomaly,
} from "@/lib/trace-analysis";
import { buildTraceAnomalies, compareTraceAnomalies } from "@/lib/trace-anomalies";
import type { TraceData, TraceEvent } from "@/lib/trace-types";

function buildIndexedTrace(traceData: TraceData) {
  const processMap = buildProcessMap(traceData);
  const baseIndex = buildTraceIndex(traceData, processMap);

  expect(baseIndex).not.toBeNull();

  const anomalies = buildTraceAnomalies(baseIndex!);
  return {
    ...baseIndex!,
    anomalies,
    anomalyById: new Map(anomalies.map((a) => [a.id, a])),
  };
}

function withMetadata(
  pid: number,
  processName: string,
  threads: Array<{ tid: number; name: string }>,
  events: TraceEvent[]
): TraceEvent[] {
  return [
    {
      name: "process_name",
      cat: "__metadata",
      ph: "M",
      ts: 0,
      pid,
      tid: 0,
      args: { name: processName },
    },
    ...threads.map((thread) => ({
      name: "thread_name",
      cat: "__metadata",
      ph: "M" as const,
      ts: 0,
      pid,
      tid: thread.tid,
      args: { name: thread.name },
    })),
    ...events,
  ];
}

function buildOutlierTrace(hasOutlier: boolean): TraceData {
  const durations = hasOutlier ? [1_000, 1_100, 900, 1_050, 9_000] : [1_000, 1_100, 900, 1_050, 1_000];
  const counterValues = hasOutlier ? [10, 11, 10, 10, 40] : [10, 11, 10, 10, 10];

  return {
    traceEvents: withMetadata(
      1,
      "GPU Worker",
      [{ tid: 1, name: "main" }],
      durations.flatMap((duration, index) => {
        const start = 1_000 + index * 3_000;
        return [
          {
            name: "kernel",
            cat: "compute",
            ph: "X",
            ts: start,
            dur: duration,
            pid: 1,
            tid: 1,
          },
          {
            name: "memory_mb",
            cat: "metrics",
            ph: "C",
            ts: start + 200,
            pid: 1,
            tid: 1,
            args: { used: counterValues[index] },
          },
        ];
      })
    ),
  };
}

function buildWeirdBehaviorTrace(): TraceData {
  return {
    traceEvents: [
      ...withMetadata(
        2,
        "Imbalance Worker",
        [
          { tid: 1, name: "main" },
          { tid: 2, name: "worker-a" },
          { tid: 3, name: "worker-b" },
        ],
        [
          { name: "decode", cat: "model", ph: "X", ts: 0, dur: 10_000, pid: 2, tid: 1 },
          { name: "decode", cat: "model", ph: "X", ts: 12_000, dur: 10_000, pid: 2, tid: 1 },
          { name: "decode", cat: "model", ph: "X", ts: 24_000, dur: 10_000, pid: 2, tid: 1 },
          { name: "prefetch", cat: "runtime", ph: "X", ts: 500, dur: 1_000, pid: 2, tid: 2 },
          { name: "prefetch", cat: "runtime", ph: "X", ts: 2_500, dur: 1_000, pid: 2, tid: 3 },
        ]
      ),
      ...withMetadata(
        3,
        "Gap Worker",
        [{ tid: 1, name: "queue" }],
        [
          { name: "produce", cat: "runtime", ph: "X", ts: 0, dur: 1_000, pid: 3, tid: 1 },
          { name: "consume", cat: "runtime", ph: "X", ts: 3_000, dur: 1_200, pid: 3, tid: 1 },
          { name: "produce", cat: "runtime", ph: "X", ts: 4_000, dur: 1_000, pid: 3, tid: 1 },
          { name: "consume", cat: "runtime", ph: "X", ts: 7_000, dur: 1_200, pid: 3, tid: 1 },
        ]
      ),
      ...withMetadata(
        4,
        "Serialized Worker",
        [
          { tid: 1, name: "stream-1" },
          { tid: 2, name: "stream-2" },
        ],
        [
          { name: "matmul", cat: "compute", ph: "X", ts: 0, dur: 10_000, pid: 4, tid: 1 },
          { name: "matmul", cat: "compute", ph: "X", ts: 10_000, dur: 10_000, pid: 4, tid: 2 },
        ]
      ),
      ...withMetadata(
        5,
        "Burst Worker",
        [{ tid: 1, name: "control" }],
        [
          { name: "steady", cat: "runtime", ph: "X", ts: 0, dur: 20_000, pid: 5, tid: 1 },
          { name: "launch", cat: "runtime", ph: "i", ts: 1_000, pid: 5, tid: 1 },
          { name: "callback", cat: "runtime", ph: "i", ts: 1_400, pid: 5, tid: 1 },
          { name: "launch", cat: "runtime", ph: "i", ts: 1_800, pid: 5, tid: 1 },
          { name: "callback", cat: "runtime", ph: "i", ts: 2_200, pid: 5, tid: 1 },
          { name: "launch", cat: "runtime", ph: "i", ts: 2_600, pid: 5, tid: 1 },
          { name: "callback", cat: "runtime", ph: "i", ts: 3_000, pid: 5, tid: 1 },
          { name: "launch", cat: "runtime", ph: "i", ts: 3_400, pid: 5, tid: 1 },
          { name: "callback", cat: "runtime", ph: "i", ts: 3_800, pid: 5, tid: 1 },
        ]
      ),
      ...withMetadata(
        6,
        "Phase Worker",
        [{ tid: 1, name: "main" }],
        [
          { name: "prefill", cat: "model", ph: "X", ts: 0, dur: 1_200, pid: 6, tid: 1 },
          { name: "prefill", cat: "model", ph: "X", ts: 1_500, dur: 1_200, pid: 6, tid: 1 },
          { name: "prefill", cat: "model", ph: "X", ts: 3_000, dur: 1_200, pid: 6, tid: 1 },
          { name: "decode", cat: "model", ph: "X", ts: 4_500, dur: 1_200, pid: 6, tid: 1 },
          { name: "decode", cat: "model", ph: "X", ts: 6_000, dur: 1_200, pid: 6, tid: 1 },
          { name: "decode", cat: "model", ph: "X", ts: 7_500, dur: 1_200, pid: 6, tid: 1 },
        ]
      ),
    ],
  };
}

describe("trace anomalies", () => {
  it("detects duration outliers, counter correlations, and anomaly inspection context", () => {
    const traceData = buildOutlierTrace(true);
    const index = buildIndexedTrace(traceData);
    const snapshot = buildTraceSnapshot(traceData, index, {
      label: "candidate",
      loadedAt: "2026-04-09T00:00:00.000Z",
    });

    const anomalyKinds = snapshot.topAnomalies.map((anomaly) => anomaly.kind);
    expect(anomalyKinds).toContain("duration_outlier");
    expect(anomalyKinds).toContain("counter_correlation");
    expect(snapshot.anomalyKindSummary.some((entry) => entry.kind === "duration_outlier")).toBe(true);

    const durationOutlier = index.anomalies.find((anomaly) => anomaly.kind === "duration_outlier");
    expect(durationOutlier).toBeTruthy();
    expect(durationOutlier?.relatedCounters[0]?.name).toBe("memory_mb");

    const inspection = inspectTraceAnomaly(index, durationOutlier!.id);
    expect(inspection?.sampleEvent?.name).toBe("kernel");
    expect(inspection?.relatedEvents.some((event) => event.name === "kernel")).toBe(true);
    expect(inspection?.anomaly.relatedCounters[0]?.deltaRatio).not.toBeNull();

    const view = buildViewportSummary(index, {
      viewState: {
        startTime: 12_000,
        endTime: 23_500,
        scale: 1,
      },
      selectedEventId: null,
      searchQuery: "",
    });

    expect(view.visibleAnomalies.some((anomaly) => anomaly.kind === "duration_outlier")).toBe(true);
    expect(view.visibleAnomalies.some((anomaly) => anomaly.kind === "counter_correlation")).toBe(true);
  });

  it("detects thread imbalance, repeated gaps, serialization, micro fragmentation, and phase shifts", () => {
    const traceData = buildWeirdBehaviorTrace();
    const index = buildIndexedTrace(traceData);
    const kinds = new Set(index.anomalies.map((anomaly) => anomaly.kind));

    expect(kinds.has("thread_imbalance")).toBe(true);
    expect(kinds.has("gap_cluster")).toBe(true);
    expect(kinds.has("serialization")).toBe(true);
    expect(kinds.has("micro_fragmentation")).toBe(true);
    expect(kinds.has("phase_shift")).toBe(true);
  });

  it("compares anomaly fingerprints between traces", () => {
    const baselineIndex = buildIndexedTrace(buildOutlierTrace(false));
    const candidateIndex = buildIndexedTrace(buildOutlierTrace(true));

    const comparisons = compareTraceAnomalies(
      baselineIndex.anomalies,
      candidateIndex.anomalies,
      10
    );

    expect(
      comparisons.some(
        (comparison) =>
          comparison.kind === "duration_outlier" && comparison.status === "new"
      )
    ).toBe(true);
    expect(
      comparisons.some(
        (comparison) =>
          comparison.kind === "counter_correlation" && comparison.status === "new"
      )
    ).toBe(true);
  });
});
