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
  | "compare_with_previous";

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

export interface TraceChatContext {
  currentTrace: TraceSnapshot | null;
  previousTrace: TraceSnapshot | null;
  currentView: ViewportSummary | null;
  comparisonToPrevious: TraceDiffSummary | null;
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
