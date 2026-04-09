import { describe, expect, it } from "vitest";
import {
  buildTraceCompareReport,
  buildTraceCompareReportExport,
  buildTraceNormalizationConfig,
} from "@/lib/trace-compare";
import type {
  TraceCompareFinding,
  TraceCompareMetadata,
  TraceCompareReport,
} from "@/lib/trace-chat";
import { buildProcessMap, buildTraceIndex, buildTraceSnapshot } from "@/lib/trace-analysis";
import type { TraceData } from "@/lib/trace-types";

const baseline: TraceCompareMetadata = {
  traceId: "baseline",
  label: "baseline",
  workloadKind: "unknown",
};

const candidate: TraceCompareMetadata = {
  traceId: "candidate",
  label: "candidate",
  workloadKind: "unknown",
};

function buildFinding(): TraceCompareFinding {
  return {
    id: "finding:1",
    kind: "summary",
    title: "Candidate spends less time in compute_logits",
    summary: "The candidate reduces inclusive time in the top logits span.",
    explanation: "Most of the saved time comes from a shorter logits path on the worker thread.",
    impact: "improved",
    priority: 10,
    metric: {
      name: "duration",
      label: "Duration",
      unit: "us",
      baseline: { raw: 1000, normalized: 1000 },
      candidate: { raw: 800, normalized: 800 },
      delta: -200,
      deltaPercent: -20,
      normalizedDelta: -200,
      normalizedDeltaPercent: -20,
    },
    labels: ["logits"],
    evidence: [
      {
        id: "region:1",
        traceRole: "baseline",
        traceLabel: "baseline",
        title: "compute_logits",
        description: "baseline evidence",
        startTime: 100,
        endTime: 300,
        eventIds: ["evt_1"],
      },
    ],
  };
}

describe("buildTraceNormalizationConfig", () => {
  it("falls back to totals when requested normalization metadata is missing", () => {
    const { normalization, caveats } = buildTraceNormalizationConfig(
      baseline,
      candidate,
      "per_request"
    );

    expect(normalization.mode).toBe("per_request");
    expect(normalization.label).toBe("total trace");
    expect(caveats).toHaveLength(1);
  });
});

describe("buildTraceCompareReportExport", () => {
  it("renders a markdown report with findings", () => {
    const report: TraceCompareReport = {
      id: "report:1",
      createdAt: "2026-03-28T00:00:00.000Z",
      available: true,
      normalization: {
        mode: "total",
        label: "total trace",
        baselineDenominator: 1,
        candidateDenominator: 1,
      },
      baseline,
      candidate,
      winner: "candidate",
      headline: "Candidate is faster overall.",
      summaryMetrics: [],
      findings: [buildFinding()],
      hotspotFindings: [],
      spikeFindings: [],
      callPathFindings: [],
      loopFindings: [],
      representativeRegions: [],
      topChangedLoops: [],
      caveats: [],
    };

    const markdown = buildTraceCompareReportExport(report);

    expect(markdown).toContain("# Deep Findings Report");
    expect(markdown).toContain("Candidate spends less time in compute_logits");
    expect(markdown).toContain("Candidate is faster overall.");
  });
});

describe("buildTraceCompareReport", () => {
  it("builds unique finding ids for long loop signatures", () => {
    const sharedPrefix = "Call CompiledFxGraph fdqwahzw7w5uwj4xx5fob2cu6k4geft3vibwkgzovpirrvbanhdu ";
    const loopA = `${sharedPrefix}${"a".repeat(140)} tail-one`;
    const loopB = `${sharedPrefix}${"a".repeat(140)} tail-two`;

    const buildTrace = (loopName: string, traceId: string): {
      role: "baseline" | "candidate";
      snapshot: ReturnType<typeof buildTraceSnapshot>;
      index: NonNullable<ReturnType<typeof buildTraceIndex>>;
      metadata: TraceCompareMetadata;
    } => {
      const traceData: TraceData = {
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
          {
            name: loopName,
            cat: "runtime",
            ph: "X",
            ts: 0,
            dur: 3000,
            pid: 1,
            tid: 1,
          },
          {
            name: `${traceId}-middle`,
            cat: "runtime",
            ph: "X",
            ts: 3100,
            dur: 2000,
            pid: 1,
            tid: 1,
          },
          {
            name: `${traceId}-tail`,
            cat: "runtime",
            ph: "X",
            ts: 5200,
            dur: 1800,
            pid: 1,
            tid: 1,
          },
        ],
      };

      const processMap = buildProcessMap(traceData);
      const index = buildTraceIndex(traceData, processMap)!;
      const snapshot = buildTraceSnapshot(traceData, index, {
        label: traceId,
        loadedAt: "2026-04-09T00:00:00.000Z",
      });

      return {
        role: traceId === "baseline" ? "baseline" : "candidate",
        snapshot,
        index,
        metadata: {
          traceId,
          label: traceId,
          workloadKind: "unknown",
        },
      };
    };

    const report = buildTraceCompareReport({
      baselineTrace: buildTrace(loopA, "baseline"),
      candidateTrace: buildTrace(loopB, "candidate"),
      normalizationMode: "total",
    });

    expect(report).not.toBeNull();

    const loopIds = report!.loopFindings.map((finding) => finding.id);
    expect(new Set(loopIds).size).toBe(loopIds.length);
  });
});
