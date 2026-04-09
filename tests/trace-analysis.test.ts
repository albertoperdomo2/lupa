import { describe, expect, it } from "vitest";
import {
  buildProcessMap,
  buildTraceIndex,
  buildTraceSnapshot,
  buildViewportSummary,
  inspectTraceEvent,
  normalizeTraceEvents,
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
        dur: 1900,
        pid: 7,
        tid: 9,
      },
      {
        name: "launch",
        cat: "runtime",
        ph: "i",
        ts: 2300,
        pid: 7,
        tid: 9,
      },
    ],
  };
}

function buildBeginEndFixture(): TraceData {
  return {
    traceEvents: [
      {
        name: "process_name",
        cat: "__metadata",
        ph: "M",
        ts: 0,
        pid: 11,
        tid: 0,
        args: { name: "Worker" },
      },
      {
        name: "thread_name",
        cat: "__metadata",
        ph: "M",
        ts: 0,
        pid: 11,
        tid: 7,
        args: { name: "main" },
      },
      {
        name: "outer",
        cat: "runtime",
        ph: "B",
        ts: 100,
        pid: 11,
        tid: 7,
        args: { stage: "outer" },
      },
      {
        name: "inner",
        cat: "runtime",
        ph: "X",
        ts: 300,
        dur: 1200,
        pid: 11,
        tid: 7,
        args: { stage: "inner" },
      },
      {
        name: "outer",
        cat: "runtime",
        ph: "E",
        ts: 4100,
        pid: 11,
        tid: 7,
      },
      {
        name: "memory",
        cat: "metrics",
        ph: "C",
        ts: 500,
        pid: 11,
        tid: 7,
        args: { used_mb: 42 },
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
    expect(snapshot.countsByKind).toEqual({
      span: 1,
      spike: 1,
      counter: 0,
      flow: 0,
      marker: 0,
    });
    expect(snapshot.bounds.startTime).toBe(100);
    expect(snapshot.bounds.endTime).toBe(2000);
    expect(snapshot.topHotspots.map((entry) => entry.name)).toEqual(["forward"]);
  });

  it("normalizes begin/end events into complete spans", () => {
    const normalized = normalizeTraceEvents(buildBeginEndFixture());

    expect(
      normalized.map((event) => ({
        name: event.name,
        ph: event.ph,
        dur: event.dur ?? 0,
        kind: event.__lupa?.kind,
      }))
    ).toEqual([
      { name: "outer", ph: "X", dur: 4000, kind: "span" },
      { name: "inner", ph: "X", dur: 1200, kind: "span" },
      { name: "memory", ph: "C", dur: 0, kind: "counter" },
    ]);
  });

  it("builds richer event inspection context from normalized spans", () => {
    const traceData = buildBeginEndFixture();
    const processMap = buildProcessMap(traceData);
    const traceIndex = buildTraceIndex(traceData, processMap);

    expect(traceIndex).not.toBeNull();

    const outerEvent = traceIndex!.events.find((event) => event.name === "outer");
    const innerEvent = traceIndex!.events.find((event) => event.name === "inner");

    expect(outerEvent).toBeTruthy();
    expect(innerEvent).toBeTruthy();

    const outerInspection = inspectTraceEvent(traceIndex!, outerEvent!.id);
    const innerInspection = inspectTraceEvent(traceIndex!, innerEvent!.id);

    expect(outerInspection?.selfTime).toBe(2800);
    expect(outerInspection?.directChildren.map((entry) => entry.name)).toEqual(["inner"]);
    expect(outerInspection?.childHotspots.map((entry) => entry.name)).toEqual(["inner"]);
    expect(outerInspection?.descendantCount).toBe(1);
    expect(innerInspection?.parentChain.map((entry) => entry.name)).toEqual(["outer"]);
    expect(innerInspection?.threadCallPath).toEqual(["outer", "inner"]);
  });

  it("builds viewport summaries with separated span and counter counts", () => {
    const traceData = buildBeginEndFixture();
    const processMap = buildProcessMap(traceData);
    const traceIndex = buildTraceIndex(traceData, processMap);

    expect(traceIndex).not.toBeNull();

    const summary = buildViewportSummary(traceIndex!, {
      viewState: {
        startTime: 0,
        endTime: 600,
        scale: 1,
      },
      selectedEventId: null,
      searchQuery: "",
    });

    expect(summary.visibleEventCount).toBe(3);
    expect(summary.visibleSpanCount).toBe(2);
    expect(summary.visibleCounterCount).toBe(1);
    expect(summary.visibleSpikeCount).toBe(0);
    expect(summary.topVisibleHotspots.map((entry) => entry.name)).toEqual(["outer", "inner"]);
    expect(summary.topVisibleSelfTimeHotspots.map((entry) => entry.name)).toEqual([
      "outer",
      "inner",
    ]);
    expect(summary.topVisibleCallPaths.map((entry) => entry.callPath)).toEqual([
      "outer",
      "outer -> inner",
    ]);
  });
});
