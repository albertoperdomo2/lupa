import { describe, expect, it } from "vitest";
import { buildProcessMap, buildTraceIndex, buildTraceSnapshot } from "@/lib/trace-analysis";
import { combineTraceRunSources } from "@/lib/trace-run";
import type { TraceData } from "@/lib/trace-types";

function buildTrace(
  pid: number,
  processName: string,
  threadName: string,
  startTime: number,
  duration: number
): TraceData {
  return {
    traceEvents: [
      {
        name: "process_name",
        cat: "__metadata",
        ph: "M",
        ts: 0,
        pid,
        tid: 0,
        args: { name: processName },
      },
      {
        name: "thread_name",
        cat: "__metadata",
        ph: "M",
        ts: 0,
        pid,
        tid: 1,
        args: { name: threadName },
      },
      {
        name: "forward",
        cat: "model",
        ph: "X",
        ts: startTime,
        dur: duration,
        pid,
        tid: 1,
      },
    ],
  };
}

describe("combineTraceRunSources", () => {
  it("combines multiple trace files into one run with remapped pids and normalized starts", () => {
    const combined = combineTraceRunSources(
      [
        {
          filename: "pod-a.json",
          traceData: buildTrace(7, "Worker", "main", 1_000, 4_000),
        },
        {
          filename: "pod-b.json",
          traceData: buildTrace(7, "Worker", "main", 9_500, 6_000),
        },
      ],
      "Current run"
    );

    expect(combined).not.toBeNull();
    expect(combined!.sources).toHaveLength(2);
    expect(combined!.displayName).toBe("pod-a + 1 more");

    const processNames = combined!.traceData.traceEvents
      .filter((event) => event.ph === "M" && event.name === "process_name")
      .map((event) => String(event.args?.name));
    expect(processNames).toContain("[pod-a] Worker");
    expect(processNames).toContain("[pod-b] Worker");

    const forwardEvents = combined!.traceData.traceEvents.filter((event) => event.name === "forward");
    expect(new Set(forwardEvents.map((event) => event.pid)).size).toBe(2);
    expect(forwardEvents.map((event) => event.ts)).toEqual([0, 0]);

    const processMap = buildProcessMap(combined!.traceData);
    const traceIndex = buildTraceIndex(combined!.traceData, processMap);

    expect(traceIndex).not.toBeNull();

    const snapshot = buildTraceSnapshot(combined!.traceData, traceIndex!, {
      label: combined!.displayName,
      filename: combined!.displayName,
      loadedAt: "2026-04-09T00:00:00.000Z",
      sources: combined!.sources,
    });

    expect(snapshot.sourceCount).toBe(2);
    expect(snapshot.sources.map((source) => source.label)).toEqual(["pod-a", "pod-b"]);
    expect(snapshot.bounds.duration).toBe(6_000);
  });

  it("combines large event arrays without relying on spread-based appends", () => {
    const largeTrace: TraceData = {
      traceEvents: [
        {
          name: "process_name",
          cat: "__metadata",
          ph: "M",
          ts: 0,
          pid: 1,
          tid: 0,
          args: { name: "Worker" },
        },
        {
          name: "thread_name",
          cat: "__metadata",
          ph: "M",
          ts: 0,
          pid: 1,
          tid: 1,
          args: { name: "main" },
        },
        ...Array.from({ length: 150_000 }, (_, index) => ({
          name: "kernel",
          cat: "model",
          ph: "X" as const,
          ts: index * 10,
          dur: 5,
          pid: 1,
          tid: 1,
        })),
      ],
    };

    const combined = combineTraceRunSources(
      [
        {
          filename: "large.json",
          traceData: largeTrace,
        },
      ],
      "Current run"
    );

    expect(combined).not.toBeNull();
    expect(
      combined!.traceData.traceEvents.filter((event) => event.name === "kernel").length
    ).toBe(150_000);
  });
});
