import type {
  TraceData,
  TraceEvent,
  ViewState,
} from "@/lib/trace-types";

export type TraceChatToolName =
  | "search_events"
  | "inspect_event"
  | "inspect_current_view"
  | "focus_event"
  | "set_view_range"
  | "fit_to_trace"
  | "clear_selection"
  | "compare_with_previous"
  | "run_deep_compare"
  | "inspect_compare_finding"
  | "focus_compare_region"
  | "compare_spikes"
  | "compare_hotspots"
  | "compare_call_paths"
  | "search_repo_paths"
  | "list_repo_directory"
  | "read_repo_file";

export interface IndexedTraceEvent {
  id: string;
  event: TraceEvent;
  name: string;
  cat: string;
  ph: TraceEvent["ph"];
  ts: number;
  dur: number;
  endTime: number;
  pid: number;
  tid: number;
  processName: string;
  threadName: string;
  args?: Record<string, unknown>;
  cname?: string;
}

export interface TraceEventReference {
  id: string;
  name: string;
  cat: string;
  ph: TraceEvent["ph"];
  ts: number;
  dur: number;
  endTime: number;
  pid: number;
  tid: number;
  processName: string;
  threadName: string;
  cname?: string;
  args?: Record<string, unknown>;
}

export interface TraceHotspotSummary {
  name: string;
  totalDuration: number;
  occurrences: number;
  averageDuration: number;
  maxDuration: number;
  sampleEventId: string | null;
  categories: string[];
  processes: string[];
  threads: string[];
}

export interface TraceProcessSummary {
  pid: number;
  name: string;
  threadCount: number;
  eventCount: number;
  totalDuration: number;
  topThreads: Array<{
    tid: number;
    name: string;
    eventCount: number;
    totalDuration: number;
  }>;
}

export interface TraceCategorySummary {
  name: string;
  count: number;
}

export interface TraceMetricDelta {
  name: string;
  previous: number;
  current: number;
  delta: number;
  deltaPercent: number | null;
}

export interface TraceSnapshot {
  id: string;
  label: string;
  filename?: string;
  loadedAt: string;
  eventCount: number;
  processCount: number;
  threadCount: number;
  bounds: {
    startTime: number;
    endTime: number;
    duration: number;
  };
  metadata: TraceData["metadata"] | null;
  categories: string[];
  topCategories: TraceCategorySummary[];
  topHotspots: TraceHotspotSummary[];
  topProcesses: TraceProcessSummary[];
}

export interface VisibleBucketSummary {
  startTime: number;
  endTime: number;
  eventCount: number;
  dominantHotspot: string | null;
  overlapDuration: number;
}

export interface ViewportSummary {
  startTime: number;
  endTime: number;
  duration: number;
  visibleEventCount: number;
  visibleSpikeCount: number;
  selectedEvent: TraceEventReference | null;
  topVisibleHotspots: TraceHotspotSummary[];
  topVisibleSpikeHotspots: TraceHotspotSummary[];
  longestVisibleEvents: TraceEventReference[];
  sampleVisibleSpikeEvents: TraceEventReference[];
  visibleProcesses: TraceProcessSummary[];
  searchQuery: string;
  searchMatchCount: number;
  searchMatches: TraceEventReference[];
  timeBuckets: VisibleBucketSummary[];
}

export interface EventInspection {
  event: TraceEventReference;
  previousInThread: TraceEventReference[];
  nextInThread: TraceEventReference[];
  overlappingInThread: TraceEventReference[];
}

export interface TraceDiffSummary {
  available: boolean;
  previousLabel: string | null;
  currentLabel: string | null;
  eventCountDelta: TraceMetricDelta;
  durationDelta: TraceMetricDelta;
  processCountDelta: TraceMetricDelta;
  threadCountDelta: TraceMetricDelta;
  hotspotChanges: TraceMetricDelta[];
  processChanges: TraceMetricDelta[];
  categoryChanges: TraceMetricDelta[];
}

export type TraceRole = "baseline" | "candidate";

export type TraceWorkloadKind = "prefill" | "decode" | "mixed" | "unknown";

export type TraceNormalizationMode =
  | "total"
  | "per_request"
  | "per_prompt_token"
  | "per_output_token";

export type CompareFindingKind =
  | "summary"
  | "hotspot"
  | "signature"
  | "self_time"
  | "spike"
  | "gap"
  | "call_path"
  | "loop"
  | "thread";

export interface TraceCompareMetadata {
  traceId: string;
  label: string;
  workloadKind: TraceWorkloadKind;
  modelLabel?: string;
  hardwareLabel?: string;
  requestCount?: number;
  promptTokenCount?: number;
  outputTokenCount?: number;
  notes?: string;
}

export interface TraceNormalizationConfig {
  mode: TraceNormalizationMode;
  label: string;
  baselineDenominator: number;
  candidateDenominator: number;
}

export interface TraceCompareMetricValue {
  raw: number;
  normalized: number;
}

