"use client";

import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  Radar,
  Sparkles,
  Target,
} from "lucide-react";
import type {
  TraceCompareFinding,
  TraceCompareMetricDelta,
  TraceCompareReport,
} from "@/lib/trace-chat";
import { formatTimeShort } from "@/lib/trace-types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CompareFindingsPanelProps {
  report: TraceCompareReport | null;
  onFocusFinding: (findingId: string) => void;
}

function formatMetric(metric: TraceCompareMetricDelta, normalized: boolean): string {
  const value = normalized ? metric.candidate.normalized : metric.candidate.raw;

  if (metric.unit === "us") {
    return formatTimeShort(value);
  }

  if (metric.unit === "count") {
    return value.toFixed(value >= 100 ? 0 : 1);
  }

  return `${value.toFixed(2)} ${metric.unit}`;
}

function formatDelta(metric: TraceCompareMetricDelta): string {
  const delta = metric.normalizedDelta;
  const absDelta = Math.abs(delta);

  if (metric.unit === "us") {
    return formatTimeShort(absDelta);
  }

  if (metric.unit === "count") {
    return absDelta.toFixed(absDelta >= 100 ? 0 : 1);
  }

  return `${absDelta.toFixed(2)} ${metric.unit}`;
}

function sentenceCase(text: string): string {
  if (!text) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function buildNarrative(report: TraceCompareReport): string {
  const topFindings = report.findings.slice(0, 3);
  if (topFindings.length === 0) {
    return "Deep Mode did not find a stable enough delta to rank yet.";
  }

  const lead =
    report.winner === "candidate"
      ? `${report.candidate.label} is ahead overall.`
      : report.winner === "baseline"
        ? `${report.baseline.label} still holds the advantage overall.`
        : "The pair is mixed overall, so the largest deltas matter more than the headline timing.";

  const drivers = topFindings.map((finding) => sentenceCase(finding.summary));

  return `${lead} The main drivers are ${drivers.join(" ")}`;
}

function ImpactBadge({ impact }: { impact: TraceCompareFinding["impact"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        impact === "improved" && "border-[#c7e0cf] bg-[#eef8f1] text-[#316a45]",
        impact === "regressed" && "border-[#e7c7c7] bg-[#fff2f2] text-[#8a3d3d]",
        impact === "mixed" && "border-[#d9d9d9] bg-[#f7f7f7] text-[#666]",
        impact === "changed" && "border-[#d4d9ea] bg-[#f2f5ff] text-[#4c5f8f]"
      )}
    >
      {impact}
    </span>
  );
}

