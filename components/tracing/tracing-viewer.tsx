"use client";

import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { toCanvas } from "html-to-image";
import type { Process, TraceData, TraceEvent, ViewState } from "@/lib/trace-types";
import type {
  AttachedTraceSummary,
  GitHubRepoMention,
  TraceChatAttachment,
  TraceChatContext,
  TraceChatResponse,
  TraceChatSelectionAttachment,
  TraceChatStreamEvent,
  TraceChatToolCall,
  TraceChatToolResult,
  TraceCompareMetadata,
  TraceNormalizationMode,
  TraceRole,
  TraceSnapshot,
} from "@/lib/trace-chat";
import {
  buildProcessMap,
  buildTraceDiffSummary,
  buildTraceIndex,
  buildTraceSnapshot,
  buildViewportSummary,
  inspectTraceAnomaly,
  inspectTraceEvent,
  normalizeTraceEvents,
  searchTraceEvents,
} from "@/lib/trace-analysis";
import { buildTraceAnomalies, compareTraceAnomalies } from "@/lib/trace-anomalies";
import type { TraceAnomaly } from "@/lib/trace-chat";
import {
  clearPersistedTraceSession,
  loadPersistedTraceSession,
  savePersistedTracePayload,
  savePersistedViewerState,
  type PersistedTraceEventRef,
  type PersistedTracePanePayload,
  type PersistedTracePaneUiState,
  type RestoredTracePaneRecord,
} from "@/lib/trace-persistence";
import {
  appendTraceRunSource,
  createTraceRunBuilder,
  finalizeTraceRunBuilder,
  type TraceRunInput,
  type TraceRunSourceSummary,
} from "@/lib/trace-run";
import {
  buildTraceCompareReport,
  buildTraceCompareReportExport,
  findCompareFinding,
  findCompareRegion,
} from "@/lib/trace-compare";
import { buildGitHubRepoMentionToken } from "@/lib/github-repo";
import { parseTraceFile } from "@/lib/trace-file-reader";
import { formatTimeShort } from "@/lib/trace-types";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ChatPanel } from "./chat-panel";
import type { ChatPanelMessage } from "./chat-panel";
import { CommandPalette } from "./command-palette";
import { CompareControls } from "./compare-controls";
import { CompareFindingsPanel } from "./compare-findings-panel";
import { DetailsPanel } from "./details-panel";
import { EmptyState } from "./empty-state";
import { Minimap } from "./minimap";
import { SideToolbar } from "./side-toolbar";
import { StatusBar } from "./status-bar";
import { Timeline, type TimelineEvidenceHighlight } from "./timeline";
import { TracePane } from "./trace-pane";

interface LupaAppProps {
  chatEnabled: boolean;
  chatModel: string;
}

interface TimelineApi {
  captureImage: () => string | null;
}

type ViewerMode = "single" | "deep";
type LoadTarget = "single" | "baseline" | "candidate";
type RuntimeTargetKey = "single" | TraceRole;

interface RuntimeTargetState {
  viewState: ViewState;
  selectedEvent: TraceEvent | null;
}

interface ToolExecutionRuntime {
  mode: ViewerMode;
  single: RuntimeTargetState;
  baseline: RuntimeTargetState;
  candidate: RuntimeTargetState;
}

interface ToolExecutionResult {
  output: unknown;
  logMessage: string;
  runtime: ToolExecutionRuntime;
}

interface TracePaneState {
  traceData: TraceData | null;
  traceLoadedAt: string | null;
  filename?: string;
  sources: TraceRunSourceSummary[];
  selectedEvent: TraceEvent | null;
  tool: "select" | "pan";
  viewState: ViewState;
}

interface CapturePoint {
  x: number;
  y: number;
}

interface CaptureRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface RunLoadProgress {
  target: LoadTarget;
  stage: "reading" | "parsing" | "combining";
  fileCount: number;
  completedFiles: number;
  currentFileIndex: number;
  currentFileName: string | null;
  totalBytes: number;
  loadedBytes: number;
}

interface PersistedChatSession {
  messages: ChatPanelMessage[];
  responseId: string | null;
  repoMentions?: GitHubRepoMention[];
}

const TOOL_STEP_LIMIT = 6;
const MIN_CAPTURE_SIZE_PX = 24;
const GITHUB_URL_REGEX = /https?:\/\/github\.com\/[^\s<>()\]]+/gi;
const TRACE_AGENT_CHAT_STORAGE_KEY = "lupa-trace-agent-chat-session:v1";
const TRACE_AGENT_TRACE_STORAGE_KEY = "lupa-trace-agent-last-trace:v1";

function createLocalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createDefaultViewState(): ViewState {
  return {
    startTime: 0,
    endTime: 1_000_000,
    scale: 1,
  };
}

function createEmptyTracePaneState(): TracePaneState {
  return {
    traceData: null,
    traceLoadedAt: null,
    filename: undefined,
    sources: [],
    selectedEvent: null,
    tool: "select",
    viewState: createDefaultViewState(),
  };
}

function createCompareMetadata(label: string): TraceCompareMetadata {
  return {
    traceId: label.toLowerCase().replace(/\s+/g, "-"),
    label,
    workloadKind: "unknown",
  };
}

function toPersistedTraceEventRef(event: TraceEvent | null): PersistedTraceEventRef | null {
  if (!event) return null;

  return {
    name: event.name,
    ts: event.ts,
    dur: event.dur,
    pid: event.pid,
    tid: event.tid,
    ph: event.ph,
  };
}

function findMatchingTraceEvent(
  traceData: TraceData,
  eventRef: PersistedTraceEventRef | null
): TraceEvent | null {
  if (!eventRef) return null;

  return (
    normalizeTraceEvents(traceData).find(
      (event) =>
        event.name === eventRef.name &&
        event.ts === eventRef.ts &&
        (event.dur ?? 0) === (eventRef.dur ?? 0) &&
        event.pid === eventRef.pid &&
        event.tid === eventRef.tid &&
        event.ph === eventRef.ph
    ) ?? null
  );
}

function buildPersistedTracePanePayload(
  paneState: TracePaneState
): PersistedTracePanePayload | null {
  if (!paneState.traceData) return null;

  return {
    traceData: paneState.traceData,
    traceLoadedAt: paneState.traceLoadedAt,
    filename: paneState.filename,
    sources: paneState.sources,
  };
}

function buildPersistedTracePaneUiState(
  paneState: TracePaneState
): PersistedTracePaneUiState {
  return {
    hasTrace: paneState.traceData !== null,
    tool: paneState.tool,
    viewState: paneState.viewState,
    selectedEvent: toPersistedTraceEventRef(paneState.selectedEvent),
  };
}

function restoreTracePaneState(record: RestoredTracePaneRecord | null): TracePaneState {
  if (!record) return createEmptyTracePaneState();

  return {
    traceData: record.payload.traceData,
    traceLoadedAt: record.payload.traceLoadedAt,
    filename: record.payload.filename,
    sources: record.payload.sources ?? [],
    selectedEvent: findMatchingTraceEvent(record.payload.traceData, record.state.selectedEvent),
    tool: record.state.tool,
    viewState: record.state.viewState,
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function waitForFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    function nextFrame(remaining: number) {
      if (remaining <= 0) {
        resolve();
        return;
      }

      requestAnimationFrame(() => nextFrame(remaining - 1));
    }

    nextFrame(count);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getLoadTargetLabel(target: LoadTarget): string {
  if (target === "baseline") return "baseline run";
  if (target === "candidate") return "candidate run";
  return "current run";
}

function getRunLoadProgressPercent(progress: RunLoadProgress): number {
  const readFraction =
    progress.totalBytes > 0
      ? Math.min(1, progress.loadedBytes / progress.totalBytes)
      : progress.fileCount > 0
        ? progress.completedFiles / progress.fileCount
        : 0;

  if (progress.stage === "combining") {
    return Math.max(readFraction, 0.98);
  }

  if (progress.stage === "parsing") {
    return Math.max(readFraction, 0.95);
  }

  return readFraction;
}

function getRunLoadProgressMessage(progress: RunLoadProgress): string {
  if (progress.stage === "combining") {
    return `Combining ${progress.fileCount} trace files into one run`;
  }

  const fileNumber = Math.min(progress.currentFileIndex + 1, progress.fileCount);
  const filename = progress.currentFileName ?? `trace-${fileNumber}`;

  if (progress.stage === "parsing") {
    return `Parsing file ${fileNumber}/${progress.fileCount}: ${filename}`;
  }

  return `Reading file ${fileNumber}/${progress.fileCount}: ${filename}`;
}

function buildAttachedTraceSummary(trace: TraceSnapshot): AttachedTraceSummary {
  return {
    id: trace.id,
    label: trace.label,
    filename: trace.filename,
    loadedAt: trace.loadedAt,
    eventCount: trace.eventCount,
    bounds: {
      ...trace.bounds,
    },
  };
}

function normalizeCaptureRect(
  origin: CapturePoint | null,
  current: CapturePoint | null
): CaptureRect | null {
  if (!origin || !current) return null;

  const left = Math.min(origin.x, current.x);
  const top = Math.min(origin.y, current.y);
  const width = Math.abs(current.x - origin.x);
  const height = Math.abs(current.y - origin.y);

  return {
    left,
    top,
    width,
    height,
  };
}

function cloneAttachment(attachment: TraceChatAttachment): TraceChatAttachment {
  if (attachment.kind === "image") {
    return {
      ...attachment,
    };
  }

  return {
    ...attachment,
    trace: {
      ...attachment.trace,
      bounds: {
        ...attachment.trace.bounds,
      },
    },
    event: {
      ...attachment.event,
      args: attachment.event.args ? { ...attachment.event.args } : undefined,
    },
    inspection: JSON.parse(JSON.stringify(attachment.inspection)),
    rawEvent: JSON.parse(JSON.stringify(attachment.rawEvent)) as TraceEvent,
  };
}

function sanitizeAttachmentsForPersistence(
  attachments: TraceChatAttachment[] | undefined
): TraceChatAttachment[] | undefined {
  if (!attachments?.length) return undefined;

  const persistentAttachments = attachments
    .filter((attachment) => attachment.kind !== "image")
    .map(cloneAttachment);

  return persistentAttachments.length > 0 ? persistentAttachments : undefined;
}

function sanitizeMessageForPersistence(message: ChatPanelMessage): ChatPanelMessage {
  return {
    ...message,
    attachments: sanitizeAttachmentsForPersistence(message.attachments),
  };
}

function buildTimeBounds(traceData: TraceData | null): { min: number; max: number } {
  const events = normalizeTraceEvents(traceData);
  if (events.length === 0) {
    return { min: 0, max: 1_000_000 };
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const event of events) {
    min = Math.min(min, event.ts);
    max = Math.max(max, event.ts + (event.dur ?? 0));
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1_000_000 };
  }

  return { min, max };
}

function fitViewStateToBounds(bounds: { min: number; max: number }, paddingRatio: number): ViewState {
  const duration = Math.max(bounds.max - bounds.min, 1);
  const padding = duration * paddingRatio;

  return {
    startTime: bounds.min - padding,
    endTime: bounds.max + padding,
    scale: 1,
  };
}

function buildDefaultViewState(traceData: TraceData): ViewState {
  return fitViewStateToBounds(buildTimeBounds(traceData), 0.05);
}

function zoomViewState(viewState: ViewState, factor: number): ViewState {
  const center = (viewState.startTime + viewState.endTime) / 2;
  const duration = Math.max(viewState.endTime - viewState.startTime, 1);
  const nextDuration = Math.max(duration * factor, 1_000);

  return {
    startTime: center - nextDuration / 2,
    endTime: center + nextDuration / 2,
    scale: 1,
  };
}

function panViewState(viewState: ViewState, ratio: number): ViewState {
  const duration = viewState.endTime - viewState.startTime;
  const delta = duration * ratio;

  return {
    ...viewState,
    startTime: viewState.startTime + delta,
    endTime: viewState.endTime + delta,
  };
}

function isTraceRole(value: unknown): value is TraceRole {
  return value === "baseline" || value === "candidate";
}

function resolveTraceEventId(
  traceIndex: NonNullable<ReturnType<typeof buildTraceIndex>>,
  event: TraceEvent | null
): string | null {
  if (!event) return null;

  const directId = traceIndex.idByEvent.get(event);
  if (directId) return directId;

  const matchedEvent = traceIndex.events.find(
    (candidate) =>
      candidate.pid === event.pid &&
      candidate.tid === event.tid &&
      candidate.ts === event.ts &&
      candidate.dur === (event.dur ?? 0) &&
      candidate.ph === event.ph &&
      candidate.name === event.name
  );

  return matchedEvent?.id ?? null;
}

function extractGitHubMentions(message: string): {
  displayMessage: string;
  repoMentions: GitHubRepoMention[];
} {
  let displayMessage = "";
  let cursor = 0;
  const repoMentions: GitHubRepoMention[] = [];
  const seenUrls = new Set<string>();

  for (const match of message.matchAll(GITHUB_URL_REGEX)) {
    const rawUrl = match[0];
    const matchIndex = match.index ?? 0;
    const normalizedUrl = rawUrl.replace(/[),.;!?]+$/g, "");
    const trailingText = rawUrl.slice(normalizedUrl.length);

    displayMessage += message.slice(cursor, matchIndex);

    if (/^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+/i.test(normalizedUrl)) {
      displayMessage += buildGitHubRepoMentionToken(normalizedUrl) ?? `@[${normalizedUrl}]`;
      if (!seenUrls.has(normalizedUrl)) {
        seenUrls.add(normalizedUrl);
        repoMentions.push({
          id: createLocalId("repo"),
          url: normalizedUrl,
        });
      }
    } else {
      displayMessage += rawUrl;
    }

    displayMessage += trailingText;
    cursor = matchIndex + rawUrl.length;
  }

  displayMessage += message.slice(cursor);

  return {
    displayMessage,
    repoMentions,
  };
}