export interface TraceCompareMetricDelta {
  name: string;
  label: string;
  unit: string;
  baseline: TraceCompareMetricValue;
  candidate: TraceCompareMetricValue;
  delta: number;
  deltaPercent: number | null;
  normalizedDelta: number;
  normalizedDeltaPercent: number | null;
}

export interface TraceCompareRegion {
  id: string;
  traceRole: TraceRole;
  traceLabel: string;
  title: string;
  description: string;
  startTime: number;
  endTime: number;
  processName?: string;
  threadName?: string;
  eventIds: string[];
}

export interface TraceCompareFinding {
  id: string;
  kind: CompareFindingKind;
  title: string;
  summary: string;
  explanation: string;
  impact: "improved" | "regressed" | "changed" | "mixed";
  priority: number;
  metric: TraceCompareMetricDelta;
  labels: string[];
  baselineSample?: string;
  candidateSample?: string;
  evidence: TraceCompareRegion[];
}

export interface TraceCompareLoopSummary {
  signature: string;
  baselineCount: number;
  candidateCount: number;
  baselineAvgDuration: number;
  candidateAvgDuration: number;
}

export interface TraceCompareReport {
  id: string;
  createdAt: string;
  available: boolean;
  normalization: TraceNormalizationConfig;
  baseline: TraceCompareMetadata;
  candidate: TraceCompareMetadata;
  winner: "baseline" | "candidate" | "mixed" | "unclear";
  headline: string;
  summaryMetrics: TraceCompareMetricDelta[];
  findings: TraceCompareFinding[];
  hotspotFindings: TraceCompareFinding[];
  spikeFindings: TraceCompareFinding[];
  callPathFindings: TraceCompareFinding[];
  loopFindings: TraceCompareFinding[];
  representativeRegions: TraceCompareRegion[];
  topChangedLoops: TraceCompareLoopSummary[];
  caveats: string[];
}

export interface DeepCompareContext {
  enabled: boolean;
  baselineTrace: TraceSnapshot | null;
  candidateTrace: TraceSnapshot | null;
  baselineView: ViewportSummary | null;
  candidateView: ViewportSummary | null;
  metadata: {
    baseline: TraceCompareMetadata | null;
    candidate: TraceCompareMetadata | null;
  };
  normalizationMode: TraceNormalizationMode;
  report: TraceCompareReport | null;
}

export interface TraceChatContext {
  currentTrace: TraceSnapshot | null;
  previousTrace: TraceSnapshot | null;
  currentView: ViewportSummary | null;
  comparisonToPrevious: TraceDiffSummary | null;
  deepCompare?: DeepCompareContext | null;
}

export interface AttachedTraceSummary {
  id: string;
  label: string;
  filename?: string;
  loadedAt: string;
  eventCount: number;
  bounds: TraceSnapshot["bounds"];
}

interface TraceChatAttachmentBase {
  id: string;
  label: string;
  createdAt: string;
  traceId: string | null;
  traceLabel: string | null;
}

export interface TraceChatImageAttachment extends TraceChatAttachmentBase {
  kind: "image";
  source: "manual_capture";
  imageDataUrl: string;
  mimeType: "image/png";
  width: number;
  height: number;
}

export interface TraceChatSelectionAttachment extends TraceChatAttachmentBase {
  kind: "selection";
  source: "selection_details";
  fingerprint: string;
  trace: AttachedTraceSummary;
  event: TraceEventReference;
  inspection: EventInspection;
  rawEvent: TraceEvent;
}

export type TraceChatAttachment =
  | TraceChatImageAttachment
  | TraceChatSelectionAttachment;

export interface TraceChatToolResult {
  callId: string;
  name: TraceChatToolName;
  output: unknown;
}

export interface GitHubRepoMention {
  id: string;
  url: string;
}

export interface TraceChatRequest {
  previousResponseId?: string | null;
  userMessage?: string | null;
  toolOutputs?: TraceChatToolResult[];
  context: TraceChatContext;
  screenshotDataUrl?: string | null;
  attachments?: TraceChatAttachment[];
  repoMentions?: GitHubRepoMention[];
  stream?: boolean;
}

export interface TraceChatToolCall {
  callId: string;
  name: TraceChatToolName;
  arguments: Record<string, unknown>;
}

export interface TraceChatResponse {
  responseId: string;
  assistantText: string;
  toolCalls: TraceChatToolCall[];
  model: string;
}

export type TraceChatStreamEvent =
  | {
      type: "assistant_delta";
      delta: string;
    }
  | {
      type: "assistant_done";
      response: TraceChatResponse;
    }
  | {
      type: "error";
      error: string;
    };

export interface TraceIndex {
  events: IndexedTraceEvent[];
  eventById: Map<string, IndexedTraceEvent>;
  idByEvent: WeakMap<TraceEvent, string>;
}

export interface BuildViewportSummaryOptions {
  viewState: ViewState;
  selectedEventId: string | null;
  searchQuery: string;
}
