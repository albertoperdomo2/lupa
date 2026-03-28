import { describe, expect, it } from "vitest";
import {
  buildProcessMap,
  buildTraceIndex,
  buildTraceSnapshot,
} from "@/lib/trace-analysis";
import type { TraceData } from "@/lib/trace-types";

function buildFixtureTrace(): TraceData {
  return {
    traceEvents: [
      {
        name: "process_name",
        cat: "__metadata",
        ph: "M",
        ts: 0,
        pid: 7,
        tid: 0,
        args: { name: "Worker" },
      },
      {
        name: "thread_name",
        cat: "__metadata",
        ph: "M",
        ts: 0,
        pid: 7,
        tid: 9,
        args: { name: "main" },
      },
      {
        name: "thread_name",
        cat: "__metadata",
        ph: "M",
        ts: 0,
        pid: 7,
        tid: 10,
        args: { name: "empty-thread" },
      },
      {
        name: "forward",
        cat: "model",
        ph: "X",
        ts: 100,
        dur: 900,
        pid: 7,
        tid: 9,
      },
      {
        name: "launch",
        cat: "runtime",
        ph: "i",
        ts: 1300,
        pid: 7,
        tid: 9,
      },
    ],
  };
}

describe("trace analysis", () => {
  it("drops metadata-only threads from the process map", () => {
    const processMap = buildProcessMap(buildFixtureTrace());
    const process = processMap.get(7);

    expect(process?.threads.size).toBe(1);
    expect(process?.threads.has(9)).toBe(true);
    expect(process?.threads.has(10)).toBe(false);
  });

  it("builds a stable snapshot from indexed events", () => {
    const traceData = buildFixtureTrace();
    const processMap = buildProcessMap(traceData);
    const traceIndex = buildTraceIndex(traceData, processMap);

    expect(traceIndex).not.toBeNull();

    const snapshot = buildTraceSnapshot(traceData, traceIndex!, {
      label: "fixture",
      loadedAt: "2026-03-28T00:00:00.000Z",
    });

    expect(snapshot.id).toBe("2026-03-28T00:00:00.000Z:fixture");
    expect(snapshot.eventCount).toBe(2);
    expect(snapshot.processCount).toBe(1);
    expect(snapshot.threadCount).toBe(1);
    expect(snapshot.bounds.startTime).toBe(100);
    expect(snapshot.bounds.endTime).toBe(1300);
    expect(snapshot.topHotspots.map((entry) => entry.name)).toEqual(["forward", "launch"]);
  });
});