function mergeRepoMentions(
  existingMentions: GitHubRepoMention[],
  nextMentions: GitHubRepoMention[]
): GitHubRepoMention[] {
  const merged = [...existingMentions];
  const seenUrls = new Set(existingMentions.map((mention) => mention.url));

  for (const mention of nextMentions) {
    if (seenUrls.has(mention.url)) continue;
    seenUrls.add(mention.url);
    merged.push(mention);
  }

  return merged;
}

export function LupaApp({ chatEnabled, chatModel }: LupaAppProps) {
  const [isHydrated, setIsHydrated] = useState(false);
  const [mode, setMode] = useState<ViewerMode>("single");
  const [singleTrace, setSingleTrace] = useState<TracePaneState>(() => createEmptyTracePaneState());
  const [baselineTrace, setBaselineTrace] = useState<TracePaneState>(() =>
    createEmptyTracePaneState()
  );
  const [candidateTrace, setCandidateTrace] = useState<TracePaneState>(() =>
    createEmptyTracePaneState()
  );
  const [previousTraceSnapshot, setPreviousTraceSnapshot] = useState<TraceSnapshot | null>(null);
  const [baselineMetadata, setBaselineMetadata] = useState<TraceCompareMetadata>(() =>
    createCompareMetadata("Baseline")
  );
  const [candidateMetadata, setCandidateMetadata] = useState<TraceCompareMetadata>(() =>
    createCompareMetadata("Candidate")
  );
  const [normalizationMode, setNormalizationMode] =
    useState<TraceNormalizationMode>("total");
  const [searchQuery, setSearchQuery] = useState("");
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatPanelMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatErrorMessage, setChatErrorMessage] = useState<string | null>(null);
  const [chatResponseId, setChatResponseId] = useState<string | null>(null);
  const [attachedRepos, setAttachedRepos] = useState<GitHubRepoMention[]>([]);
  const [singleTimelineApi, setSingleTimelineApi] = useState<TimelineApi | null>(null);
  const [baselineTimelineApi, setBaselineTimelineApi] = useState<TimelineApi | null>(null);
  const [candidateTimelineApi, setCandidateTimelineApi] = useState<TimelineApi | null>(null);
  const [baselineEvidenceHighlight, setBaselineEvidenceHighlight] =
    useState<TimelineEvidenceHighlight | null>(null);
  const [candidateEvidenceHighlight, setCandidateEvidenceHighlight] =
    useState<TimelineEvidenceHighlight | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<TraceChatAttachment[]>([]);
  const [isCaptureMode, setIsCaptureMode] = useState(false);
  const [captureOrigin, setCaptureOrigin] = useState<CapturePoint | null>(null);
  const [captureCurrent, setCaptureCurrent] = useState<CapturePoint | null>(null);
  const [runLoadProgress, setRunLoadProgress] = useState<RunLoadProgress | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadTargetRef = useRef<LoadTarget>("single");
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const hasRestoredPersistentChatRef = useRef(false);

  const singleNormalized = useMemo(
    () => normalizeTraceEvents(singleTrace.traceData),
    [singleTrace.traceData]
  );
  const baselineNormalized = useMemo(
    () => normalizeTraceEvents(baselineTrace.traceData),
    [baselineTrace.traceData]
  );
  const candidateNormalized = useMemo(
    () => normalizeTraceEvents(candidateTrace.traceData),
    [candidateTrace.traceData]
  );

  const singleProcesses = useMemo(
    () => buildProcessMap(singleTrace.traceData, singleNormalized),
    [singleTrace.traceData, singleNormalized]
  );
  const baselineProcesses = useMemo(
    () => buildProcessMap(baselineTrace.traceData, baselineNormalized),
    [baselineTrace.traceData, baselineNormalized]
  );
  const candidateProcesses = useMemo(
    () => buildProcessMap(candidateTrace.traceData, candidateNormalized),
    [candidateTrace.traceData, candidateNormalized]
  );

  useEffect(() => {
    if (typeof window === "undefined" || hasRestoredPersistentChatRef.current) return;

    let cancelled = false;

    const restorePersistedState = async () => {
      try {
        const rawSession = localStorage.getItem(TRACE_AGENT_CHAT_STORAGE_KEY);
        if (rawSession) {
          const parsed = JSON.parse(rawSession) as PersistedChatSession;
          if (!cancelled && Array.isArray(parsed.messages)) {
            setChatMessages(parsed.messages);
          }
          if (!cancelled && (typeof parsed.responseId === "string" || parsed.responseId === null)) {
            setChatResponseId(parsed.responseId);
          }
          if (!cancelled && Array.isArray(parsed.repoMentions)) {
            setAttachedRepos(parsed.repoMentions);
          }
        }
      } catch {
        // Ignore malformed persisted chat state.
      }

      try {
        const rawTraceSnapshot = localStorage.getItem(TRACE_AGENT_TRACE_STORAGE_KEY);
        if (!cancelled && rawTraceSnapshot) {
          setPreviousTraceSnapshot(JSON.parse(rawTraceSnapshot) as TraceSnapshot);
        }
      } catch {
        // Ignore malformed persisted trace state.
      }

      try {
        const persistedTraceSession = await loadPersistedTraceSession();
        if (!cancelled && persistedTraceSession) {
          setMode(persistedTraceSession.mode);
          setNormalizationMode(persistedTraceSession.normalizationMode);
          setSingleTrace(restoreTracePaneState(persistedTraceSession.single));
          setBaselineTrace(restoreTracePaneState(persistedTraceSession.baseline));
          setCandidateTrace(restoreTracePaneState(persistedTraceSession.candidate));
        }
      } catch {
        // Ignore malformed persisted trace state.
      } finally {
        if (!cancelled) {
          hasRestoredPersistentChatRef.current = true;
          setIsHydrated(true);
        }
      }
    };

    void restorePersistedState();

    return () => {
      cancelled = true;
    };
  }, []);

  const singleBaseIndex = useMemo(
    () => buildTraceIndex(singleTrace.traceData, singleProcesses),
    [singleProcesses, singleTrace.traceData]
  );
  const baselineBaseIndex = useMemo(
    () => buildTraceIndex(baselineTrace.traceData, baselineProcesses),
    [baselineProcesses, baselineTrace.traceData]
  );
  const candidateBaseIndex = useMemo(
    () => buildTraceIndex(candidateTrace.traceData, candidateProcesses),
    [candidateProcesses, candidateTrace.traceData]
  );

  const [singleAnomalies, setSingleAnomalies] = useState<TraceAnomaly[]>([]);
  const [baselineAnomalies, setBaselineAnomalies] = useState<TraceAnomaly[]>([]);
  const [candidateAnomalies, setCandidateAnomalies] = useState<TraceAnomaly[]>([]);

  useEffect(() => {
    if (!singleBaseIndex) { setSingleAnomalies([]); return; }
    const handle = requestIdleCallback(() => setSingleAnomalies(buildTraceAnomalies(singleBaseIndex)));
    return () => cancelIdleCallback(handle);
  }, [singleBaseIndex]);

  useEffect(() => {
    if (!baselineBaseIndex) { setBaselineAnomalies([]); return; }
    const handle = requestIdleCallback(() => setBaselineAnomalies(buildTraceAnomalies(baselineBaseIndex)));
    return () => cancelIdleCallback(handle);
  }, [baselineBaseIndex]);

  useEffect(() => {
    if (!candidateBaseIndex) { setCandidateAnomalies([]); return; }
    const handle = requestIdleCallback(() => setCandidateAnomalies(buildTraceAnomalies(candidateBaseIndex)));
    return () => cancelIdleCallback(handle);
  }, [candidateBaseIndex]);

  const singleTraceIndex = useMemo(() => {
    if (!singleBaseIndex) return null;
    if (singleAnomalies.length === 0) return singleBaseIndex;
    return { ...singleBaseIndex, anomalies: singleAnomalies, anomalyById: new Map(singleAnomalies.map((a) => [a.id, a])) };
  }, [singleBaseIndex, singleAnomalies]);

  const baselineTraceIndex = useMemo(() => {
    if (!baselineBaseIndex) return null;
    if (baselineAnomalies.length === 0) return baselineBaseIndex;
    return { ...baselineBaseIndex, anomalies: baselineAnomalies, anomalyById: new Map(baselineAnomalies.map((a) => [a.id, a])) };
  }, [baselineBaseIndex, baselineAnomalies]);

  const candidateTraceIndex = useMemo(() => {
    if (!candidateBaseIndex) return null;
    if (candidateAnomalies.length === 0) return candidateBaseIndex;
    return { ...candidateBaseIndex, anomalies: candidateAnomalies, anomalyById: new Map(candidateAnomalies.map((a) => [a.id, a])) };
  }, [candidateBaseIndex, candidateAnomalies]);

  const singleTraceSnapshot = useMemo(() => {
    if (!singleTrace.traceData || !singleTraceIndex) return null;

    return buildTraceSnapshot(singleTrace.traceData, singleTraceIndex, {
      label: singleTrace.filename ?? "Current run",
      filename: singleTrace.filename,
      loadedAt: singleTrace.traceLoadedAt ?? undefined,
      sources: singleTrace.sources,
    });
  }, [
    singleTrace.filename,
    singleTrace.sources,
    singleTrace.traceData,
    singleTrace.traceLoadedAt,
    singleTraceIndex,
  ]);

  const baselineTraceSnapshot = useMemo(() => {
    if (!baselineTrace.traceData || !baselineTraceIndex) return null;

    return buildTraceSnapshot(baselineTrace.traceData, baselineTraceIndex, {
      label: baselineTrace.filename ?? "Baseline run",
      filename: baselineTrace.filename,
      loadedAt: baselineTrace.traceLoadedAt ?? undefined,
      sources: baselineTrace.sources,
    });
  }, [
    baselineTrace.filename,
    baselineTrace.sources,
    baselineTrace.traceData,
    baselineTrace.traceLoadedAt,
    baselineTraceIndex,
  ]);

  const candidateTraceSnapshot = useMemo(() => {
    if (!candidateTrace.traceData || !candidateTraceIndex) return null;

    return buildTraceSnapshot(candidateTrace.traceData, candidateTraceIndex, {
      label: candidateTrace.filename ?? "Candidate run",
      filename: candidateTrace.filename,
      loadedAt: candidateTrace.traceLoadedAt ?? undefined,
      sources: candidateTrace.sources,
    });
  }, [
    candidateTrace.filename,
    candidateTrace.sources,
    candidateTrace.traceData,
    candidateTrace.traceLoadedAt,
    candidateTraceIndex,
  ]);

  const baselineCompareMetadata = useMemo<TraceCompareMetadata>(
    () => ({
      ...baselineMetadata,
      traceId: baselineTraceSnapshot?.id ?? baselineMetadata.traceId,
      label: baselineTraceSnapshot?.label ?? baselineMetadata.label,
    }),
    [baselineMetadata, baselineTraceSnapshot]
  );

  const candidateCompareMetadata = useMemo<TraceCompareMetadata>(
    () => ({
      ...candidateMetadata,
      traceId: candidateTraceSnapshot?.id ?? candidateMetadata.traceId,
      label: candidateTraceSnapshot?.label ?? candidateMetadata.label,
    }),
    [candidateMetadata, candidateTraceSnapshot]
  );

  const singleSelectedEventId = useMemo(() => {
    if (!singleTrace.selectedEvent || !singleTraceIndex) return null;
    return resolveTraceEventId(singleTraceIndex, singleTrace.selectedEvent);
  }, [singleTrace.selectedEvent, singleTraceIndex]);

  const baselineSelectedEventId = useMemo(() => {
    if (!baselineTrace.selectedEvent || !baselineTraceIndex) return null;
    return resolveTraceEventId(baselineTraceIndex, baselineTrace.selectedEvent);
  }, [baselineTrace.selectedEvent, baselineTraceIndex]);

  const candidateSelectedEventId = useMemo(() => {
    if (!candidateTrace.selectedEvent || !candidateTraceIndex) return null;
    return resolveTraceEventId(candidateTraceIndex, candidateTrace.selectedEvent);
  }, [candidateTrace.selectedEvent, candidateTraceIndex]);

  const singleViewSummary = useMemo(() => {
    if (!singleTraceIndex) return null;
    return buildViewportSummary(singleTraceIndex, {
      viewState: singleTrace.viewState,
      selectedEventId: singleSelectedEventId,
      searchQuery,
    });
  }, [searchQuery, singleSelectedEventId, singleTrace.viewState, singleTraceIndex]);

  const baselineViewSummary = useMemo(() => {
    if (!baselineTraceIndex) return null;
    return buildViewportSummary(baselineTraceIndex, {
      viewState: baselineTrace.viewState,
      selectedEventId: baselineSelectedEventId,
      searchQuery,
    });
  }, [baselineSelectedEventId, baselineTrace.viewState, baselineTraceIndex, searchQuery]);

  const candidateViewSummary = useMemo(() => {
    if (!candidateTraceIndex) return null;
    return buildViewportSummary(candidateTraceIndex, {
      viewState: candidateTrace.viewState,
      selectedEventId: candidateSelectedEventId,
      searchQuery,
    });
  }, [candidateSelectedEventId, candidateTrace.viewState, candidateTraceIndex, searchQuery]);

  const comparisonToPrevious = useMemo(
    () => buildTraceDiffSummary(previousTraceSnapshot, singleTraceSnapshot),
    [previousTraceSnapshot, singleTraceSnapshot]
  );

  const deepCompareReport = useMemo(
    () =>
      buildTraceCompareReport({
        baselineTrace:
          baselineTraceSnapshot && baselineTraceIndex
            ? {
                role: "baseline",
                snapshot: baselineTraceSnapshot,
                index: baselineTraceIndex,
                metadata: baselineCompareMetadata,
              }
            : null,
        candidateTrace:
          candidateTraceSnapshot && candidateTraceIndex
            ? {
                role: "candidate",
                snapshot: candidateTraceSnapshot,
                index: candidateTraceIndex,
                metadata: candidateCompareMetadata,
              }
            : null,
        normalizationMode,
      }),
    [
      baselineCompareMetadata,
      baselineTraceIndex,
      baselineTraceSnapshot,
      candidateCompareMetadata,
      candidateTraceIndex,
      candidateTraceSnapshot,
      normalizationMode,
    ]
  );

  const chatContext = useMemo<TraceChatContext>(() => {
    if (mode === "deep") {
      return {
        currentTrace: candidateTraceSnapshot,
        previousTrace: baselineTraceSnapshot,
        currentView: candidateViewSummary,
        comparisonToPrevious: buildTraceDiffSummary(
          baselineTraceSnapshot,
          candidateTraceSnapshot
        ),
        deepCompare: {
          enabled: true,
          baselineTrace: baselineTraceSnapshot,
          candidateTrace: candidateTraceSnapshot,
          baselineView: baselineViewSummary,
          candidateView: candidateViewSummary,
          metadata: {
            baseline: baselineTraceSnapshot ? baselineCompareMetadata : null,
            candidate: candidateTraceSnapshot ? candidateCompareMetadata : null,
          },
          normalizationMode,
          report: deepCompareReport,
        },
      };
    }

    return {
      currentTrace: singleTraceSnapshot,
      previousTrace: previousTraceSnapshot,
      currentView: singleViewSummary,
      comparisonToPrevious,
      deepCompare: null,
    };
  }, [
    baselineCompareMetadata,
    baselineTraceSnapshot,
    baselineViewSummary,
    candidateCompareMetadata,
    candidateTraceSnapshot,
    candidateViewSummary,
    comparisonToPrevious,
    deepCompareReport,
    mode,
    normalizationMode,
    previousTraceSnapshot,
    singleTraceSnapshot,
    singleViewSummary,
  ]);

  const singleTimeBounds = useMemo(
    () => buildTimeBounds(singleTrace.traceData),
    [singleTrace.traceData]
  );
  const baselineTimeBounds = useMemo(
    () => buildTimeBounds(baselineTrace.traceData),
    [baselineTrace.traceData]
  );
  const candidateTimeBounds = useMemo(
    () => buildTimeBounds(candidateTrace.traceData),
    [candidateTrace.traceData]
  );

  const captureRect = useMemo(
    () => normalizeCaptureRect(captureOrigin, captureCurrent),
    [captureCurrent, captureOrigin]
  );
  const singlePersistedPayload = useMemo(
    () => buildPersistedTracePanePayload(singleTrace),
    [singleTrace]
  );
  const baselinePersistedPayload = useMemo(
    () => buildPersistedTracePanePayload(baselineTrace),
    [baselineTrace]
  );
  const candidatePersistedPayload = useMemo(
    () => buildPersistedTracePanePayload(candidateTrace),
    [candidateTrace]
  );
  const singlePersistedUiState = useMemo(
    () => buildPersistedTracePaneUiState(singleTrace),
    [singleTrace]
  );
  const baselinePersistedUiState = useMemo(
    () => buildPersistedTracePaneUiState(baselineTrace),
    [baselineTrace]
  );
  const candidatePersistedUiState = useMemo(
    () => buildPersistedTracePaneUiState(candidateTrace),
    [candidateTrace]
  );

  const addToolMessage = useCallback((content: string) => {
    setChatMessages((previousMessages) => [
      ...previousMessages,
      {
        id: createLocalId("tool"),
        role: "tool",
        content,
      },
    ]);
  }, []);

  const buildRuntimeChatContext = useCallback(
    (runtime: ToolExecutionRuntime): TraceChatContext => {
      if (runtime.mode === "deep") {
        const baselineView =
          baselineTraceIndex != null
            ? buildViewportSummary(baselineTraceIndex, {
                viewState: runtime.baseline.viewState,
                selectedEventId: resolveTraceEventId(
                  baselineTraceIndex,
                  runtime.baseline.selectedEvent
                ),
                searchQuery,
              })
            : null;
        const candidateView =
          candidateTraceIndex != null
            ? buildViewportSummary(candidateTraceIndex, {
                viewState: runtime.candidate.viewState,
                selectedEventId: resolveTraceEventId(
                  candidateTraceIndex,
                  runtime.candidate.selectedEvent
                ),
                searchQuery,
              })
            : null;

        return {
          currentTrace: candidateTraceSnapshot,
          previousTrace: baselineTraceSnapshot,
          currentView: candidateView,
          comparisonToPrevious: buildTraceDiffSummary(
            baselineTraceSnapshot,
            candidateTraceSnapshot
          ),
          deepCompare: {
            enabled: true,
            baselineTrace: baselineTraceSnapshot,
            candidateTrace: candidateTraceSnapshot,
            baselineView,
            candidateView,
            metadata: {
              baseline: baselineTraceSnapshot ? baselineCompareMetadata : null,
              candidate: candidateTraceSnapshot ? candidateCompareMetadata : null,
            },
            normalizationMode,
            report: deepCompareReport,
          },
        };
      }

      if (!singleTraceIndex) {
        return {
          currentTrace: singleTraceSnapshot,
          previousTrace: previousTraceSnapshot,
          currentView: null,
          comparisonToPrevious,
          deepCompare: null,
        };
      }

      return {
        currentTrace: singleTraceSnapshot,
        previousTrace: previousTraceSnapshot,
        currentView: buildViewportSummary(singleTraceIndex, {
          viewState: runtime.single.viewState,
          selectedEventId: resolveTraceEventId(singleTraceIndex, runtime.single.selectedEvent),
          searchQuery,
        }),
        comparisonToPrevious: buildTraceDiffSummary(
          previousTraceSnapshot,
          singleTraceSnapshot
        ),
        deepCompare: null,
      };
    },
    [
      baselineCompareMetadata,
      baselineTraceIndex,
      baselineTraceSnapshot,
      candidateCompareMetadata,
      candidateTraceIndex,
      candidateTraceSnapshot,
      comparisonToPrevious,
      deepCompareReport,
      normalizationMode,
      previousTraceSnapshot,
      searchQuery,
      singleTraceIndex,
      singleTraceSnapshot,
    ]
  );

  const handleOpenFilePicker = useCallback((target: LoadTarget) => {
    loadTargetRef.current = target;
    fileInputRef.current?.click();
  }, []);

  const loadTraceRun = useCallback(
    (
      target: LoadTarget,
      combinedRun: ReturnType<typeof finalizeTraceRunBuilder>
    ) => {
      if (!combinedRun) return;

      const loadedAt = new Date().toISOString();
      const nextViewState = buildDefaultViewState(combinedRun.traceData);
      const sourceCount = combinedRun.sources.length;
      const label =
        combinedRun.displayName ??
        (target === "baseline"
          ? "Baseline run"
          : target === "candidate"
            ? "Candidate run"
            : "Current run");
      const loadSummary =
        sourceCount === 1
          ? label
          : `${label} (${sourceCount} trace files)`;

      setIsCaptureMode(false);
      setCaptureOrigin(null);
      setCaptureCurrent(null);

      if (target === "single") {
        setBaselineEvidenceHighlight(null);
        setCandidateEvidenceHighlight(null);
        const preservedPrevious = singleTraceSnapshot ?? previousTraceSnapshot;
        if (singleTraceSnapshot) {
          setPreviousTraceSnapshot(singleTraceSnapshot);
        }

        setSingleTrace((previousState) => ({
          ...previousState,
          traceData: combinedRun.traceData,
          traceLoadedAt: loadedAt,
          filename: label,
          sources: combinedRun.sources,
          selectedEvent: null,
          viewState: nextViewState,
        }));
        setSingleTimelineApi(null);
        addToolMessage(
          preservedPrevious
            ? `Loaded ${loadSummary}. Previous run "${preservedPrevious.label}" is still available for comparison.`
            : `Loaded ${loadSummary}.`
        );
        return;
      }

      setMode("deep");

      if (target === "baseline") {
        setBaselineEvidenceHighlight(null);
        setBaselineTrace((previousState) => ({
          ...previousState,
          traceData: combinedRun.traceData,
          traceLoadedAt: loadedAt,
          filename: label,
          sources: combinedRun.sources,
          selectedEvent: null,
          viewState: nextViewState,
        }));
        setBaselineTimelineApi(null);
        setBaselineMetadata((previousMetadata) => ({
          ...previousMetadata,
          traceId: `${loadedAt}:${label}`,
          label,
        }));
        addToolMessage(`Loaded ${loadSummary} as the Deep Mode baseline.`);
        return;
      }

      setCandidateEvidenceHighlight(null);
      setCandidateTrace((previousState) => ({
        ...previousState,
        traceData: combinedRun.traceData,
        traceLoadedAt: loadedAt,
        filename: label,
        sources: combinedRun.sources,
        selectedEvent: null,
        viewState: nextViewState,
      }));
      setCandidateTimelineApi(null);
      setCandidateMetadata((previousMetadata) => ({
        ...previousMetadata,
        traceId: `${loadedAt}:${label}`,
        label,
      }));
      addToolMessage(`Loaded ${loadSummary} as the Deep Mode candidate.`);
    },
    [addToolMessage, previousTraceSnapshot, singleTraceSnapshot]
  );

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      if (files.length === 0) return;
      const target = loadTargetRef.current;
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      event.target.value = "";

      try {
        const builder = createTraceRunBuilder();
        let completedBytes = 0;

        setRunLoadProgress({
          target,
          stage: "reading",
          fileCount: files.length,
          completedFiles: 0,
          currentFileIndex: 0,
          currentFileName: files[0]?.name ?? null,
          totalBytes,
          loadedBytes: 0,
        });
        await waitForFrames(1);

        for (const [index, file] of files.entries()) {
          setRunLoadProgress({
            target,
            stage: "reading",
            fileCount: files.length,
            completedFiles: index,
            currentFileIndex: index,
            currentFileName: file.name,
            totalBytes,
            loadedBytes: completedBytes,
          });
          await waitForFrames(1);

          let input: TraceRunInput;
          try {
            input = await parseTraceFile(file, (bytesRead) => {
              setRunLoadProgress((prev) =>
                prev
                  ? {
                      ...prev,
                      stage: "reading",
                      currentFileIndex: index,
                      currentFileName: file.name,
                      loadedBytes: completedBytes + bytesRead,
                    }
                  : prev
              );
            });
          } catch (error) {
            throw new Error(
              error instanceof Error
                ? error.message
                : `Failed to parse ${file.name}. Make sure it is valid JSON.`
            );
          }

          appendTraceRunSource(builder, input, index);
          completedBytes += file.size;
        }

        setRunLoadProgress({
          target,
          stage: "combining",
          fileCount: files.length,
          completedFiles: files.length,
          currentFileIndex: files.length - 1,
          currentFileName: null,
          totalBytes,
          loadedBytes: completedBytes,
        });
        await waitForFrames(1);

        loadTraceRun(
          target,
          finalizeTraceRunBuilder(
            builder,
            target === "baseline"
              ? "Baseline run"
              : target === "candidate"
                ? "Candidate run"
                : "Current run"
          )
        );
        setRunLoadProgress(null);
      } catch (error) {
        setRunLoadProgress(null);
        alert(error instanceof Error ? error.message : "Failed to parse trace files.");
      }
    },
    [loadTraceRun]
  );

  const cancelAreaCapture = useCallback(() => {
    setIsCaptureMode(false);
    setCaptureOrigin(null);
    setCaptureCurrent(null);
  }, []);

  const clampPointToWorkspace = useCallback((clientX: number, clientY: number) => {
    const workspaceBounds = workspaceRef.current?.getBoundingClientRect();
    if (!workspaceBounds) return null;

    return {
      x: Math.max(0, Math.min(workspaceBounds.width, clientX - workspaceBounds.left)),
      y: Math.max(0, Math.min(workspaceBounds.height, clientY - workspaceBounds.top)),
    };
  }, []);

  const attachAreaCapture = useCallback(
    async (selection: CaptureRect) => {
      if (!workspaceRef.current) {
        throw new Error("Trace workspace is unavailable for capture.");
      }

      const workspaceBounds = workspaceRef.current.getBoundingClientRect();
      const snapshotCanvas = await toCanvas(workspaceRef.current, {
        cacheBust: true,
        backgroundColor: "#ffffff",
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      });

      const scaleX = snapshotCanvas.width / Math.max(workspaceBounds.width, 1);
      const scaleY = snapshotCanvas.height / Math.max(workspaceBounds.height, 1);
      const sourceX = Math.max(0, Math.floor(selection.left * scaleX));
      const sourceY = Math.max(0, Math.floor(selection.top * scaleY));
      const sourceWidth = Math.max(
        1,
        Math.min(snapshotCanvas.width - sourceX, Math.ceil(selection.width * scaleX))
      );
      const sourceHeight = Math.max(
        1,
        Math.min(snapshotCanvas.height - sourceY, Math.ceil(selection.height * scaleY))
      );

      const croppedCanvas = document.createElement("canvas");
      croppedCanvas.width = sourceWidth;
      croppedCanvas.height = sourceHeight;

      const context = croppedCanvas.getContext("2d");
      if (!context) {
        throw new Error("Failed to create screenshot canvas.");
      }

      context.drawImage(
        snapshotCanvas,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight
      );

      const createdAt = new Date().toISOString();
      setPendingAttachments((previousAttachments) => {
        const imageCount = previousAttachments.filter(
          (attachment) => attachment.kind === "image"
        ).length;

        return [
          ...previousAttachments,
          {
            id: createLocalId("image"),
            kind: "image",
            source: "manual_capture",
            label: `Trace capture ${imageCount + 1}`,
            createdAt,
            traceId:
              mode === "deep"
                ? candidateTraceSnapshot?.id ?? baselineTraceSnapshot?.id ?? null
                : singleTraceSnapshot?.id ?? null,
            traceLabel:
              mode === "deep"
                ? candidateTraceSnapshot?.label ?? baselineTraceSnapshot?.label ?? null
                : singleTraceSnapshot?.label ?? null,
            imageDataUrl: croppedCanvas.toDataURL("image/png"),
            mimeType: "image/png",
            width: sourceWidth,
            height: sourceHeight,
          },
        ];
      });
      setChatErrorMessage(null);
    },
    [baselineTraceSnapshot, candidateTraceSnapshot, mode, singleTraceSnapshot]
  );

  const handleStartAreaCapture = useCallback(() => {
    setChatErrorMessage(null);
    setIsCaptureMode(true);
    setCaptureOrigin(null);
    setCaptureCurrent(null);
  }, []);

  const handleCapturePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const point = clampPointToWorkspace(event.clientX, event.clientY);
      if (!point) return;

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setCaptureOrigin(point);
      setCaptureCurrent(point);
    },
    [clampPointToWorkspace]
  );

  const handleCapturePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!captureOrigin) return;
      const point = clampPointToWorkspace(event.clientX, event.clientY);
      if (!point) return;

      setCaptureCurrent(point);
    },
    [captureOrigin, clampPointToWorkspace]
  );

  const handleCapturePointerUp = useCallback(
    async (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const selection = normalizeCaptureRect(captureOrigin, captureCurrent);
      cancelAreaCapture();

      if (
        !selection ||
        selection.width < MIN_CAPTURE_SIZE_PX ||
        selection.height < MIN_CAPTURE_SIZE_PX
      ) {
        setChatErrorMessage("Select a larger area to attach a screenshot.");
        return;
      }

      try {
        await attachAreaCapture(selection);
      } catch (error) {
        setChatErrorMessage(
          error instanceof Error ? error.message : "Failed to capture the selected area."
        );
      }
    },
    [attachAreaCapture, cancelAreaCapture, captureCurrent, captureOrigin]
  );

  const handleRemoveAttachment = useCallback((attachmentId: string) => {
    setPendingAttachments((previousAttachments) =>
      previousAttachments.filter((attachment) => attachment.id !== attachmentId)
    );
  }, []);

  const attachSelectionFromTarget = useCallback(
    (target: RuntimeTargetKey) => {
      const traceIndex =
        target === "single"
          ? singleTraceIndex
          : target === "baseline"
            ? baselineTraceIndex
            : candidateTraceIndex;
      const selectedEvent =
        target === "single"
          ? singleTrace.selectedEvent
          : target === "baseline"
            ? baselineTrace.selectedEvent
            : candidateTrace.selectedEvent;
      const snapshot =
        target === "single"
          ? singleTraceSnapshot
          : target === "baseline"
            ? baselineTraceSnapshot
            : candidateTraceSnapshot;

      if (!selectedEvent || !traceIndex || !snapshot) {
        setChatErrorMessage("Select a span before attaching it to chat.");
        return;
      }

      const eventId = resolveTraceEventId(traceIndex, selectedEvent);
      if (!eventId) {
        setChatErrorMessage("The selected span is no longer available.");
        return;
      }

      const inspection = inspectTraceEvent(traceIndex, eventId);
      if (!inspection) {
        setChatErrorMessage("The selected span could not be inspected.");
        return;
      }

      const nextAttachment: TraceChatSelectionAttachment = {
        id: createLocalId("selection"),
        kind: "selection",
        source: "selection_details",
        label: inspection.event.name,
        createdAt: new Date().toISOString(),
        traceId: snapshot.id,
        traceLabel: snapshot.label,
        fingerprint: [
          snapshot.id,
          eventId,
          inspection.event.ts,
          inspection.event.dur,
          inspection.event.pid,
          inspection.event.tid,
        ].join(":"),
        trace: buildAttachedTraceSummary(snapshot),
        event: inspection.event,
        inspection,
        rawEvent: JSON.parse(JSON.stringify(selectedEvent)) as TraceEvent,
      };

      setPendingAttachments((previousAttachments) => [
        ...previousAttachments,
        nextAttachment,
      ]);
      setChatErrorMessage(null);
    },
    [
      baselineTrace.selectedEvent,
      baselineTraceIndex,
      baselineTraceSnapshot,
      candidateTrace.selectedEvent,
      candidateTraceIndex,
      candidateTraceSnapshot,
      singleTrace.selectedEvent,
      singleTraceIndex,
      singleTraceSnapshot,
    ]
  );

  const focusLiveCompareRegion = useCallback(
    (traceRole: TraceRole, startTime: number, endTime: number, eventIds: string[]) => {
      const duration = Math.max(endTime - startTime, 1_000);
      const padding = Math.max(duration * 0.25, 10_000);
      const nextViewState = {
        startTime: startTime - padding,
        endTime: endTime + padding,
        scale: 1,
      };

      if (traceRole === "baseline") {
        const event = eventIds[0]
          ? baselineTraceIndex?.eventById.get(eventIds[0])?.event ?? null
          : null;
        setBaselineTrace((previousState) => ({
          ...previousState,
          selectedEvent: event,
          viewState: nextViewState,
        }));
        return;
      }

      const event = eventIds[0]
        ? candidateTraceIndex?.eventById.get(eventIds[0])?.event ?? null
        : null;
      setCandidateTrace((previousState) => ({
        ...previousState,
        selectedEvent: event,
        viewState: nextViewState,
      }));
    },
    [baselineTraceIndex, candidateTraceIndex]
  );

  const handleFocusCompareFinding = useCallback(
    (findingId: string) => {
      const finding = findCompareFinding(deepCompareReport, findingId);
      if (!finding) return;

      let nextBaselineHighlight: TimelineEvidenceHighlight | null = null;
      let nextCandidateHighlight: TimelineEvidenceHighlight | null = null;
      const seenRoles = new Set<TraceRole>();

      for (const region of finding.evidence) {
        if (seenRoles.has(region.traceRole)) continue;
        seenRoles.add(region.traceRole);

        const targetIndex =
          region.traceRole === "baseline" ? baselineTraceIndex : candidateTraceIndex;
        const targetEvent =
          region.eventIds[0] && targetIndex
            ? targetIndex.eventById.get(region.eventIds[0])?.event ?? null
            : null;
        const nextHighlight: TimelineEvidenceHighlight = {
          id: createLocalId(`evidence-${region.traceRole}`),
          title: region.title,
          description: region.description,
          startTime: region.startTime,
          endTime: region.endTime,
          processName: region.processName,
          threadName: region.threadName,
          event: targetEvent,
        };

        if (region.traceRole === "baseline") {
          nextBaselineHighlight = nextHighlight;
        } else {
          nextCandidateHighlight = nextHighlight;
        }

        focusLiveCompareRegion(
          region.traceRole,
          region.startTime,
          region.endTime,
          region.eventIds
        );
      }

      setBaselineEvidenceHighlight(nextBaselineHighlight);
      setCandidateEvidenceHighlight(nextCandidateHighlight);
    },
    [baselineTraceIndex, candidateTraceIndex, deepCompareReport, focusLiveCompareRegion]
  );

  const handleZoomIn = useCallback(() => {
    setSingleTrace((previousState) => ({
      ...previousState,
      viewState: zoomViewState(previousState.viewState, 1 / 1.5),
    }));
  }, []);

  const handleZoomOut = useCallback(() => {
    setSingleTrace((previousState) => ({
      ...previousState,
      viewState: zoomViewState(previousState.viewState, 1.5),
    }));
  }, []);

  const handleResetView = useCallback(() => {
    setSingleTrace((previousState) => ({
      ...previousState,
      viewState: fitViewStateToBounds(singleTimeBounds, 0.05),
    }));
  }, [singleTimeBounds]);

  const handleFitToWindow = useCallback(() => {
    setSingleTrace((previousState) => ({
      ...previousState,
      viewState: fitViewStateToBounds(singleTimeBounds, 0.02),
    }));
  }, [singleTimeBounds]);

  const handlePanLeft = useCallback(() => {
    const setter = mode === "deep" ? setCandidateTrace : setSingleTrace;
    setter((previousState) => ({
      ...previousState,
      viewState: panViewState(previousState.viewState, -0.2),
    }));
  }, [mode]);

  const handlePanRight = useCallback(() => {
    const setter = mode === "deep" ? setCandidateTrace : setSingleTrace;
    setter((previousState) => ({
      ...previousState,
      viewState: panViewState(previousState.viewState, 0.2),
    }));
  }, [mode]);

  const handleSelectTool = useCallback(() => {
    if (mode === "deep") {
      setCandidateTrace((previousState) => ({
        ...previousState,
        tool: "select",
      }));
      return;
    }

    setSingleTrace((previousState) => ({
      ...previousState,
      tool: "select",
    }));
  }, [mode]);

  const handlePanTool = useCallback(() => {
    if (mode === "deep") {
      setCandidateTrace((previousState) => ({
        ...previousState,
        tool: "pan",
      }));
      return;
    }

    setSingleTrace((previousState) => ({
      ...previousState,
      tool: "pan",
    }));
  }, [mode]);

  const handleClearSelection = useCallback(() => {
    if (mode === "deep") {
      setBaselineTrace((previousState) => ({
        ...previousState,
        selectedEvent: null,
      }));
      setCandidateTrace((previousState) => ({
        ...previousState,
        selectedEvent: null,
      }));
      return;
    }

    setSingleTrace((previousState) => ({
      ...previousState,
      selectedEvent: null,
    }));
  }, [mode]);

  const handleOpenCommandPalette = useCallback(() => {
    setIsCommandPaletteOpen(true);
  }, []);

  const captureCurrentScreenshot = useCallback(async (): Promise<string | null> => {
    if (mode === "single") {
      return singleTimelineApi?.captureImage() ?? null;
    }

    if (!workspaceRef.current) return null;

    const canvas = await toCanvas(workspaceRef.current, {
      cacheBust: true,
      backgroundColor: "#ffffff",
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    });

    return canvas.toDataURL("image/png");
  }, [mode, singleTimelineApi]);

  const handleExportCompareReport = useCallback(() => {
    if (!deepCompareReport) return;

    const blob = new Blob([buildTraceCompareReportExport(deepCompareReport)], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${
      baselineTrace.filename ?? baselineCompareMetadata.label
    }-vs-${candidateTrace.filename ?? candidateCompareMetadata.label}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [
    baselineCompareMetadata.label,
    baselineTrace.filename,
    candidateCompareMetadata.label,
    candidateTrace.filename,
    deepCompareReport,
  ]);

  const handleClearHistory = useCallback(() => {
    setChatMessages([]);
    setChatErrorMessage(null);
    setChatResponseId(null);
    setPendingAttachments([]);
    setAttachedRepos([]);

    if (typeof window !== "undefined") {
      localStorage.removeItem(TRACE_AGENT_CHAT_STORAGE_KEY);
    }
  }, []);

  const handleClearSavedTraces = useCallback(() => {
    setMode("single");
    setNormalizationMode("total");
    setSingleTrace(createEmptyTracePaneState());
    setBaselineTrace(createEmptyTracePaneState());
    setCandidateTrace(createEmptyTracePaneState());
    setPreviousTraceSnapshot(null);
    setBaselineMetadata(createCompareMetadata("Baseline"));
    setCandidateMetadata(createCompareMetadata("Candidate"));
    setSingleTimelineApi(null);
    setBaselineTimelineApi(null);
    setCandidateTimelineApi(null);
    setBaselineEvidenceHighlight(null);
    setCandidateEvidenceHighlight(null);
    setPendingAttachments([]);
    setSearchQuery("");
    cancelAreaCapture();

    if (typeof window !== "undefined") {
      localStorage.removeItem(TRACE_AGENT_TRACE_STORAGE_KEY);
    }

    void clearPersistedTraceSession().catch(() => {
      // Ignore client-side persistence failures.
    });
  }, [cancelAreaCapture]);

  useEffect(() => {
    if (typeof window === "undefined" || !hasRestoredPersistentChatRef.current) return;

    if (chatMessages.length === 0 && !chatResponseId) {
      localStorage.removeItem(TRACE_AGENT_CHAT_STORAGE_KEY);
      return;
    }

    const session: PersistedChatSession = {
      messages: chatMessages.map(sanitizeMessageForPersistence),
      responseId: chatResponseId,
      repoMentions: attachedRepos,
    };

    localStorage.setItem(TRACE_AGENT_CHAT_STORAGE_KEY, JSON.stringify(session));
  }, [attachedRepos, chatMessages, chatResponseId]);

  useEffect(() => {
    if (typeof window === "undefined" || !hasRestoredPersistentChatRef.current) return;

    if (!singleTraceSnapshot) return;
    localStorage.setItem(TRACE_AGENT_TRACE_STORAGE_KEY, JSON.stringify(singleTraceSnapshot));
  }, [singleTraceSnapshot]);

  useEffect(() => {
    if (typeof window === "undefined" || !hasRestoredPersistentChatRef.current) return;

    void savePersistedTracePayload("single", singlePersistedPayload).catch(() => {
      // Ignore persistence failures on the client.
    });
  }, [singlePersistedPayload]);

  useEffect(() => {
    if (typeof window === "undefined" || !hasRestoredPersistentChatRef.current) return;

    void savePersistedTracePayload("baseline", baselinePersistedPayload).catch(() => {
      // Ignore persistence failures on the client.
    });
  }, [baselinePersistedPayload]);

  useEffect(() => {
    if (typeof window === "undefined" || !hasRestoredPersistentChatRef.current) return;

    void savePersistedTracePayload("candidate", candidatePersistedPayload).catch(() => {
      // Ignore persistence failures on the client.
    });
  }, [candidatePersistedPayload]);

  useEffect(() => {
    if (typeof window === "undefined" || !hasRestoredPersistentChatRef.current) return;

    const hasAnyTrace =
      singleTrace.traceData !== null ||
      baselineTrace.traceData !== null ||
      candidateTrace.traceData !== null;

    void savePersistedViewerState(
      hasAnyTrace
        ? {
            mode,
            normalizationMode,
            single: singlePersistedUiState,
            baseline: baselinePersistedUiState,
            candidate: candidatePersistedUiState,
          }
        : null
    ).catch(() => {
      // Ignore persistence failures on the client.
    });
  }, [
    baselinePersistedUiState,
    baselineTrace.traceData,
    candidatePersistedUiState,
    candidateTrace.traceData,
    mode,
    normalizationMode,
    singlePersistedUiState,
    singleTrace.traceData,
  ]);

  useEffect(() => {
    const handleCommandPaletteShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsCommandPaletteOpen((previousOpen) => !previousOpen);
      }
    };

    window.addEventListener("keydown", handleCommandPaletteShortcut);
    return () => window.removeEventListener("keydown", handleCommandPaletteShortcut);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (isCommandPaletteOpen) {
        return;
      }

      if (isCaptureMode && event.key === "Escape") {
        event.preventDefault();
        cancelAreaCapture();
        return;
      }

      switch (event.key.toLowerCase()) {
        case "w":
          if (mode === "deep") {
            setCandidateTrace((previousState) => ({
              ...previousState,
              viewState: zoomViewState(previousState.viewState, 1 / 1.5),
            }));
          } else {
            handleZoomIn();
          }
          break;
        case "s":
          if (mode === "deep") {
            setCandidateTrace((previousState) => ({
              ...previousState,
              viewState: zoomViewState(previousState.viewState, 1.5),
            }));
          } else {
            handleZoomOut();
          }
          break;
        case "a":
          handlePanLeft();
          break;
        case "d":
          handlePanRight();
          break;
        case "1":
          handleSelectTool();
          break;
        case "2":
          handlePanTool();
          break;
        case "0":
          if (mode === "deep") {
            setCandidateTrace((previousState) => ({
              ...previousState,
              viewState: fitViewStateToBounds(candidateTimeBounds, 0.02),
            }));
          } else {
            handleFitToWindow();
          }
          break;
        case "escape":
          handleClearSelection();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    cancelAreaCapture,
    candidateTimeBounds,
    handleFitToWindow,
    handlePanLeft,
    handlePanRight,
    handlePanTool,
    handleSelectTool,
    handleZoomIn,
    handleZoomOut,
    handleClearSelection,
    isCommandPaletteOpen,
    isCaptureMode,
    mode,
  ]);

  const requestRepoContext = useCallback(
    async (payload: {
      action: "snapshot" | "search_paths" | "list_directory" | "read_file";
      repo: GitHubRepoMention;
      query?: string;
      path?: string;
      limit?: number;
    }) => {
      const response = await fetch("/api/repo-context", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const responseText = await response.text();
        let errorMessage = responseText;

        try {
          const errorJson = JSON.parse(responseText) as { error?: string };
          errorMessage = errorJson.error ?? responseText;
        } catch {
          errorMessage = responseText;
        }

        throw new Error(errorMessage || "GitHub repo request failed.");
      }

      return (await response.json()) as unknown;
    },
    []
  );

  const requestTraceChat = useCallback(
    async (
      payload: {
        previousResponseId: string | null;
        userMessage?: string | null;
        toolOutputs?: TraceChatToolResult[];
        context: TraceChatContext;
        contextMode?: "full" | "delta";
        screenshotDataUrl?: string | null;
        attachments?: TraceChatAttachment[];
        repoMentions?: GitHubRepoMention[];
      },
      onAssistantDelta: (delta: string) => void
    ): Promise<TraceChatResponse> => {
      const response = await fetch("/api/trace-chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...payload,
          stream: true,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let parsedError: string | undefined;

        try {
          const errorJson = JSON.parse(errorText) as { error?: string };
          parsedError = errorJson.error;
        } catch {
          parsedError = undefined;
        }

        throw new Error(parsedError || errorText || "Trace chat request failed.");
      }

      if (!response.body) {
        throw new Error("Trace chat stream was empty.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResponse: TraceChatResponse | null = null;

      const processLine = (line: string) => {
        if (!line.trim()) return;

        let parsedEvent: TraceChatStreamEvent;
        try {
          parsedEvent = JSON.parse(line) as TraceChatStreamEvent;
        } catch {
          return;
        }

        if (parsedEvent.type === "assistant_delta") {
          onAssistantDelta(parsedEvent.delta);
          return;
        }

        if (parsedEvent.type === "assistant_done") {
          finalResponse = parsedEvent.response;
          return;
        }

        if (parsedEvent.type === "error") {
          throw new Error(parsedEvent.error);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex === -1) break;
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          processLine(line);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        processLine(buffer.trim());
      }

      if (!finalResponse) {
        throw new Error("Trace chat stream ended before the final response arrived.");
      }

      return finalResponse;
    },
    []
  );

  const executeToolCall = useCallback(
    async (
      toolCall: TraceChatToolCall,
      runtime: ToolExecutionRuntime
    ): Promise<ToolExecutionResult> => {
      const nextRuntime: ToolExecutionRuntime = {
        mode: runtime.mode,
        single: {
          ...runtime.single,
        },
        baseline: {
          ...runtime.baseline,
        },
        candidate: {
          ...runtime.candidate,
        },
      };

      const getTargetByKey = (targetKey: RuntimeTargetKey) => {
        if (targetKey === "single") {
          return {
            targetKey,
            label: "current run",
            traceIndex: singleTraceIndex,
            traceSnapshot: singleTraceSnapshot,
            runtimeState: nextRuntime.single,
            setSelectedEvent: (event: TraceEvent | null) =>
              setSingleTrace((previousState) => ({
                ...previousState,
                selectedEvent: event,
              })),
            setViewState: (viewState: ViewState) =>
              setSingleTrace((previousState) => ({
                ...previousState,
                viewState,
              })),
          };
        }

        if (targetKey === "baseline") {
          return {
            targetKey,
            label: "baseline run",
            traceIndex: baselineTraceIndex,
            traceSnapshot: baselineTraceSnapshot,
            runtimeState: nextRuntime.baseline,
            setSelectedEvent: (event: TraceEvent | null) =>
              setBaselineTrace((previousState) => ({
                ...previousState,
                selectedEvent: event,
              })),
            setViewState: (viewState: ViewState) =>
              setBaselineTrace((previousState) => ({
                ...previousState,
                viewState,
              })),
          };
        }

        return {
          targetKey,
          label: "candidate run",
          traceIndex: candidateTraceIndex,
          traceSnapshot: candidateTraceSnapshot,
          runtimeState: nextRuntime.candidate,
          setSelectedEvent: (event: TraceEvent | null) =>
            setCandidateTrace((previousState) => ({
              ...previousState,
              selectedEvent: event,
            })),
          setViewState: (viewState: ViewState) =>
            setCandidateTrace((previousState) => ({
              ...previousState,
              viewState,
            })),
        };
      };

      const getTarget = (requestedRole: unknown) => {
        const targetKey: RuntimeTargetKey =
          nextRuntime.mode === "deep"
            ? isTraceRole(requestedRole)
              ? requestedRole
              : "candidate"
            : "single";

        return getTargetByKey(targetKey);
      };

      const buildTargetViewSummary = (targetKey: RuntimeTargetKey) => {
        const target = getTargetByKey(targetKey);
        if (!target.traceIndex) return null;

        return buildViewportSummary(target.traceIndex, {
          viewState: target.runtimeState.viewState,
          selectedEventId: resolveTraceEventId(
            target.traceIndex,
            target.runtimeState.selectedEvent
          ),
          searchQuery,
        });
      };

      const focusRegionOnTarget = (targetKey: RuntimeTargetKey, region: {
        startTime: number;
        endTime: number;
        eventIds: string[];
      }, paddingRatio: number) => {
        const target = getTargetByKey(targetKey);
        if (!target.traceIndex || !target.traceSnapshot) return false;

        const duration = Math.max(region.endTime - region.startTime, 1_000);
        const padding = Math.max(duration * paddingRatio, 10_000);
        const nextViewState = {
          startTime: region.startTime - padding,
          endTime: region.endTime + padding,
          scale: 1,
        };
        const nextSelectedEvent = region.eventIds[0]
          ? target.traceIndex.eventById.get(region.eventIds[0])?.event ?? null
          : null;

        target.runtimeState.viewState = nextViewState;
        target.runtimeState.selectedEvent = nextSelectedEvent;
        target.setViewState(nextViewState);
        target.setSelectedEvent(nextSelectedEvent);

        return true;
      };

      const getRepoMention = (repoId: unknown) => {
        if (typeof repoId !== "string" || !repoId.trim()) return null;
        return attachedRepos.find((repo) => repo.id === repoId) ?? null;
      };

      const searchDeepCompareFindings = (query: string, limit: number) => {
        if (!deepCompareReport) return [];

        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) return [];

        const dedupedFindings = new Map<string, (typeof deepCompareReport.findings)[number]>();
        for (const finding of [
          ...deepCompareReport.findings,
          ...deepCompareReport.hotspotFindings,
          ...deepCompareReport.spikeFindings,
          ...deepCompareReport.callPathFindings,
          ...deepCompareReport.loopFindings,
        ]) {
          dedupedFindings.set(finding.id, finding);
        }

        return [...dedupedFindings.values()]
          .map((finding) => {
            const searchable = [
              finding.title,
              finding.summary,
              finding.explanation,
              finding.kind,
              ...finding.labels,
            ]
              .join(" ")
              .toLowerCase();

            if (!searchable.includes(normalizedQuery)) return null;

            let score = 0;
            if (finding.title.toLowerCase() === normalizedQuery) score += 10;
            if (finding.title.toLowerCase().includes(normalizedQuery)) score += 5;
            if (finding.labels.some((label) => label.toLowerCase() === normalizedQuery)) {
              score += 3;
            }

            return {
              finding,
              score,
            };
          })
          .filter((entry): entry is { finding: (typeof deepCompareReport.findings)[number]; score: number } => Boolean(entry))
          .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            return right.finding.priority - left.finding.priority;
          })
          .slice(0, limit)
          .map(({ finding }) => finding);
      };

      switch (toolCall.name) {
        case "search_events": {
          const target = getTarget(toolCall.arguments.trace_role);
          if (!target.traceIndex) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant requested a trace search before any trace was loaded.",
              output: {
                success: false,
                error: `No ${target.label} is currently loaded.`,
              },
            };
          }

          const query =
            typeof toolCall.arguments.query === "string" ? toolCall.arguments.query : "";
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          const matches = searchTraceEvents(
            target.traceIndex,
            query,
            limit,
            target.runtimeState.viewState
          );

          return {
            runtime: nextRuntime,
            logMessage: matches.length
              ? `Assistant searched the ${target.label} for "${query}" and found ${matches.length} matching spans.`
              : `Assistant searched the ${target.label} for "${query}" but found no matching spans.`,
            output: {
              traceRole: target.targetKey,
              query,
              matchCount: matches.length,
              matches,
            },
          };
        }

        case "list_hotspots": {
          const target = getTarget(toolCall.arguments.trace_role);
          const scope =
            toolCall.arguments.scope === "view" ? "view" : "trace";
          const metric =
            typeof toolCall.arguments.metric === "string"
              ? toolCall.arguments.metric
              : "inclusive_time";
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          const viewSummary =
            scope === "view" && target.traceIndex
              ? buildViewportSummary(target.traceIndex, {
                  viewState: target.runtimeState.viewState,
                  selectedEventId: resolveTraceEventId(
                    target.traceIndex,
                    target.runtimeState.selectedEvent
                  ),
                  searchQuery,
                })
              : null;

          if (scope === "trace" && !target.traceSnapshot) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant requested trace hotspots before any trace was loaded.",
              output: {
                success: false,
                error: `No ${target.label} is currently loaded.`,
              },
            };
          }

          if (scope === "view" && !viewSummary) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant requested viewport hotspots before any trace was loaded.",
              output: {
                success: false,
                error: `No ${target.label} is currently loaded.`,
              },
            };
          }

          let items: unknown[] = [];

          if (scope === "trace") {
            switch (metric) {
              case "inclusive_time":
                items = target.traceSnapshot!.topHotspots.slice(0, limit);
                break;
              case "self_time":
                items = target.traceSnapshot!.topSelfTimeHotspots.slice(0, limit);
                break;
              case "call_path":
                items = target.traceSnapshot!.topCallPaths.slice(0, limit);
                break;
              case "thread":
                items = target.traceSnapshot!.topThreads.slice(0, limit);
                break;
              default:
                return {
                  runtime: nextRuntime,
                  logMessage: "Assistant requested an unsupported whole-trace hotspot metric.",
                  output: {
                    success: false,
                    error: `Metric "${metric}" is only available on the current viewport.`,
                  },
                };
            }
          } else {
            switch (metric) {
              case "inclusive_time":
                items = viewSummary!.topVisibleHotspots.slice(0, limit);
                break;
              case "self_time":
                items = viewSummary!.topVisibleSelfTimeHotspots.slice(0, limit);
                break;
              case "call_path":
                items = viewSummary!.topVisibleCallPaths.slice(0, limit);
                break;
              case "thread":
                items = viewSummary!.visibleThreads.slice(0, limit);
                break;
              case "spike":
                items = viewSummary!.topVisibleSpikeHotspots.slice(0, limit);
                break;
              default:
                items = [];
                break;
            }
          }

          return {
            runtime: nextRuntime,
            logMessage: `Assistant listed ${scope === "trace" ? "whole-trace" : "viewport"} ${metric.replaceAll("_", " ")} hotspots for the ${target.label}.`,
            output: {
              traceRole: target.targetKey,
              scope,
              metric,
              items,
            },
          };
        }

        case "list_anomalies": {
          const target = getTarget(toolCall.arguments.trace_role);
          if (!target.traceIndex) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant requested anomalies before any trace was loaded.",
              output: {
                success: false,
                error: `No ${target.label} is currently loaded.`,
              },
            };
          }

          const scope = toolCall.arguments.scope === "view" ? "view" : "trace";
          const kind =
            typeof toolCall.arguments.kind === "string" &&
            toolCall.arguments.kind.trim() &&
            toolCall.arguments.kind !== "all"
              ? toolCall.arguments.kind.trim()
              : null;
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          const viewSummary =
            scope === "view"
              ? buildViewportSummary(target.traceIndex, {
                  viewState: target.runtimeState.viewState,
                  selectedEventId: resolveTraceEventId(
                    target.traceIndex,
                    target.runtimeState.selectedEvent
                  ),
                  searchQuery,
                })
              : null;

          const anomalies = (
            scope === "view"
              ? viewSummary?.visibleAnomalies ?? []
              : target.traceIndex.anomalies
          )
            .filter((anomaly) => (kind ? anomaly.kind === kind : true))
            .slice(0, limit);

          return {
            runtime: nextRuntime,
            logMessage: anomalies.length
              ? `Assistant listed ${scope === "view" ? "viewport" : "whole-trace"} anomalies for the ${target.label}.`
              : `Assistant checked the ${target.label} for ${scope === "view" ? "viewport" : "trace"} anomalies but found none that match.`,
            output: {
              traceRole: target.targetKey,
              scope,
              kind: kind ?? "all",
              items: anomalies,
            },
          };
        }

        case "inspect_event": {
          const target = getTarget(toolCall.arguments.trace_role);
          if (!target.traceIndex) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant requested an event inspection before any trace was loaded.",
              output: {
                success: false,
                error: `No ${target.label} is currently loaded.`,
              },
            };
          }

          const eventId =
            typeof toolCall.arguments.event_id === "string"
              ? toolCall.arguments.event_id
              : "";
          const inspection = inspectTraceEvent(target.traceIndex, eventId);

          return {
            runtime: nextRuntime,
            logMessage: inspection
              ? `Assistant inspected ${inspection.event.name} on the ${target.label}.`
              : `Assistant tried to inspect an event that is no longer available in the ${target.label}.`,
            output:
              inspection ?? {
                success: false,
                error: `Event "${eventId}" was not found in the ${target.label}.`,
            },
          };
        }

        case "inspect_anomaly": {
          const target = getTarget(toolCall.arguments.trace_role);
          if (!target.traceIndex) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant requested an anomaly inspection before any trace was loaded.",
              output: {
                success: false,
                error: `No ${target.label} is currently loaded.`,
              },
            };
          }

          const anomalyId =
            typeof toolCall.arguments.anomaly_id === "string"
              ? toolCall.arguments.anomaly_id
              : "";
          const inspection = inspectTraceAnomaly(target.traceIndex, anomalyId);

          return {
            runtime: nextRuntime,
            logMessage: inspection
              ? `Assistant inspected the anomaly "${inspection.anomaly.title}" on the ${target.label}.`
              : `Assistant tried to inspect an anomaly that is no longer available in the ${target.label}.`,
            output:
              inspection ?? {
                success: false,
                error: `Anomaly "${anomalyId}" was not found in the ${target.label}.`,
              },
          };
        }

        case "inspect_current_view": {
          const target = getTarget(toolCall.arguments.trace_role);
          if (!target.traceIndex) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant requested a viewport inspection before any trace was loaded.",
              output: {
                success: false,
                error: `No ${target.label} is currently loaded.`,
              },
            };
          }

          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          const viewSummary = buildViewportSummary(target.traceIndex, {
            viewState: target.runtimeState.viewState,
            selectedEventId: resolveTraceEventId(
              target.traceIndex,
              target.runtimeState.selectedEvent
            ),
            searchQuery,
          });

          return {
            runtime: nextRuntime,
            logMessage: `Assistant inspected the ${target.label} viewport.`,
            output: {
              traceRole: target.targetKey,
              ...viewSummary,
              topVisibleHotspots: viewSummary.topVisibleHotspots.slice(0, limit),
              topVisibleSelfTimeHotspots: viewSummary.topVisibleSelfTimeHotspots.slice(
                0,
                limit
              ),
              topVisibleCallPaths: viewSummary.topVisibleCallPaths.slice(
                0,
                Math.min(limit, 8)
              ),
              topVisibleSpikeHotspots: viewSummary.topVisibleSpikeHotspots.slice(0, limit),
              visibleAnomalies: viewSummary.visibleAnomalies.slice(0, limit),
              longestVisibleEvents: viewSummary.longestVisibleEvents.slice(0, limit),
              sampleVisibleSpikeEvents: viewSummary.sampleVisibleSpikeEvents.slice(0, limit),
              visibleThreads: viewSummary.visibleThreads.slice(0, Math.min(limit, 6)),
              visibleProcesses: viewSummary.visibleProcesses.slice(0, Math.min(limit, 6)),
              searchMatches: viewSummary.searchMatches.slice(0, limit),
            },
          };
        }

        case "focus_event": {
          const target = getTarget(toolCall.arguments.trace_role);
          if (!target.traceIndex) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant requested a focus action before any trace was loaded.",
              output: {
                success: false,
                error: `No ${target.label} is currently loaded.`,
              },
            };
          }

          const eventId =
            typeof toolCall.arguments.event_id === "string"
              ? toolCall.arguments.event_id
              : "";
          const paddingRatio = clampNumber(toolCall.arguments.padding_ratio, 0, 2, 0.35);
          const targetEvent = target.traceIndex.eventById.get(eventId);

          if (!targetEvent) {
            return {
              runtime: nextRuntime,
              logMessage: `Assistant tried to focus an event that is no longer available in the ${target.label}.`,
              output: {
                success: false,
                error: `Event "${eventId}" was not found in the ${target.label}.`,
              },
            };
          }

          const baseDuration = Math.max(targetEvent.dur, 25_000);
          const padding = Math.max(baseDuration * paddingRatio, 10_000);
          const nextViewState = {
            startTime: targetEvent.ts - padding,
            endTime: targetEvent.endTime + padding,
            scale: 1,
          };

          target.runtimeState.viewState = nextViewState;
          target.runtimeState.selectedEvent = targetEvent.event;
          target.setSelectedEvent(targetEvent.event);
          target.setViewState(nextViewState);

          await waitForFrames();

          return {
            runtime: nextRuntime,
            logMessage: `Assistant focused ${targetEvent.name} on the ${target.label}.`,
            output: {
              success: true,
              traceRole: target.targetKey,
              focusedEvent: inspectTraceEvent(target.traceIndex, eventId)?.event ?? null,
              currentView: buildTargetViewSummary(target.targetKey),
            },
          };
        }

        case "set_view_range": {
          const target = getTarget(toolCall.arguments.trace_role);
          if (!target.traceIndex) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant requested a zoom action before any trace was loaded.",
              output: {
                success: false,
                error: `No ${target.label} is currently loaded.`,
              },
            };
          }

          const startTimeUs = clampNumber(
            toolCall.arguments.start_time_us,
            -Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER,
            target.runtimeState.viewState.startTime
          );
          const endTimeUs = clampNumber(
            toolCall.arguments.end_time_us,
            -Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER,
            target.runtimeState.viewState.endTime
          );
          const minSpan = 1_000;
          const nextViewState = {
            startTime: Math.min(startTimeUs, endTimeUs - minSpan),
            endTime: Math.max(endTimeUs, startTimeUs + minSpan),
            scale: 1,
          };

          target.runtimeState.viewState = nextViewState;
          target.setViewState(nextViewState);
          await waitForFrames();

          return {
            runtime: nextRuntime,
            logMessage: `Assistant zoomed the ${target.label} to a ${formatTimeShort(
              nextViewState.endTime - nextViewState.startTime
            )} window.`,
            output: {
              success: true,
              traceRole: target.targetKey,
              currentView: buildTargetViewSummary(target.targetKey),
            },
          };
        }

        case "fit_to_trace": {
          const target = getTarget(toolCall.arguments.trace_role);
          if (!target.traceSnapshot) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant requested a fit action before any trace was loaded.",
              output: {
                success: false,
                error: `No ${target.label} is currently loaded.`,
              },
            };
          }

          const includePadding = Boolean(toolCall.arguments.include_padding);
          const padding = includePadding ? target.traceSnapshot.bounds.duration * 0.02 : 0;
          const nextViewState = {
            startTime: target.traceSnapshot.bounds.startTime - padding,
            endTime: target.traceSnapshot.bounds.endTime + padding,
            scale: 1,
          };

          target.runtimeState.viewState = nextViewState;
          target.setViewState(nextViewState);
          await waitForFrames();

          return {
            runtime: nextRuntime,
            logMessage: `Assistant reset the ${target.label} viewport to the full trace.`,
            output: {
              success: true,
              traceRole: target.targetKey,
              currentView: buildTargetViewSummary(target.targetKey),
            },
          };
        }

        case "clear_selection": {
          const target = getTarget(toolCall.arguments.trace_role);
          if (!target.traceSnapshot) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant requested a clear action before any trace was loaded.",
              output: {
                success: false,
                error: `No ${target.label} is currently loaded.`,
              },
            };
          }

          const keepView = Boolean(toolCall.arguments.keep_view);
          target.runtimeState.selectedEvent = null;
          target.setSelectedEvent(null);

          if (!keepView) {
            const padding = target.traceSnapshot.bounds.duration * 0.02;
            const nextViewState = {
              startTime: target.traceSnapshot.bounds.startTime - padding,
              endTime: target.traceSnapshot.bounds.endTime + padding,
              scale: 1,
            };
            target.runtimeState.viewState = nextViewState;
            target.setViewState(nextViewState);
          }

          await waitForFrames();

          return {
            runtime: nextRuntime,
            logMessage: `Assistant cleared the current selection on the ${target.label}.`,
            output: {
              success: true,
              traceRole: target.targetKey,
              currentView: buildTargetViewSummary(target.targetKey),
            },
          };
        }

        case "compare_with_previous": {
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          const comparison =
            nextRuntime.mode === "deep"
              ? buildTraceDiffSummary(baselineTraceSnapshot, candidateTraceSnapshot)
              : buildTraceDiffSummary(previousTraceSnapshot, singleTraceSnapshot);

          return {
            runtime: nextRuntime,
            logMessage: comparison?.available
              ? nextRuntime.mode === "deep"
                ? "Assistant compared the baseline and candidate run summaries."
                : "Assistant compared the current run with the preserved previous run."
              : "Assistant checked for comparison data but none is available yet.",
            output:
              comparison != null
                ? {
                    ...comparison,
                    hotspotChanges: comparison.hotspotChanges.slice(0, limit),
                    processChanges: comparison.processChanges.slice(0, limit),
                    categoryChanges: comparison.categoryChanges.slice(0, limit),
                  }
                : {
                    success: false,
                    error: "No comparison data is available.",
                  },
          };
        }

        case "run_deep_compare": {
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          if (nextRuntime.mode !== "deep" || !deepCompareReport) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to run Deep Mode before both comparison runs were ready.",
              output: {
                success: false,
                error: "Deep Mode is not available until both baseline and candidate runs are loaded.",
              },
            };
          }

          return {
            runtime: nextRuntime,
            logMessage: "Assistant ran the deterministic Deep Mode compare report.",
            output: {
              id: deepCompareReport.id,
              headline: deepCompareReport.headline,
              normalization: deepCompareReport.normalization,
              winner: deepCompareReport.winner,
              summaryMetrics: deepCompareReport.summaryMetrics,
              findings: deepCompareReport.findings.slice(0, limit),
              anomalyComparisons:
                baselineTraceIndex && candidateTraceIndex
                  ? compareTraceAnomalies(
                      baselineTraceIndex.anomalies,
                      candidateTraceIndex.anomalies,
                      limit
                    )
                  : [],
              caveats: deepCompareReport.caveats,
              topChangedLoops: deepCompareReport.topChangedLoops.slice(0, limit),
            },
          };
        }

        case "inspect_compare_finding": {
          if (nextRuntime.mode !== "deep" || !deepCompareReport) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to inspect a Deep Mode finding before the report was available.",
              output: {
                success: false,
                error: "Deep Mode is not available until both baseline and candidate runs are loaded.",
              },
            };
          }

          const findingId =
            typeof toolCall.arguments.finding_id === "string"
              ? toolCall.arguments.finding_id
              : "";
          const finding = findCompareFinding(deepCompareReport, findingId);

          return {
            runtime: nextRuntime,
            logMessage: finding
              ? `Assistant inspected the Deep Mode finding "${finding.title}".`
              : "Assistant tried to inspect a Deep Mode finding that no longer exists.",
            output:
              finding ?? {
                success: false,
                error: `Finding "${findingId}" was not found in the current Deep Mode report.`,
              },
          };
        }

        case "focus_compare_region": {
          if (nextRuntime.mode !== "deep" || !deepCompareReport) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to focus Deep Mode evidence before the compare report was available.",
              output: {
                success: false,
                error: "Deep Mode is not available until both baseline and candidate runs are loaded.",
              },
            };
          }

          const paddingRatio = clampNumber(toolCall.arguments.padding_ratio, 0, 2, 0.25);
          const traceRole = isTraceRole(toolCall.arguments.trace_role)
            ? toolCall.arguments.trace_role
            : null;
          const findingId =
            typeof toolCall.arguments.finding_id === "string"
              ? toolCall.arguments.finding_id
              : null;
          const regionId =
            typeof toolCall.arguments.region_id === "string"
              ? toolCall.arguments.region_id
              : null;

          const regions = [];

          if (findingId) {
            const finding = findCompareFinding(deepCompareReport, findingId);
            if (finding) {
              regions.push(
                ...finding.evidence.filter((region) =>
                  traceRole ? region.traceRole === traceRole : true
                )
              );
            }
          } else if (regionId) {
            const region = findCompareRegion(deepCompareReport, regionId);
            if (region && (!traceRole || region.traceRole === traceRole)) {
              regions.push(region);
            }
          }

          if (regions.length === 0) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to focus Deep Mode evidence, but no matching region was found.",
              output: {
                success: false,
                error: "No matching Deep Mode region was found.",
              },
            };
          }

          const firstRegionByRole = new Map<TraceRole, (typeof regions)[number]>();
          for (const region of regions) {
            if (!firstRegionByRole.has(region.traceRole)) {
              firstRegionByRole.set(region.traceRole, region);
            }
          }

          let focusedCount = 0;
          for (const [role, region] of firstRegionByRole) {
            if (
              focusRegionOnTarget(role, {
                startTime: region.startTime,
                endTime: region.endTime,
                eventIds: region.eventIds,
              }, paddingRatio)
            ) {
              focusedCount += 1;
            }
          }

          if (focusedCount === 0) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant found compare evidence, but the linked runs are no longer loaded.",
              output: {
                success: false,
                error: "The linked compare evidence is no longer available in the loaded runs.",
              },
            };
          }

          await waitForFrames();

          return {
            runtime: nextRuntime,
            logMessage: `Assistant focused ${focusedCount} Deep Mode evidence region${focusedCount === 1 ? "" : "s"}.`,
            output: {
              success: true,
              baselineView: buildTargetViewSummary("baseline"),
              candidateView: buildTargetViewSummary("candidate"),
            },
          };
        }

        case "compare_spikes": {
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          if (nextRuntime.mode !== "deep" || !deepCompareReport) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to compare spikes before Deep Mode was ready.",
              output: {
                success: false,
                error: "Deep Mode is not available until both baseline and candidate runs are loaded.",
              },
            };
          }

          return {
            runtime: nextRuntime,
            logMessage: "Assistant compared spike and host-gap deltas.",
            output: {
              headline: deepCompareReport.headline,
              normalization: deepCompareReport.normalization,
              findings: deepCompareReport.spikeFindings.slice(0, limit),
            },
          };
        }

        case "compare_hotspots": {
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          if (nextRuntime.mode !== "deep" || !deepCompareReport) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to compare hotspots before Deep Mode was ready.",
              output: {
                success: false,
                error: "Deep Mode is not available until both baseline and candidate runs are loaded.",
              },
            };
          }

          return {
            runtime: nextRuntime,
            logMessage: "Assistant compared hotspot and signature deltas.",
            output: {
              headline: deepCompareReport.headline,
              normalization: deepCompareReport.normalization,
              findings: deepCompareReport.hotspotFindings.slice(0, limit),
            },
          };
        }

        case "compare_call_paths": {
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          if (nextRuntime.mode !== "deep" || !deepCompareReport) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to compare call paths before Deep Mode was ready.",
              output: {
                success: false,
                error: "Deep Mode is not available until both baseline and candidate runs are loaded.",
              },
            };
          }

          return {
            runtime: nextRuntime,
            logMessage: "Assistant compared call-path, thread, and loop deltas.",
            output: {
              headline: deepCompareReport.headline,
              normalization: deepCompareReport.normalization,
              callPathFindings: deepCompareReport.callPathFindings.slice(0, limit),
              loopFindings: deepCompareReport.loopFindings.slice(0, limit),
            },
          };
        }

        case "compare_anomalies": {
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          if (
            nextRuntime.mode !== "deep" ||
            !baselineTraceIndex ||
            !candidateTraceIndex
          ) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to compare anomalies before Deep Mode was ready.",
              output: {
                success: false,
                error: "Deep Mode is not available until both baseline and candidate runs are loaded.",
              },
            };
          }

          const kind =
            typeof toolCall.arguments.kind === "string" &&
            toolCall.arguments.kind.trim() &&
            toolCall.arguments.kind !== "all"
              ? toolCall.arguments.kind.trim()
              : null;
          const comparisons = compareTraceAnomalies(
            baselineTraceIndex.anomalies,
            candidateTraceIndex.anomalies,
            24
          ).filter((comparison) => (kind ? comparison.kind === kind : true));

          return {
            runtime: nextRuntime,
            logMessage: comparisons.length
              ? "Assistant compared anomaly fingerprints between the baseline and candidate runs."
              : "Assistant compared anomalies between the baseline and candidate runs but found no matching changes.",
            output: {
              kind: kind ?? "all",
              comparisons: comparisons.slice(0, limit),
            },
          };
        }

        case "search_compare_findings": {
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          if (nextRuntime.mode !== "deep" || !deepCompareReport) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to search Deep Mode findings before Deep Mode was ready.",
              output: {
                success: false,
                error: "Deep Mode is not available until both baseline and candidate runs are loaded.",
              },
            };
          }

          const query =
            typeof toolCall.arguments.query === "string" ? toolCall.arguments.query : "";
          const findings = searchDeepCompareFindings(query, limit);

          return {
            runtime: nextRuntime,
            logMessage: findings.length
              ? `Assistant searched Deep Mode findings for "${query}" and found ${findings.length} matches.`
              : `Assistant searched Deep Mode findings for "${query}" but found no matches.`,
            output: {
              query,
              matchCount: findings.length,
              findings,
            },
          };
        }

        case "search_repo_paths": {
          const repoId =
            typeof toolCall.arguments.repo_id === "string"
              ? toolCall.arguments.repo_id
              : "";
          const repo = getRepoMention(repoId);
          if (!repo) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to search a repo that is not attached.",
              output: {
                success: false,
                error: `Repo "${repoId}" is not attached to this conversation.`,
              },
            };
          }

          const query =
            typeof toolCall.arguments.query === "string" ? toolCall.arguments.query : "";
          const limit = clampNumber(toolCall.arguments.limit, 1, 40, 12);
          const output = await requestRepoContext({
            action: "search_paths",
            repo,
            query,
            limit,
          });

          return {
            runtime: nextRuntime,
            logMessage: `Assistant searched ${repo.url} for matching file paths.`,
            output,
          };
        }

        case "list_repo_directory": {
          const repoId =
            typeof toolCall.arguments.repo_id === "string"
              ? toolCall.arguments.repo_id
              : "";
          const repo = getRepoMention(repoId);
          if (!repo) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to list a repo directory that is not attached.",
              output: {
                success: false,
                error: `Repo "${repoId}" is not attached to this conversation.`,
              },
            };
          }

          const path =
            typeof toolCall.arguments.path === "string" ? toolCall.arguments.path : "";
          const output = await requestRepoContext({
            action: "list_directory",
            repo,
            path,
          });

          return {
            runtime: nextRuntime,
            logMessage: `Assistant listed ${path || "/"} in ${repo.url}.`,
            output,
          };
        }

        case "read_repo_file": {
          const repoId =
            typeof toolCall.arguments.repo_id === "string"
              ? toolCall.arguments.repo_id
              : "";
          const repo = getRepoMention(repoId);
          if (!repo) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to read a repo file from a repo that is not attached.",
              output: {
                success: false,
                error: `Repo "${repoId}" is not attached to this conversation.`,
              },
            };
          }

          const path =
            typeof toolCall.arguments.path === "string" ? toolCall.arguments.path : "";
          const output = await requestRepoContext({
            action: "read_file",
            repo,
            path,
          });

          return {
            runtime: nextRuntime,
            logMessage: `Assistant read ${path} from ${repo.url}.`,
            output,
          };
        }

        default: {
          return {
            runtime: nextRuntime,
            logMessage: `Assistant requested an unsupported tool: ${toolCall.name}.`,
            output: {
              success: false,
              error: `Unsupported tool: ${toolCall.name}.`,
            },
          };
        }
      }
    },
    [
      attachedRepos,
      baselineTraceIndex,
      baselineTraceSnapshot,
      candidateTraceIndex,
      candidateTraceSnapshot,
      deepCompareReport,
      previousTraceSnapshot,
      requestRepoContext,
      searchQuery,
      singleTraceIndex,
      singleTraceSnapshot,
    ]
  );

  const handleSendMessage = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      const outgoingAttachments = pendingAttachments.map(cloneAttachment);
      if ((trimmed.length === 0 && outgoingAttachments.length === 0) || chatBusy) return;

      const { displayMessage, repoMentions } = extractGitHubMentions(trimmed);
      const nextAttachedRepos = mergeRepoMentions(attachedRepos, repoMentions);

      setPendingAttachments([]);
      setAttachedRepos(nextAttachedRepos);
      setChatMessages((previousMessages) => [
        ...previousMessages,
        {
          id: createLocalId("user"),
          role: "user",
          content: displayMessage,
          attachments: outgoingAttachments,
        },
      ]);
      setChatBusy(true);
      setChatErrorMessage(null);

      let latestResponseId = chatResponseId;
      let pendingUserMessage: string | null = trimmed || null;
      let pendingToolOutputs: TraceChatToolResult[] | undefined;
      let pendingRequestAttachments =
        outgoingAttachments.length > 0 ? outgoingAttachments : undefined;
      let pendingRepoMentions = nextAttachedRepos.length > 0 ? nextAttachedRepos : undefined;
      let pendingContextMode: "full" | "delta" = "full";
      let shouldAttachScreenshot = true;
      const runtime: ToolExecutionRuntime = {
        mode,
        single: {
          viewState: singleTrace.viewState,
          selectedEvent: singleTrace.selectedEvent,
        },
        baseline: {
          viewState: baselineTrace.viewState,
          selectedEvent: baselineTrace.selectedEvent,
        },
        candidate: {
          viewState: candidateTrace.viewState,
          selectedEvent: candidateTrace.selectedEvent,
        },
      };

      try {
        for (let step = 0; step < TOOL_STEP_LIMIT; step += 1) {
          let streamedAssistantId: string | null = null;
          let streamedAssistantText = "";
          const screenshotDataUrl = shouldAttachScreenshot
            ? await captureCurrentScreenshot()
            : null;

          const response = await requestTraceChat(
            {
              previousResponseId: latestResponseId,
              userMessage: pendingUserMessage,
              toolOutputs: pendingToolOutputs,
              context: buildRuntimeChatContext(runtime),
              contextMode: pendingContextMode,
              screenshotDataUrl,
              attachments: pendingRequestAttachments,
              repoMentions: pendingRepoMentions,
            },
            (delta) => {
              streamedAssistantText += delta;

              if (!streamedAssistantId) {
                streamedAssistantId = createLocalId("assistant");
                setChatMessages((previousMessages) => [
                  ...previousMessages,
                  {
                    id: streamedAssistantId!,
                    role: "assistant",
                    content: delta,
                  },
                ]);
                return;
              }

              setChatMessages((previousMessages) =>
                previousMessages.map((entry) =>
                  entry.id === streamedAssistantId
                    ? {
                        ...entry,
                        content: entry.content + delta,
                      }
                    : entry
                )
              );
            }
          );

          latestResponseId = response.responseId;
          const finalAssistantText = response.assistantText.trim();

          if (
            streamedAssistantId &&
            finalAssistantText &&
            finalAssistantText !== streamedAssistantText
          ) {
            setChatMessages((previousMessages) =>
              previousMessages.map((entry) =>
                entry.id === streamedAssistantId
                  ? {
                      ...entry,
                      content: finalAssistantText,
                    }
                  : entry
              )
            );
          }

          if (response.toolCalls.length === 0) {
            if (!streamedAssistantId) {
              setChatMessages((previousMessages) => [
                ...previousMessages,
                {
                  id: createLocalId("assistant"),
                  role: "assistant",
                  content:
                    finalAssistantText ||
                    "I inspected the trace but did not produce a final explanation.",
                },
              ]);
            }
            setChatResponseId(latestResponseId);
            return;
          }

          const nextToolOutputs: TraceChatToolResult[] = [];
          let nextStepNeedsScreenshot = false;

          for (const toolCall of response.toolCalls) {
            const execution = await executeToolCall(toolCall, runtime);
            runtime.mode = execution.runtime.mode;
            runtime.single = execution.runtime.single;
            runtime.baseline = execution.runtime.baseline;
            runtime.candidate = execution.runtime.candidate;

            if (
              toolCall.name === "focus_event" ||
              toolCall.name === "set_view_range" ||
              toolCall.name === "fit_to_trace" ||
              toolCall.name === "clear_selection" ||
              toolCall.name === "focus_compare_region"
            ) {
              nextStepNeedsScreenshot = true;
            }

            nextToolOutputs.push({
              callId: toolCall.callId,
              name: toolCall.name,
              output: execution.output,
            });
            setChatMessages((previousMessages) => [
              ...previousMessages,
              {
                id: createLocalId("tool"),
                role: "tool",
                content: execution.logMessage,
              },
            ]);
          }

          pendingUserMessage = null;
          pendingToolOutputs = nextToolOutputs;
          pendingRequestAttachments = undefined;
          pendingRepoMentions = nextAttachedRepos.length > 0 ? nextAttachedRepos : undefined;
          pendingContextMode = "delta";
          shouldAttachScreenshot = nextStepNeedsScreenshot;
        }

        setChatErrorMessage("The assistant hit the current tool-step limit before finishing.");
        setChatMessages((previousMessages) => [
          ...previousMessages,
          {
            id: createLocalId("assistant"),
            role: "assistant",
            content:
              "I reached the current inspection limit before finishing. Ask again with a narrower question or reference a specific span.",
          },
        ]);
        setChatResponseId(latestResponseId);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Trace chat failed.";
        setChatErrorMessage(errorMessage);
        setChatMessages((previousMessages) => [
          ...previousMessages,
          {
            id: createLocalId("assistant"),
            role: "assistant",
            content:
              "I couldn't complete that request because the trace chat backend returned an error.",
          },
        ]);
        if (latestResponseId) {
          setChatResponseId(latestResponseId);
        }
      } finally {
        setChatBusy(false);
      }
    },
    [
      attachedRepos,
      baselineTrace.selectedEvent,
      baselineTrace.viewState,
      buildRuntimeChatContext,
      captureCurrentScreenshot,
      candidateTrace.selectedEvent,
      candidateTrace.viewState,
      chatBusy,
      chatResponseId,
      executeToolCall,
      mode,
      pendingAttachments,
      requestTraceChat,
      singleTrace.selectedEvent,
      singleTrace.viewState,
    ]
  );

  const hasSavedTraces =
    singleTrace.traceData !== null ||
    baselineTrace.traceData !== null ||
    candidateTrace.traceData !== null;

  if (!isHydrated) {
    return (
        <div className="flex h-screen items-center justify-center bg-white text-sm text-[#666]">
        Loading lupa…
      </div>
    );
  }

  const renderCaptureOverlay = () =>
    isCaptureMode ? (
      <div
        className="absolute inset-0 z-40 cursor-crosshair touch-none bg-black/20"
        onPointerDown={handleCapturePointerDown}
        onPointerMove={handleCapturePointerMove}
        onPointerUp={(event) => {
          void handleCapturePointerUp(event);
        }}
        onPointerCancel={cancelAreaCapture}
      >
        <div className="absolute left-4 top-4 rounded-sm bg-black/80 px-2 py-1 text-[11px] text-white shadow-sm">
          Drag to capture an attachment
        </div>

        {captureRect && (
          <div
            className="absolute border border-[#7fb0ff] bg-white/10 shadow-[0_0_0_9999px_rgba(22,22,22,0.35)]"
            style={{
              left: captureRect.left,
              top: captureRect.top,
              width: captureRect.width,
              height: captureRect.height,
            }}
          />
        )}
      </div>
    ) : null;

  const renderRunLoadOverlay = () => {
    if (!runLoadProgress) return null;

    const progressPercent = Math.round(getRunLoadProgressPercent(runLoadProgress) * 100);
    const byteProgress =
      runLoadProgress.totalBytes > 0
        ? `${formatBytes(runLoadProgress.loadedBytes)} / ${formatBytes(runLoadProgress.totalBytes)}`
        : `${runLoadProgress.completedFiles} / ${runLoadProgress.fileCount} files`;

    return (
      <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center px-4">
        <div className="w-full max-w-xl rounded-md border border-[#d8d8d8] bg-white/96 px-4 py-3 shadow-lg backdrop-blur">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#5f5f5f]">
                Loading {getLoadTargetLabel(runLoadProgress.target)}
              </div>
              <div className="mt-1 truncate text-sm font-medium text-[#1f1f1f]">
                {getRunLoadProgressMessage(runLoadProgress)}
              </div>
              <div className="mt-1 text-xs text-[#666]">{byteProgress}</div>
            </div>
            <div className="shrink-0 text-sm font-semibold tabular-nums text-[#1f1f1f]">
              {progressPercent}%
            </div>
          </div>

          <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#e8eefc]">
            <div
              className="h-full rounded-full bg-[#2f6df6] transition-[width] duration-150 ease-out"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      </div>
    );
  };

  const renderSingleWorkspace = () => (
    <div className="flex h-full flex-col bg-white">
      <div ref={workspaceRef} className="relative flex-1 overflow-hidden">
        {!singleTrace.traceData ? (
          <EmptyState onLoadFile={() => handleOpenFilePicker("single")} />
        ) : (
          <div className="flex h-full overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col">
              <Minimap
                traceData={singleTrace.traceData}
                viewState={singleTrace.viewState}
                onViewStateChange={(viewState) =>
                  setSingleTrace((previousState) => ({
                    ...previousState,
                    viewState,
                  }))
                }
                timeBounds={singleTimeBounds}
              />

              <Timeline
                processes={singleProcesses}
                viewState={singleTrace.viewState}
                onViewStateChange={(viewState) =>
                  setSingleTrace((previousState) => ({
                    ...previousState,
                    viewState,
                  }))
                }
                onEventSelect={(event) =>
                  setSingleTrace((previousState) => ({
                    ...previousState,
                    selectedEvent: event,
                  }))
                }
                selectedEvent={singleTrace.selectedEvent}
                tool={singleTrace.tool}
                searchQuery={searchQuery}
                onRegisterApi={setSingleTimelineApi}
              />

              {singleTrace.selectedEvent && (
                <DetailsPanel
                  event={singleTrace.selectedEvent}
                  processes={singleProcesses}
                  onClose={() =>
                    setSingleTrace((previousState) => ({
                      ...previousState,
                      selectedEvent: null,
                    }))
                  }
                  onAttachToChat={() => attachSelectionFromTarget("single")}
                />
              )}
            </div>

            <SideToolbar
              tool={singleTrace.tool}
              onToolChange={(tool) =>
                setSingleTrace((previousState) => ({
                  ...previousState,
                  tool,
                }))
              }
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              onFitToWindow={handleFitToWindow}
              onResetView={handleResetView}
              hasData={singleTrace.traceData !== null}
            />
          </div>
        )}

        {renderCaptureOverlay()}
      </div>

      {singleTrace.traceData && (
        <StatusBar
          viewState={singleTrace.viewState}
          processes={singleProcesses}
          eventCount={singleTraceSnapshot?.eventCount ?? 0}
          selectedEvent={singleTrace.selectedEvent}
        />
      )}
    </div>
  );

  const renderDeepWorkspace = () => (
    <div className="flex h-full flex-col bg-white">
      <div ref={workspaceRef} className="relative flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-full min-w-0 min-h-0 overflow-hidden">
          <ResizablePanel
            className="min-w-0 min-h-0 overflow-hidden"
            defaultSize={35}
            minSize={16}
          >
            <TracePane
              label="Baseline"
              traceData={baselineTrace.traceData}
              processes={baselineProcesses}
              viewState={baselineTrace.viewState}
              onViewStateChange={(viewState) =>
                setBaselineTrace((previousState) => ({
                  ...previousState,
                  viewState,
                }))
              }
              timeBounds={baselineTimeBounds}
              selectedEvent={baselineTrace.selectedEvent}
              onEventSelect={(event) =>
                setBaselineTrace((previousState) => ({
                  ...previousState,
                  selectedEvent: event,
                }))
              }
              tool={baselineTrace.tool}
              onToolChange={(tool) =>
                setBaselineTrace((previousState) => ({
                  ...previousState,
                  tool,
                }))
              }
              searchQuery={searchQuery}
              onRegisterApi={setBaselineTimelineApi}
              onZoomIn={() =>
                setBaselineTrace((previousState) => ({
                  ...previousState,
                  viewState: zoomViewState(previousState.viewState, 1 / 1.5),
                }))
              }
              onZoomOut={() =>
                setBaselineTrace((previousState) => ({
                  ...previousState,
                  viewState: zoomViewState(previousState.viewState, 1.5),
                }))
              }
              onFitToWindow={() =>
                setBaselineTrace((previousState) => ({
                  ...previousState,
                  viewState: fitViewStateToBounds(baselineTimeBounds, 0.02),
                }))
              }
              onResetView={() =>
                setBaselineTrace((previousState) => ({
                  ...previousState,
                  viewState: fitViewStateToBounds(baselineTimeBounds, 0.05),
                }))
              }
              onAttachSelection={() => attachSelectionFromTarget("baseline")}
              evidenceHighlight={baselineEvidenceHighlight}
            />
          </ResizablePanel>

          <ResizableHandle withHandle className="bg-[#d3d3d3]" />

          <ResizablePanel
            className="min-w-0 min-h-0 overflow-hidden"
            defaultSize={35}
            minSize={16}
          >
            <TracePane
              label="Candidate"
              traceData={candidateTrace.traceData}
              processes={candidateProcesses}
              viewState={candidateTrace.viewState}
              onViewStateChange={(viewState) =>
                setCandidateTrace((previousState) => ({
                  ...previousState,
                  viewState,
                }))
              }
              timeBounds={candidateTimeBounds}
              selectedEvent={candidateTrace.selectedEvent}
              onEventSelect={(event) =>
                setCandidateTrace((previousState) => ({
                  ...previousState,
                  selectedEvent: event,
                }))
              }
              tool={candidateTrace.tool}
              onToolChange={(tool) =>
                setCandidateTrace((previousState) => ({
                  ...previousState,
                  tool,
                }))
              }
              searchQuery={searchQuery}
              onRegisterApi={setCandidateTimelineApi}
              onZoomIn={() =>
                setCandidateTrace((previousState) => ({
                  ...previousState,
                  viewState: zoomViewState(previousState.viewState, 1 / 1.5),
                }))
              }
              onZoomOut={() =>
                setCandidateTrace((previousState) => ({
                  ...previousState,
                  viewState: zoomViewState(previousState.viewState, 1.5),
                }))
              }
              onFitToWindow={() =>
                setCandidateTrace((previousState) => ({
                  ...previousState,
                  viewState: fitViewStateToBounds(candidateTimeBounds, 0.02),
                }))
              }
              onResetView={() =>
                setCandidateTrace((previousState) => ({
                  ...previousState,
                  viewState: fitViewStateToBounds(candidateTimeBounds, 0.05),
                }))
              }
              onAttachSelection={() => attachSelectionFromTarget("candidate")}
              evidenceHighlight={candidateEvidenceHighlight}
            />
          </ResizablePanel>

          <ResizableHandle withHandle className="bg-[#d3d3d3]" />

          <ResizablePanel
            className="min-w-0 min-h-0 overflow-hidden"
            defaultSize={30}
            minSize={14}
          >
            <CompareFindingsPanel
              report={deepCompareReport}
              onFocusFinding={handleFocusCompareFinding}
            />
          </ResizablePanel>
        </ResizablePanelGroup>

        {renderCaptureOverlay()}
      </div>
    </div>
  );

  return (
    <div className="flex h-screen flex-col bg-white">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.json.gz"
        multiple
        onChange={handleFileChange}
        className="hidden"
      />

      <CompareControls
        mode={mode}
        onModeChange={setMode}
        baselineFilename={baselineTrace.filename}
        candidateFilename={candidateTrace.filename}
        singleFilename={singleTrace.filename}
        onLoadSingle={() => handleOpenFilePicker("single")}
        onLoadBaseline={() => handleOpenFilePicker("baseline")}
        onLoadCandidate={() => handleOpenFilePicker("candidate")}
        onExportReport={handleExportCompareReport}
        canExport={deepCompareReport !== null}
        onOpenCommandPalette={handleOpenCommandPalette}
        hasSavedTraces={hasSavedTraces}
        onClearSavedTraces={handleClearSavedTraces}
      />

      <ResizablePanelGroup direction="horizontal" className="flex-1 min-w-0 min-h-0 overflow-hidden">
        <ResizablePanel className="min-w-0 min-h-0 overflow-hidden" defaultSize={74} minSize={35}>
          {mode === "deep" ? renderDeepWorkspace() : renderSingleWorkspace()}
        </ResizablePanel>

        <ResizableHandle withHandle className="bg-[#ccc]" />

        <ResizablePanel className="min-w-0 min-h-0 overflow-hidden" defaultSize={26} minSize={18}>
          <ChatPanel
            enabled={chatEnabled}
            model={chatModel}
            mode={mode}
            hasTrace={
              mode === "deep"
                ? baselineTrace.traceData !== null || candidateTrace.traceData !== null
                : singleTrace.traceData !== null
            }
            currentTraceLabel={chatContext.currentTrace?.label}
            previousTraceLabel={mode === "deep" ? undefined : chatContext.previousTrace?.label}
            baselineTraceLabel={baselineTraceSnapshot?.label}
            candidateTraceLabel={candidateTraceSnapshot?.label}
            messages={chatMessages}
            attachments={pendingAttachments}
            isBusy={chatBusy}
            isCaptureMode={isCaptureMode}
            errorMessage={chatErrorMessage}
            onRemoveAttachment={handleRemoveAttachment}
            onSendMessage={handleSendMessage}
            onStartAreaCapture={handleStartAreaCapture}
            onClearHistory={handleClearHistory}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      <CommandPalette
        open={isCommandPaletteOpen}
        onOpenChange={setIsCommandPaletteOpen}
        mode={mode}
        hasTrace={
          mode === "deep"
            ? baselineTrace.traceData !== null || candidateTrace.traceData !== null
            : singleTrace.traceData !== null
        }
        canExport={deepCompareReport !== null}
        onLoadSingle={() => handleOpenFilePicker("single")}
        onLoadBaseline={() => handleOpenFilePicker("baseline")}
        onLoadCandidate={() => handleOpenFilePicker("candidate")}
        onSetMode={setMode}
        onExportReport={handleExportCompareReport}
        onCaptureArea={handleStartAreaCapture}
        onZoomIn={mode === "deep"
          ? () =>
              setCandidateTrace((previousState) => ({
                ...previousState,
                viewState: zoomViewState(previousState.viewState, 1 / 1.5),
              }))
          : handleZoomIn}
        onZoomOut={mode === "deep"
          ? () =>
              setCandidateTrace((previousState) => ({
                ...previousState,
                viewState: zoomViewState(previousState.viewState, 1.5),
              }))
          : handleZoomOut}
        onPanLeft={handlePanLeft}
        onPanRight={handlePanRight}
        onFitToWindow={mode === "deep"
          ? () =>
              setCandidateTrace((previousState) => ({
                ...previousState,
                viewState: fitViewStateToBounds(candidateTimeBounds, 0.02),
              }))
          : handleFitToWindow}
        onSelectTool={handleSelectTool}
        onPanTool={handlePanTool}
        onClearSelection={handleClearSelection}
        onClearHistory={handleClearHistory}
        hasSavedTraces={hasSavedTraces}
        onClearSavedTraces={handleClearSavedTraces}
      />
      {renderRunLoadOverlay()}
    </div>
  );
}
