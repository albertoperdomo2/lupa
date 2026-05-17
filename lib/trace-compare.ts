import type { TraceEvent } from "@/lib/trace-types";
import { formatTimeShort, isSpikeEvent } from "@/lib/trace-types";
import type {
  CompareFindingKind,
  IndexedTraceEvent,
  OperationSemanticCategory,
  TraceCategoryFinding,
  TraceCompareFinding,
  TraceCompareLoopSummary,
  TraceCompareMetadata,
  TraceCompareMetricDelta,
  TraceCompareMetricValue,
  TraceCompareRegion,
  TraceCompareReport,
  TraceIndex,
  TraceNormalizationConfig,
  TraceNormalizationMode,
  TraceRole,
  TraceSnapshot,
} from "@/lib/trace-chat";

interface ComparedTraceInput {
  role: TraceRole;
  snapshot: TraceSnapshot;
  index: TraceIndex;
  metadata: TraceCompareMetadata;
}

interface OperationAggregate {
  key: string;
  label: string;
  inclusiveTime: number;
  selfTime: number;
  count: number;
  maxDuration: number;
  sampleEventId: string | null;
}

interface GapAggregate {
  key: string;
  label: string;
  totalGapDuration: number;
  count: number;
  maxGapDuration: number;
  sampleRegion: TraceCompareRegion | null;
}

interface LoopAggregate {
  signature: string;
  count: number;
  totalDuration: number;
  sampleEventIds: string[];
}

interface ThreadAggregate {
  key: string;
  label: string;
  inclusiveTime: number;
  selfTime: number;
  count: number;
  sampleEventId: string | null;
}

interface CategoryAggregate {
  category: OperationSemanticCategory;
  inclusiveTime: number;
  selfTime: number;
  count: number;
  topOperations: Map<string, number>;
}

interface TraceAnalysis {
  totals: {
    duration: number;
    eventCount: number;
    spikeCount: number;
    gapDuration: number;
    gapCount: number;
  };
  byHotspot: Map<string, OperationAggregate>;
  bySignature: Map<string, OperationAggregate>;
  bySelfTime: Map<string, OperationAggregate>;
  bySpike: Map<string, OperationAggregate>;
  byCallPath: Map<string, OperationAggregate>;
  byThread: Map<string, ThreadAggregate>;
  byGap: Map<string, GapAggregate>;
  byCategory: Map<OperationSemanticCategory, CategoryAggregate>;
  loops: Map<string, LoopAggregate>;
}

interface EventNode {
  event: IndexedTraceEvent;
  children: EventNode[];
  path: string[];
  selfTime: number;
}

const LOOP_WINDOW_SIZE = 3;