function FindingCard({
  finding,
  onFocusFinding,
}: {
  finding: TraceCompareFinding;
  onFocusFinding: (findingId: string) => void;
}) {
  const hasEvidence = finding.evidence.length > 0;

  return (
    <div className="rounded-sm border border-[#dddddd] bg-white p-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-[#222]">{finding.title}</div>
          <div className="mt-1 text-[11px] text-[#666]">{finding.summary}</div>
        </div>
        <ImpactBadge impact={finding.impact} />
      </div>

      <div className="mb-2 grid gap-2 text-[11px] text-[#555] md:grid-cols-2">
        <div className="rounded-sm bg-[#f7f7f7] px-2 py-1.5">
          Baseline: {formatMetric(finding.metric, true)}
        </div>
        <div className="rounded-sm bg-[#f7f7f7] px-2 py-1.5">
          Candidate: {formatMetric(finding.metric, true)}
        </div>
      </div>

      <div className="mb-3 text-[11px] leading-5 text-[#5a5a5a]">{finding.explanation}</div>

      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-[#666]">
          Delta: <span className="font-medium text-[#333]">{formatDelta(finding.metric)}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hasEvidence}
          onClick={() => onFocusFinding(finding.id)}
          className="h-7 rounded-sm border-[#ccc] bg-white px-2 text-[11px] text-[#444] hover:bg-[#f7f7f7]"
          title={hasEvidence ? "Focus evidence in the flame graphs" : "No focusable evidence is available for this finding"}
        >
          <Target className="h-3.5 w-3.5" />
          Focus Evidence
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[#666]">
        {icon}
        <span>{title}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

export function CompareFindingsPanel({
  report,
  onFocusFinding,
}: CompareFindingsPanelProps) {
  if (!report) {
    return (
      <div className="flex h-full items-center justify-center bg-[#fafafa] p-6">
        <div className="max-w-xs text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-sm border border-[#d9d9d9] bg-white">
            <ArrowLeftRight className="h-4 w-4 text-[#666]" />
          </div>
          <div className="text-sm font-semibold text-[#333]">Deep Mode</div>
          <div className="mt-2 text-xs leading-5 text-[#666]">
            Load a baseline and candidate run, set any normalization metadata you have, and
            the compare engine will rank the most meaningful deltas.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 min-h-0 flex-col overflow-hidden bg-[#fafafa]">
      <div className="border-b border-[#d9d9d9] bg-[#f3f3f3] px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[#666]">
              Deep Findings
            </div>
            <div className="mt-1 text-sm font-semibold text-[#222]">{report.headline}</div>
            <div className="mt-1 text-[11px] text-[#666]">
              Normalized by {report.normalization.label}. Winner: {report.winner}.
            </div>
          </div>
        </div>
        <div className="mt-2 text-[12px] leading-5 text-[#555]">{buildNarrative(report)}</div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-4">
          <Section title="Summary" icon={<Sparkles className="h-3.5 w-3.5 text-[#777]" />}>
            <div className="grid gap-2">
              {report.summaryMetrics.map((metric) => (
                <div
                  key={metric.name}
                  className="rounded-sm border border-[#dddddd] bg-white px-3 py-2"
                >
                  <div className="text-[11px] font-medium text-[#444]">{metric.label}</div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[#666]">
                    <span>Baseline {formatMetric(metric, true)}</span>
                    <span>Candidate {formatMetric(metric, true)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {report.caveats.length > 0 && (
            <Section
              title="Caveats"
              icon={<AlertTriangle className="h-3.5 w-3.5 text-[#8b6a2a]" />}
            >
              {report.caveats.map((caveat) => (
                <div
                  key={caveat}
                  className="rounded-sm border border-[#e6d9b6] bg-[#fff9ed] px-3 py-2 text-[11px] leading-5 text-[#6f5a29]"
                >
                  {caveat}
                </div>
              ))}
            </Section>
          )}

          <Section title="Top Findings" icon={<Radar className="h-3.5 w-3.5 text-[#777]" />}>
            {report.findings.slice(0, 6).map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                onFocusFinding={onFocusFinding}
              />
            ))}
          </Section>

          <Section title="Spikes And Gaps" icon={<Sparkles className="h-3.5 w-3.5 text-[#777]" />}>
            {report.spikeFindings.slice(0, 4).map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                onFocusFinding={onFocusFinding}
              />
            ))}
          </Section>

          <Section
            title="Call Paths And Threads"
            icon={<ArrowLeftRight className="h-3.5 w-3.5 text-[#777]" />}
          >
            {report.callPathFindings.slice(0, 4).map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                onFocusFinding={onFocusFinding}
              />
            ))}
          </Section>

          <Section title="Loops" icon={<Radar className="h-3.5 w-3.5 text-[#777]" />}>
            {report.loopFindings.length > 0 ? (
              report.loopFindings.slice(0, 4).map((finding) => (
                <FindingCard
                  key={finding.id}
                  finding={finding}
                  onFocusFinding={onFocusFinding}
                />
              ))
            ) : (
              <div className="rounded-sm border border-[#dddddd] bg-white px-3 py-2 text-[11px] text-[#666]">
                No stable repeated loop deltas were detected yet.
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
