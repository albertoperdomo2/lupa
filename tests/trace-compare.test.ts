import { describe, expect, it } from "vitest";
import {
  buildTraceCompareReportExport,
  buildTraceNormalizationConfig,
} from "@/lib/trace-compare";
import type {
  TraceCompareFinding,
  TraceCompareMetadata,
  TraceCompareReport,
} from "@/lib/trace-chat";

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