function hashString(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function createId(prefix: string, value: string): string {
  const normalized = value.replace(/\s+/g, "_");
  const suffix = hashString(value);
  const head = normalized.slice(0, 120);
  return `${prefix}:${head}:${suffix}`;
}

const CATEGORY_LABELS: Record<OperationSemanticCategory, string> = {
  compute: "GPU compute",
  communication: "Communication",
  memory: "Memory",
  synchronization: "Synchronization",
  host_overhead: "Host overhead",
  other: "Other",
};

export function classifyOperationCategory(
  name: string,
  cat: string,
): OperationSemanticCategory {
  const lowerName = name.toLowerCase();
  const lowerCat = cat.toLowerCase();

  if (
    lowerCat === "kernel" ||
    lowerName.startsWith("aten::mm") ||
    lowerName.startsWith("aten::matmul") ||
    lowerName.startsWith("aten::conv") ||
    lowerName.startsWith("aten::addmm") ||
    lowerName.startsWith("aten::bmm") ||
    lowerName.startsWith("aten::linear") ||
    lowerName.startsWith("cutlass_") ||
    lowerName.startsWith("flash_") ||
    lowerName.startsWith("ampere_") ||
    lowerName.startsWith("sm80_") ||
    lowerName.startsWith("sm90_") ||
    lowerName.startsWith("triton_") ||
    lowerName.startsWith("compiled") ||
    lowerName.includes("fxgraph")
  ) {
    return "compute";
  }

  if (
    lowerName.startsWith("nccl:") ||
    lowerName.startsWith("c10d::") ||
    lowerCat === "nccl" ||
    lowerCat === "communication"
  ) {
    return "communication";
  }

  if (
    lowerName.includes("memcpy") ||
    lowerName.includes("cudamalloc") ||
    lowerName.includes("cudafree") ||
    lowerName === "aten::to" ||
    lowerName === "aten::copy_" ||
    lowerCat === "gpu_memcpy"
  ) {
    return "memory";
  }

  if (
    lowerName.includes("cudadevicesynchronize") ||
    lowerName.includes("cudastreamsynchronize") ||
    lowerName.includes("cudaeventsynchronize") ||
    lowerName.startsWith("c10::cuda::") ||
    lowerName.includes("synchronize")
  ) {
    return "synchronization";
  }

  if (
    lowerName === "cudalaunchkernel" ||
    (lowerCat === "cuda_runtime" && !lowerName.includes("synchronize"))
  ) {
    return "host_overhead";
  }

  return "other";
}

function formatMetricValue(value: number, unit: string): string {
  if (unit === "us") {
    return formatTimeShort(value);
  }

  if (unit === "count") {
    return value.toFixed(value >= 100 ? 0 : 1);
  }

  return `${value.toFixed(2)} ${unit}`;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function formatPercentValue(value: number | null): string {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatMetricForReport(metric: TraceCompareMetricDelta, side: "baseline" | "candidate"): string {
  return formatMetricValue(metric[side].normalized, metric.unit);
}

function formatEvidenceRegion(region: TraceCompareRegion): string {
  const parts = [
    region.traceLabel,
    `${formatTimeShort(region.startTime)} -> ${formatTimeShort(region.endTime)}`,
  ];

  if (region.processName) {
    parts.push(region.processName);
  }

  if (region.threadName) {
    parts.push(region.threadName);
  }

  return parts.join(" | ");
}

function buildFindingMarkdownBlock(
  finding: TraceCompareFinding,
  index: number
): string[] {
  const lines = [
    `### ${index}. ${finding.title}`,
    "",
    `${finding.summary}`,
    "",
    `${finding.explanation}`,
    "",
    `- Impact: ${finding.impact}`,
    `- Baseline: ${formatMetricForReport(finding.metric, "baseline")}`,
    `- Candidate: ${formatMetricForReport(finding.metric, "candidate")}`,
    `- Delta: ${formatMetricValue(Math.abs(finding.metric.normalizedDelta), finding.metric.unit)} (${formatPercentValue(finding.metric.normalizedDeltaPercent)})`,
  ];

  if (finding.evidence.length > 0) {
    lines.push("- Evidence:");
    for (const region of finding.evidence) {
      lines.push(`  - ${formatEvidenceRegion(region)}`);
    }
  }

  lines.push("");
  return lines;
}

function appendFindingSection(
  lines: string[],
  title: string,
  findings: TraceCompareFinding[],
  limit: number
) {
  lines.push(`## ${title}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("No findings available.");
    lines.push("");
    return;
  }

  for (const [index, finding] of findings.slice(0, limit).entries()) {
    lines.push(...buildFindingMarkdownBlock(finding, index + 1));
  }
}

function safePercentDelta(previous: number, current: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function normalizeMetricValue(value: number, denominator: number): TraceCompareMetricValue {
  return {
    raw: value,
    normalized: denominator > 0 ? value / denominator : value,
  };
}

function buildMetricDelta(
  name: string,
  label: string,
  unit: string,
  baselineValue: number,
  candidateValue: number,
  normalization: TraceNormalizationConfig
): TraceCompareMetricDelta {
  const baseline = normalizeMetricValue(
    baselineValue,
    normalization.baselineDenominator
  );
  const candidate = normalizeMetricValue(
    candidateValue,
    normalization.candidateDenominator
  );

  return {
    name,
    label,
    unit,
    baseline,
    candidate,
    delta: candidateValue - baselineValue,
    deltaPercent: safePercentDelta(baselineValue, candidateValue),
    normalizedDelta: candidate.normalized - baseline.normalized,
    normalizedDeltaPercent: safePercentDelta(
      baseline.normalized,
      candidate.normalized
    ),
  };
}

function collectShapeFragments(
  value: unknown,
  fragments: string[],
  depth = 0
): void {
  if (depth > 3 || fragments.length >= 3) return;

  if (Array.isArray(value)) {
    if (
      value.length > 0 &&
      value.length <= 4 &&
      value.every((item) => typeof item === "number" && Number.isFinite(item))
    ) {
      fragments.push(`[${value.join("x")}]`);
      return;
    }

    for (const item of value) {
      collectShapeFragments(item, fragments, depth + 1);
      if (fragments.length >= 3) return;
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/(shape|size|sizes|dim|dims|mat1|mat2|input|output|tensor)/i.test(key)) {
        collectShapeFragments(nested, fragments, depth + 1);
      }
      if (fragments.length >= 3) return;
    }
  }
}

function collectDtypeFragments(
  value: unknown,
  fragments: string[],
  depth = 0
): void {
  if (depth > 3 || fragments.length >= 2) return;

  if (typeof value === "string") {
    if (/\b(fp16|bf16|float16|float32|fp32|int8|int4)\b/i.test(value)) {
      fragments.push(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectDtypeFragments(item, fragments, depth + 1);
      if (fragments.length >= 2) return;
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/(dtype|type|precision)/i.test(key) || typeof nested === "string") {
        collectDtypeFragments(nested, fragments, depth + 1);
      }
      if (fragments.length >= 2) return;
    }
  }
}

function buildEventSignature(event: IndexedTraceEvent): string {
  const shapeFragments: string[] = [];
  const dtypeFragments: string[] = [];

  collectShapeFragments(event.args, shapeFragments);
  collectDtypeFragments(event.args, dtypeFragments);

  const parts = [event.name];
  if (dtypeFragments.length > 0) {
    parts.push(dtypeFragments.join(","));
  }
  if (shapeFragments.length > 0) {
    parts.push(shapeFragments.slice(0, 2).join(" x "));
  }

  return parts.join(" | ");
}

function buildRegionFromEvent(
  comparedTrace: ComparedTraceInput,
  title: string,
  description: string,
  eventId: string | null
): TraceCompareRegion[] {
  if (!eventId) return [];

  const event = comparedTrace.index.eventById.get(eventId);
  if (!event) return [];

  const baseDuration = Math.max(event.dur, 25_000);
  const padding = Math.max(baseDuration * 0.25, 10_000);

  return [
    {
      id: createId("region", `${comparedTrace.role}:${eventId}`),
      traceRole: comparedTrace.role,
      traceLabel: comparedTrace.snapshot.label,
      title,
      description,
      startTime: Math.max(comparedTrace.snapshot.bounds.startTime, event.ts - padding),
      endTime: Math.min(comparedTrace.snapshot.bounds.endTime, event.endTime + padding),
      processName: event.processName,
      threadName: event.threadName,
      eventIds: [event.id],
    },
  ];
}

function buildThreadTrees(events: IndexedTraceEvent[]): EventNode[] {
  const sortedEvents = events
    .filter((event) => event.kind === "span")
    .sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      return b.dur - a.dur;
    });
  const roots: EventNode[] = [];
  const stack: EventNode[] = [];

  for (const event of sortedEvents) {
    while (stack.length > 0 && event.ts >= stack[stack.length - 1].event.endTime) {
      stack.pop();
    }

    while (
      stack.length > 0 &&
      event.endTime > stack[stack.length - 1].event.endTime
    ) {
      stack.pop();
    }

    const node: EventNode = {
      event,
      children: [],
      path: [],
      selfTime: event.dur,
    };

    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
      node.path = [...parent.path, event.name];
    } else {
      node.path = [event.name];
      roots.push(node);
    }

    stack.push(node);
  }

  const computeSelfTimes = (node: EventNode) => {
    for (const child of node.children) {
      computeSelfTimes(child);
    }

    if (node.children.length === 0) {
      node.selfTime = node.event.dur;
      return;
    }

    const mergedIntervals = node.children
      .map((child) => ({
        start: child.event.ts,
        end: Math.min(node.event.endTime, child.event.endTime),
      }))
      .sort((a, b) => a.start - b.start);

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
    computeSelfTimes(root);
  }

  return roots;
}

function getAllThreadEventGroups(index: TraceIndex) {
  const grouped = new Map<string, IndexedTraceEvent[]>();

  for (const event of index.events) {
    const key = `${event.pid}:${event.tid}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.push(event);
    } else {
      grouped.set(key, [event]);
    }
  }

  return grouped;
}

function accumulateOperation(
  map: Map<string, OperationAggregate>,
  key: string,
  label: string,
  event: IndexedTraceEvent,
  inclusiveTime: number,
  selfTime: number
) {
  const current = map.get(key) ?? {
    key,
    label,
    inclusiveTime: 0,
    selfTime: 0,
    count: 0,
    maxDuration: 0,
    sampleEventId: null,
  };

  current.inclusiveTime += inclusiveTime;
  current.selfTime += selfTime;
  current.count += 1;
  current.maxDuration = Math.max(current.maxDuration, event.dur);
  current.sampleEventId ??= event.id;
  map.set(key, current);
}

function analyzeTrace(comparedTrace: ComparedTraceInput): TraceAnalysis {
  const byHotspot = new Map<string, OperationAggregate>();
  const bySignature = new Map<string, OperationAggregate>();
  const bySelfTime = new Map<string, OperationAggregate>();
  const bySpike = new Map<string, OperationAggregate>();
  const byCallPath = new Map<string, OperationAggregate>();
  const byThread = new Map<string, ThreadAggregate>();
  const byGap = new Map<string, GapAggregate>();
  const byCategory = new Map<OperationSemanticCategory, CategoryAggregate>();
  const loops = new Map<string, LoopAggregate>();
  let gapDuration = 0;
  let gapCount = 0;

  const threadGroups = getAllThreadEventGroups(comparedTrace.index);

  for (const threadEvents of threadGroups.values()) {
    const sortedByTime = threadEvents.slice().sort((a, b) => a.ts - b.ts);
    const treeRoots = buildThreadTrees(sortedByTime);
    const rootEvents = treeRoots.map((node) => node.event);

    const walkNode = (node: EventNode) => {
      const event = node.event;
      const signature = buildEventSignature(event);
      const callPath = node.path.slice(-4).join(" -> ");

      accumulateOperation(
        byHotspot,
        event.name,
        event.name,
        event,
        event.dur,
        node.selfTime
      );
      accumulateOperation(
        bySignature,
        signature,
        signature,
        event,
        event.dur,
        node.selfTime
      );
      accumulateOperation(
        bySelfTime,
        event.name,
        event.name,
        event,
        node.selfTime,
        node.selfTime
      );
      accumulateOperation(
        byCallPath,
        callPath,
        callPath,
        event,
        event.dur,
        node.selfTime
      );

      const opCategory = classifyOperationCategory(event.name, event.cat);
      const catAgg = byCategory.get(opCategory) ?? {
        category: opCategory,
        inclusiveTime: 0,
        selfTime: 0,
        count: 0,
        topOperations: new Map<string, number>(),
      };
      catAgg.inclusiveTime += event.dur;
      catAgg.selfTime += node.selfTime;
      catAgg.count += 1;
      catAgg.topOperations.set(
        event.name,
        (catAgg.topOperations.get(event.name) ?? 0) + node.selfTime,
      );
      byCategory.set(opCategory, catAgg);

      const threadKey = `${event.processName} / ${event.threadName}`;
      const threadAggregate = byThread.get(threadKey) ?? {
        key: threadKey,
        label: threadKey,
        inclusiveTime: 0,
        selfTime: 0,
        count: 0,
        sampleEventId: null,
      };
      threadAggregate.inclusiveTime += event.dur;
      threadAggregate.selfTime += node.selfTime;
      threadAggregate.count += 1;
      threadAggregate.sampleEventId ??= event.id;
      byThread.set(threadKey, threadAggregate);

      for (const child of node.children) {
        walkNode(child);
      }
    };

    for (const root of treeRoots) {
      walkNode(root);
    }

    const spikeEvents = sortedByTime.filter((event) => isSpikeEvent(event));
    for (const spike of spikeEvents) {
      accumulateOperation(
        bySpike,
        spike.name,
        spike.name,
        spike,
        Math.max(spike.dur, 1),
        Math.max(spike.dur, 1)
      );
    }

    const nonSpikeSpanEvents = sortedByTime.filter(
      (event) => !isSpikeEvent(event) && event.kind === "span"
    );
    for (let index = 0; index < nonSpikeSpanEvents.length - 1; index += 1) {
      const current = nonSpikeSpanEvents[index];
      const next = nonSpikeSpanEvents[index + 1];
      const gap = Math.max(0, next.ts - current.endTime);

      if (gap <= 0) continue;

      gapDuration += gap;
      gapCount += 1;
      const gapKey = `${current.threadName}: ${current.name} -> ${next.name}`;
      const gapAggregate = byGap.get(gapKey) ?? {
        key: gapKey,
        label: gapKey,
        totalGapDuration: 0,
        count: 0,
        maxGapDuration: 0,
        sampleRegion: null,
      };

      gapAggregate.totalGapDuration += gap;
      gapAggregate.count += 1;
      gapAggregate.maxGapDuration = Math.max(gapAggregate.maxGapDuration, gap);
      if (!gapAggregate.sampleRegion) {
        gapAggregate.sampleRegion = {
          id: createId("gap", `${comparedTrace.role}:${current.id}:${next.id}`),
          traceRole: comparedTrace.role,
          traceLabel: comparedTrace.snapshot.label,
          title: gapKey,
          description: `Host gap of ${formatTimeShort(gap)} between ${current.name} and ${next.name}.`,
          startTime: current.endTime,
          endTime: next.ts,
          processName: current.processName,
          threadName: current.threadName,
          eventIds: [current.id, next.id],
        };
      }

      byGap.set(gapKey, gapAggregate);
    }

    if (rootEvents.length >= LOOP_WINDOW_SIZE) {
      for (let index = 0; index <= rootEvents.length - LOOP_WINDOW_SIZE; index += 1) {
        const window = rootEvents.slice(index, index + LOOP_WINDOW_SIZE);
        const signature = window.map((event) => event.name).join(" -> ");
        const start = window[0].ts;
        const end = window[window.length - 1].endTime;
        const existing = loops.get(signature) ?? {
          signature,
          count: 0,
          totalDuration: 0,
          sampleEventIds: [],
        };

        existing.count += 1;
        existing.totalDuration += Math.max(0, end - start);
        if (existing.sampleEventIds.length === 0) {
          existing.sampleEventIds = window.map((event) => event.id);
        }
        loops.set(signature, existing);
      }
    }
  }

  return {
    totals: {
      duration: comparedTrace.snapshot.bounds.duration,
      eventCount: comparedTrace.snapshot.eventCount,
      spikeCount: comparedTrace.index.events.filter((event) => isSpikeEvent(event)).length,
      gapDuration,
      gapCount,
    },
    byHotspot,
    bySignature,
    bySelfTime,
    bySpike,
    byCallPath,
    byThread,
    byGap,
    byCategory,
    loops,
  };
}

function resolveNormalizationDenominator(
  metadata: TraceCompareMetadata,
  mode: TraceNormalizationMode
): number | null {
  switch (mode) {
    case "total":
      return 1;
    case "per_request":
      return metadata.requestCount ?? null;
    case "per_prompt_token":
      return metadata.promptTokenCount ?? null;
    case "per_output_token":
      return metadata.outputTokenCount ?? null;
    default:
      return 1;
  }
}

export function buildTraceNormalizationConfig(
  baseline: TraceCompareMetadata,
  candidate: TraceCompareMetadata,
  mode: TraceNormalizationMode
): {
  normalization: TraceNormalizationConfig;
  caveats: string[];
} {
  const caveats: string[] = [];
  const baselineDenominator = resolveNormalizationDenominator(baseline, mode);
  const candidateDenominator = resolveNormalizationDenominator(candidate, mode);

  const labelMap: Record<TraceNormalizationMode, string> = {
    total: "total trace",
    per_request: "per request",
    per_prompt_token: "per prompt token",
    per_output_token: "per output token",
  };

  if (baselineDenominator == null || candidateDenominator == null) {
    caveats.push(
      `Normalization mode "${labelMap[mode]}" is missing metadata on one or both traces, so Deep Mode fell back to raw totals.`
    );
  }

  return {
    normalization: {
      mode,
      label:
        baselineDenominator == null || candidateDenominator == null
          ? labelMap.total
          : labelMap[mode],
      baselineDenominator: baselineDenominator ?? 1,
      candidateDenominator: candidateDenominator ?? 1,
    },
    caveats,
  };
}

function buildRegionsForPair(
  baselineTrace: ComparedTraceInput,
  candidateTrace: ComparedTraceInput,
  baselineEventId: string | null,
  candidateEventId: string | null,
  title: string,
  description: string
) {
  return [
    ...buildRegionFromEvent(baselineTrace, title, description, baselineEventId),
    ...buildRegionFromEvent(candidateTrace, title, description, candidateEventId),
  ];
}

function findingImpactFromMetric(metric: TraceCompareMetricDelta): TraceCompareFinding["impact"] {
  if (metric.normalizedDelta < 0) return "improved";
  if (metric.normalizedDelta > 0) return "regressed";
  return "changed";
}

function categorySemanticWeight(category: OperationSemanticCategory): number {
  switch (category) {
    case "compute":
    case "communication":
      return 1.5;
    case "synchronization":
      return 1.3;
    case "host_overhead":
      return 1.2;
    case "memory":
      return 1.1;
    default:
      return 1.0;
  }
}

function computeFindingPriority(
  metric: TraceCompareMetricDelta,
  category: OperationSemanticCategory,
  traceDuration: number,
): number {
  const absDelta = Math.abs(metric.normalizedDelta);
  const fractionOfTrace = traceDuration > 0 ? absDelta / traceDuration : 0;
  const weight = categorySemanticWeight(category);

  let clarityBonus = 0;
  const absPct = Math.abs(metric.normalizedDeltaPercent ?? 0);
  if (absPct > 10 && absDelta > 1000) {
    clarityBonus = absDelta * 0.15;
  }

  return (absDelta + fractionOfTrace * traceDuration * 0.3 + clarityBonus) * weight;
}

function topOperationNames(ops: Map<string, number>, limit: number): string[] {
  return [...ops.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

function buildCategorySummaryFindings(
  baselineAnalysis: TraceAnalysis,
  candidateAnalysis: TraceAnalysis,
  normalization: TraceNormalizationConfig,
): TraceCategoryFinding[] {
  const categories: OperationSemanticCategory[] = [
    "compute", "communication", "memory", "synchronization", "host_overhead", "other",
  ];
  const results: TraceCategoryFinding[] = [];
  const totalDelta = candidateAnalysis.totals.duration - baselineAnalysis.totals.duration;

  for (const cat of categories) {
    const baselineCat = baselineAnalysis.byCategory.get(cat);
    const candidateCat = candidateAnalysis.byCategory.get(cat);
    if (!baselineCat && !candidateCat) continue;

    const baselineSelfTime = baselineCat?.selfTime ?? 0;
    const candidateSelfTime = candidateCat?.selfTime ?? 0;
    const metric = buildMetricDelta(
      `category:${cat}`,
      CATEGORY_LABELS[cat],
      "us",
      baselineSelfTime,
      candidateSelfTime,
      normalization,
    );

    if (Math.abs(metric.normalizedDelta) < 0.00001) continue;

    const maxDuration = Math.max(
      baselineAnalysis.totals.duration,
      candidateAnalysis.totals.duration,
    );
    const fractionOfTrace = maxDuration > 0
      ? Math.abs(metric.normalizedDelta) / (maxDuration / Math.max(normalization.baselineDenominator, 1))
      : 0;
    const relativeChange = Math.abs(metric.normalizedDeltaPercent ?? 0);

    if (fractionOfTrace < 0.01 && relativeChange < 5) continue;

    results.push({
      category: cat,
      categoryLabel: CATEGORY_LABELS[cat],
      impact: findingImpactFromMetric(metric),
      summaryDelta: metric,
      topFindings: [],
    });
  }

  return results.sort((a, b) =>
    Math.abs(b.summaryDelta.normalizedDelta) - Math.abs(a.summaryDelta.normalizedDelta),
  );
}

function extractOperationRoot(key: string): string {
  const arrowIndex = key.lastIndexOf(" -> ");
  return arrowIndex >= 0 ? key.slice(arrowIndex + 4) : key.split(" | ")[0];
}

function deduplicateFindingsByOperation(
  findings: TraceCompareFinding[],
): TraceCompareFinding[] {
  const byRoot = new Map<string, TraceCompareFinding[]>();

  for (const finding of findings) {
    const root = extractOperationRoot(finding.title);
    const group = byRoot.get(root);
    if (group) {
      group.push(finding);
    } else {
      byRoot.set(root, [finding]);
    }
  }

  const result: TraceCompareFinding[] = [];

  for (const group of byRoot.values()) {
    group.sort((a, b) => b.priority - a.priority);
    const best = group[0];
    const absorbedKinds = group
      .slice(1)
      .map((f) => f.kind)
      .filter((k) => k !== best.kind);
    if (absorbedKinds.length > 0) {
      best.labels = [...new Set([...best.labels, ...absorbedKinds])];
    }
    result.push(best);
  }

  return result.sort((a, b) => b.priority - a.priority);
}

function buildAggregateFindings(
  kind: CompareFindingKind,
  baselineTrace: ComparedTraceInput,
  candidateTrace: ComparedTraceInput,
  normalization: TraceNormalizationConfig,
  baselineMap:
    | Map<string, OperationAggregate>
    | Map<string, GapAggregate>
    | Map<string, ThreadAggregate>,
  candidateMap:
    | Map<string, OperationAggregate>
    | Map<string, GapAggregate>
    | Map<string, ThreadAggregate>,
  selector: (value: OperationAggregate | GapAggregate | ThreadAggregate) => number,
  unit: string,
  limit: number,
  traceDuration: number,
): TraceCompareFinding[] {
  const keys = new Set([...baselineMap.keys(), ...candidateMap.keys()]);
  const findings: TraceCompareFinding[] = [];

  const getSampleEventId = (
    value: OperationAggregate | GapAggregate | ThreadAggregate | undefined
  ): string | null =>
    value != null && "sampleEventId" in value ? value.sampleEventId ?? null : null;

  const getSampleRegion = (
    value: OperationAggregate | GapAggregate | ThreadAggregate | undefined
  ): TraceCompareRegion | null =>
    value != null && "sampleRegion" in value ? value.sampleRegion ?? null : null;

  for (const key of keys) {
    const baselineValue = baselineMap.get(key);
    const candidateValue = candidateMap.get(key);
    const baselineMetric = baselineValue ? selector(baselineValue) : 0;
    const candidateMetric = candidateValue ? selector(candidateValue) : 0;
    const label =
      baselineValue?.label ??
      candidateValue?.label ??
      key;
    const metric = buildMetricDelta(
      `${kind}:${key}`,
      label,
      unit,
      baselineMetric,
      candidateMetric,
      normalization
    );

    if (Math.abs(metric.normalizedDelta) < 0.00001) continue;

    const baselineSampleEventId = getSampleEventId(baselineValue);
    const candidateSampleEventId = getSampleEventId(candidateValue);
    const baselineSampleRegion = getSampleRegion(baselineValue);
    const candidateSampleRegion = getSampleRegion(candidateValue);
    const evidence = baselineSampleRegion || candidateSampleRegion
      ? [baselineSampleRegion, candidateSampleRegion].filter(
          (region): region is TraceCompareRegion => Boolean(region)
        )
      : buildRegionsForPair(
          baselineTrace,
          candidateTrace,
          baselineSampleEventId,
          candidateSampleEventId,
          label,
          `${label} changed by ${formatTimeShort(Math.abs(metric.delta))}.`
        );

    const opCategory = classifyOperationCategory(label, "");
    const categoryLabel = CATEGORY_LABELS[opCategory];
    const normLabel = normalization.label === "total trace" ? "overall" : normalization.label;
    const absDelta = formatMetricValue(Math.abs(metric.normalizedDelta), unit);
    const pctStr = metric.normalizedDeltaPercent != null
      ? ` (${metric.normalizedDeltaPercent >= 0 ? "+" : ""}${metric.normalizedDeltaPercent.toFixed(1)}%)`
      : "";

    findings.push({
      id: createId("finding", `${kind}:${key}`),
      kind,
      title: label,
      summary: metric.normalizedDelta < 0
        ? `${categoryLabel}: ${label} reduced by ${absDelta} ${normLabel}${pctStr}.`
        : `${categoryLabel}: ${label} increased by ${absDelta} ${normLabel}${pctStr}.`,
      explanation: [
        `Baseline: ${formatMetricValue(metric.baseline.normalized, unit)} ${normalization.label}.`,
        `Candidate: ${formatMetricValue(metric.candidate.normalized, unit)} ${normalization.label}.`,
        metric.normalizedDeltaPercent == null
          ? "Relative percent change is unavailable because the baseline value is zero."
          : `Delta: ${metric.normalizedDeltaPercent.toFixed(1)}%.`,
      ].join(" "),
      impact: findingImpactFromMetric(metric),
      priority: computeFindingPriority(metric, opCategory, traceDuration),
      metric,
      labels: [kind, normalization.label, opCategory],
      baselineSample:
        baselineValue && "label" in baselineValue
          ? baselineValue.label
          : undefined,
      candidateSample:
        candidateValue && "label" in candidateValue
          ? candidateValue.label
          : undefined,
      evidence,
    });
  }

  return findings
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}

function buildLoopFindings(
  baselineTrace: ComparedTraceInput,
  candidateTrace: ComparedTraceInput,
  normalization: TraceNormalizationConfig,
  baselineLoops: Map<string, LoopAggregate>,
  candidateLoops: Map<string, LoopAggregate>,
  limit: number
): {
  findings: TraceCompareFinding[];
  summaries: TraceCompareLoopSummary[];
} {
  const keys = new Set([...baselineLoops.keys(), ...candidateLoops.keys()]);
  const findings: TraceCompareFinding[] = [];
  const summaries: TraceCompareLoopSummary[] = [];

  for (const key of keys) {
    const baselineLoop = baselineLoops.get(key);
    const candidateLoop = candidateLoops.get(key);
    const baselineAvg = baselineLoop
      ? baselineLoop.totalDuration / Math.max(baselineLoop.count, 1)
      : 0;
    const candidateAvg = candidateLoop
      ? candidateLoop.totalDuration / Math.max(candidateLoop.count, 1)
      : 0;

    summaries.push({
      signature: key,
      baselineCount: baselineLoop?.count ?? 0,
      candidateCount: candidateLoop?.count ?? 0,
      baselineAvgDuration: baselineAvg,
      candidateAvgDuration: candidateAvg,
    });

    const metric = buildMetricDelta(
      `loop:${key}`,
      key,
      "us",
      baselineAvg,
      candidateAvg,
      normalization
    );

    if (Math.abs(metric.normalizedDelta) < 0.00001) continue;

    const evidence = buildRegionsForPair(
      baselineTrace,
      candidateTrace,
      baselineLoop?.sampleEventIds[0] ?? null,
      candidateLoop?.sampleEventIds[0] ?? null,
      key,
      "Representative recurring loop window."
    );

    findings.push({
      id: createId("finding", `loop:${key}`),
      kind: "loop",
      title: key,
      summary:
        candidateAvg < baselineAvg
          ? `Candidate shortened the recurring loop "${key}".`
          : `Candidate lengthened the recurring loop "${key}".`,
      explanation: `Baseline repeats: ${baselineLoop?.count ?? 0}. Candidate repeats: ${candidateLoop?.count ?? 0}. Baseline avg: ${formatTimeShort(
        baselineAvg
      )}. Candidate avg: ${formatTimeShort(candidateAvg)}.`,
      impact: findingImpactFromMetric(metric),
      priority: Math.abs(metric.normalizedDelta),
      metric,
      labels: ["loop", normalization.label],
      evidence,
    });
  }

  return {
    findings: findings.sort((a, b) => b.priority - a.priority).slice(0, limit),
    summaries: summaries
      .sort(
        (a, b) =>
          Math.abs(
            b.candidateAvgDuration - b.baselineAvgDuration
          ) -
          Math.abs(a.candidateAvgDuration - a.baselineAvgDuration)
      )
      .slice(0, limit),
  };
}

export function buildTraceCompareReport(input: {
  baselineTrace: ComparedTraceInput | null;
  candidateTrace: ComparedTraceInput | null;
  normalizationMode: TraceNormalizationMode;
}): TraceCompareReport | null {
  const { baselineTrace, candidateTrace, normalizationMode } = input;
  if (!baselineTrace || !candidateTrace) return null;

  const { normalization, caveats: normalizationCaveats } =
    buildTraceNormalizationConfig(
      baselineTrace.metadata,
      candidateTrace.metadata,
      normalizationMode
    );
  const baselineAnalysis = analyzeTrace(baselineTrace);
  const candidateAnalysis = analyzeTrace(candidateTrace);

  const summaryMetrics = [
    buildMetricDelta(
      "duration",
      "Total duration",
      "us",
      baselineAnalysis.totals.duration,
      candidateAnalysis.totals.duration,
      normalization
    ),
    buildMetricDelta(
      "event_count",
      "Event count",
      "count",
      baselineAnalysis.totals.eventCount,
      candidateAnalysis.totals.eventCount,
      normalization
    ),
    buildMetricDelta(
      "spike_count",
      "Spike count",
      "count",
      baselineAnalysis.totals.spikeCount,
      candidateAnalysis.totals.spikeCount,
      normalization
    ),
    buildMetricDelta(
      "gap_duration",
      "Host gap duration",
      "us",
      baselineAnalysis.totals.gapDuration,
      candidateAnalysis.totals.gapDuration,
      normalization
    ),
  ];

  const traceDuration = Math.max(
    baselineAnalysis.totals.duration,
    candidateAnalysis.totals.duration,
  );

  const hotspotFindings = buildAggregateFindings(
    "hotspot",
    baselineTrace,
    candidateTrace,
    normalization,
    baselineAnalysis.byHotspot,
    candidateAnalysis.byHotspot,
    (value) => (value as OperationAggregate).inclusiveTime,
    "us",
    8,
    traceDuration,
  );
  const signatureFindings = buildAggregateFindings(
    "signature",
    baselineTrace,
    candidateTrace,
    normalization,
    baselineAnalysis.bySignature,
    candidateAnalysis.bySignature,
    (value) => (value as OperationAggregate).inclusiveTime,
    "us",
    8,
    traceDuration,
  );
  const selfTimeFindings = buildAggregateFindings(
    "self_time",
    baselineTrace,
    candidateTrace,
    normalization,
    baselineAnalysis.bySelfTime,
    candidateAnalysis.bySelfTime,
    (value) => (value as OperationAggregate).selfTime,
    "us",
    8,
    traceDuration,
  );
  const spikeFindings = buildAggregateFindings(
    "spike",
    baselineTrace,
    candidateTrace,
    normalization,
    baselineAnalysis.bySpike,
    candidateAnalysis.bySpike,
    (value) => (value as OperationAggregate).count,
    "count",
    8,
    traceDuration,
  );
  const gapFindings = buildAggregateFindings(
    "gap",
    baselineTrace,
    candidateTrace,
    normalization,
    baselineAnalysis.byGap,
    candidateAnalysis.byGap,
    (value) => (value as GapAggregate).totalGapDuration,
    "us",
    6,
    traceDuration,
  );
  const callPathFindings = buildAggregateFindings(
    "call_path",
    baselineTrace,
    candidateTrace,
    normalization,
    baselineAnalysis.byCallPath,
    candidateAnalysis.byCallPath,
    (value) => (value as OperationAggregate).selfTime,
    "us",
    6,
    traceDuration,
  );
  const threadFindings = buildAggregateFindings(
    "thread",
    baselineTrace,
    candidateTrace,
    normalization,
    baselineAnalysis.byThread,
    candidateAnalysis.byThread,
    (value) => (value as ThreadAggregate).selfTime,
    "us",
    6,
    traceDuration,
  );
  const loopData = buildLoopFindings(
    baselineTrace,
    candidateTrace,
    normalization,
    baselineAnalysis.loops,
    candidateAnalysis.loops,
    6
  );

  const allFindings = deduplicateFindingsByOperation([
    ...hotspotFindings,
    ...signatureFindings,
    ...selfTimeFindings,
    ...spikeFindings,
    ...gapFindings,
    ...callPathFindings,
    ...threadFindings,
    ...loopData.findings,
  ]).slice(0, 12);

  const categoryFindings = buildCategorySummaryFindings(
    baselineAnalysis,
    candidateAnalysis,
    normalization,
  );

  for (const catFinding of categoryFindings) {
    catFinding.topFindings = allFindings
      .filter((f) => f.labels.includes(catFinding.category))
      .slice(0, 4);
  }

  const representativeRegions = allFindings
    .flatMap((finding) => finding.evidence)
    .slice(0, 16);

  const durationMetric = summaryMetrics[0];
  const winner =
    durationMetric.normalizedDelta < 0
      ? "candidate"
      : durationMetric.normalizedDelta > 0
        ? "baseline"
        : "mixed";
  const headline =
    winner === "candidate"
      ? `${candidateTrace.snapshot.label} is faster than ${baselineTrace.snapshot.label} by ${formatTimeShort(
          Math.abs(durationMetric.normalizedDelta)
        )} ${normalization.label}.`
      : winner === "baseline"
        ? `${baselineTrace.snapshot.label} remains faster than ${candidateTrace.snapshot.label} by ${formatTimeShort(
            Math.abs(durationMetric.normalizedDelta)
          )} ${normalization.label}.`
        : `The traces are mixed or close after ${normalization.label} normalization.`;

  const caveats = [...normalizationCaveats];
  if (
    baselineTrace.metadata.hardwareLabel &&
    candidateTrace.metadata.hardwareLabel &&
    baselineTrace.metadata.hardwareLabel !== candidateTrace.metadata.hardwareLabel
  ) {
    caveats.push(
      `Hardware labels differ (${baselineTrace.metadata.hardwareLabel} vs ${candidateTrace.metadata.hardwareLabel}), so timing deltas may include hardware effects.`
    );
  }
  if (
    baselineTrace.metadata.modelLabel &&
    candidateTrace.metadata.modelLabel &&
    baselineTrace.metadata.modelLabel !== candidateTrace.metadata.modelLabel
  ) {
    caveats.push(
      `Model labels differ (${baselineTrace.metadata.modelLabel} vs ${candidateTrace.metadata.modelLabel}), so Deep Mode is comparing workloads, not a strict apples-to-apples run.`
    );
  }

  return {
    id: createId(
      "compare",
      `${baselineTrace.snapshot.id}:${candidateTrace.snapshot.id}:${normalization.mode}`
    ),
    createdAt: new Date().toISOString(),
    available: true,
    normalization,
    baseline: baselineTrace.metadata,
    candidate: candidateTrace.metadata,
    winner,
    headline,
    summaryMetrics,
    findings: allFindings,
    categoryFindings,
    hotspotFindings: [...hotspotFindings, ...signatureFindings, ...selfTimeFindings]
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 10),
    spikeFindings: [...spikeFindings, ...gapFindings]
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 10),
    callPathFindings: [...callPathFindings, ...threadFindings]
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 10),
    loopFindings: loopData.findings,
    representativeRegions,
    topChangedLoops: loopData.summaries,
    caveats,
  };
}

export function buildTraceCompareReportExport(report: TraceCompareReport): string {
  const lines: string[] = [
    "# Deep Findings Report",
    "",
    `Generated: ${report.createdAt}`,
    "",
    "## Overview",
    "",
    `- Baseline: ${report.baseline.label}`,
    `- Candidate: ${report.candidate.label}`,
    `- Normalization: ${report.normalization.label}`,
    `- Winner: ${report.winner}`,
    "",
    `${report.headline}`,
    "",
    "## Summary Metrics",
    "",
    "| Metric | Baseline | Candidate | Delta | Percent |",
    "| --- | --- | --- | --- | --- |",
    ...report.summaryMetrics.map((metric) => {
      const delta = formatMetricValue(Math.abs(metric.normalizedDelta), metric.unit);
      return `| ${escapeMarkdownCell(metric.label)} | ${escapeMarkdownCell(formatMetricForReport(metric, "baseline"))} | ${escapeMarkdownCell(formatMetricForReport(metric, "candidate"))} | ${escapeMarkdownCell(delta)} | ${escapeMarkdownCell(formatPercentValue(metric.normalizedDeltaPercent))} |`;
    }),
    "",
  ];

  if (report.categoryFindings.length > 0) {
    lines.push("## Category Breakdown");
    lines.push("");
    for (const cat of report.categoryFindings) {
      const delta = formatMetricValue(Math.abs(cat.summaryDelta.normalizedDelta), cat.summaryDelta.unit);
      const pct = formatPercentValue(cat.summaryDelta.normalizedDeltaPercent);
      lines.push(`- **${cat.categoryLabel}**: ${cat.impact} by ${delta} (${pct})`);
    }
    lines.push("");
  }

  appendFindingSection(lines, "Top Findings", report.findings, 6);
  appendFindingSection(lines, "Spikes And Gaps", report.spikeFindings, 4);
  appendFindingSection(lines, "Call Paths And Threads", report.callPathFindings, 4);
  appendFindingSection(lines, "Loops", report.loopFindings, 4);

  if (report.caveats.length > 0) {
    lines.push("## Caveats");
    lines.push("");
    for (const caveat of report.caveats) {
      lines.push(`- ${caveat}`);
    }
    lines.push("");
  }

  return `${lines.join("\n").trim()}\n`;
}

export function findCompareFinding(
  report: TraceCompareReport | null,
  findingId: string
): TraceCompareFinding | null {
  if (!report) return null;

  return (
    [
      ...report.findings,
      ...report.hotspotFindings,
      ...report.spikeFindings,
      ...report.callPathFindings,
      ...report.loopFindings,
    ].find((finding) => finding.id === findingId) ?? null
  );
}

export function findCompareRegion(
  report: TraceCompareReport | null,
  regionId: string
): TraceCompareRegion | null {
  if (!report) return null;
  return (
    report.representativeRegions.find((region) => region.id === regionId) ??
    report.findings.flatMap((finding) => finding.evidence).find((region) => region.id === regionId) ??
    null
  );
}

export interface OperationChildComparison {
  baselineInstances: number;
  candidateInstances: number;
  baselineTotalDuration: number;
  candidateTotalDuration: number;
  childComparison: Array<{
    name: string;
    baselineTime: number;
    candidateTime: number;
    delta: number;
    deltaPercent: number | null;
  }>;
}

function aggregateChildrenByName(
  index: TraceIndex,
  operationName: string,
): { instances: number; totalDuration: number; children: Map<string, number> } {
  const children = new Map<string, number>();
  let instances = 0;
  let totalDuration = 0;

  for (const event of index.events) {
    if (event.name !== operationName || event.kind !== "span") continue;
    const node = index.spanNodeById.get(event.id);
    if (!node) continue;

    instances += 1;
    totalDuration += event.dur;

    for (const childId of node.childIds) {
      const childEvent = index.eventById.get(childId);
      if (!childEvent) continue;
      children.set(
        childEvent.name,
        (children.get(childEvent.name) ?? 0) + childEvent.dur,
      );
    }
  }

  return { instances, totalDuration, children };
}

export function compareOperationChildren(
  baselineIndex: TraceIndex,
  candidateIndex: TraceIndex,
  operationName: string,
  limit: number,
): OperationChildComparison {
  const baseline = aggregateChildrenByName(baselineIndex, operationName);
  const candidate = aggregateChildrenByName(candidateIndex, operationName);

  const allChildNames = new Set([
    ...baseline.children.keys(),
    ...candidate.children.keys(),
  ]);

  const childComparison = [...allChildNames]
    .map((name) => {
      const baselineTime = baseline.children.get(name) ?? 0;
      const candidateTime = candidate.children.get(name) ?? 0;
      const delta = candidateTime - baselineTime;
      return {
        name,
        baselineTime,
        candidateTime,
        delta,
        deltaPercent: baselineTime > 0 ? (delta / baselineTime) * 100 : null,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);

  return {
    baselineInstances: baseline.instances,
    candidateInstances: candidate.instances,
    baselineTotalDuration: baseline.totalDuration,
    candidateTotalDuration: candidate.totalDuration,
    childComparison,
  };
}
