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
import type { TraceData, TraceEvent, Process, ViewState } from "@/lib/trace-types";
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
  TraceSnapshot,
} from "@/lib/trace-chat";
import {
  buildTraceDiffSummary,
  buildTraceIndex,
  buildTraceSnapshot,
  buildViewportSummary,
  inspectTraceEvent,
  searchTraceEvents,
} from "@/lib/trace-analysis";
import { formatTimeShort } from "@/lib/trace-types";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Toolbar } from "./toolbar";
import { Timeline } from "./timeline";
import { DetailsPanel } from "./details-panel";
import { EmptyState } from "./empty-state";
import { StatusBar } from "./status-bar";
import { Minimap } from "./minimap";
import { SideToolbar } from "./side-toolbar";
import { ChatPanel } from "./chat-panel";
import type { ChatPanelMessage } from "./chat-panel";

interface TracingViewerProps {
  chatEnabled: boolean;
  chatModel: string;
}

interface TimelineApi {
  captureImage: () => string | null;
}

interface ToolExecutionRuntime {
  viewState: ViewState;
  selectedEvent: TraceEvent | null;
}

interface ToolExecutionResult {
  output: unknown;
  logMessage: string;
  runtime: ToolExecutionRuntime;
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

const TOOL_STEP_LIMIT = 6;
const MIN_CAPTURE_SIZE_PX = 24;
const GITHUB_URL_REGEX = /https?:\/\/github\.com\/[^\s<>()\]]+/gi;
const TRACE_AGENT_CHAT_STORAGE_KEY = "trace-agent-chat-session:v1";
const TRACE_AGENT_TRACE_STORAGE_KEY = "trace-agent-last-trace:v1";

function createLocalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function buildAttachedTraceSummary(trace: TraceSnapshot): AttachedTraceSummary {
  return {
    id: trace.id,
    label: trace.label,
    filename: trace.filename,
    loadedAt: trace.loadedAt,
    eventCount: trace.eventCount,
    bounds: trace.bounds,
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
      displayMessage += `@[${normalizedUrl}]`;
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

function sanitizeAttachmentsForPersistence(
  attachments: TraceChatAttachment[] | undefined
): TraceChatAttachment[] | undefined {
  if (!attachments?.length) return undefined;

  const persistentAttachments = attachments
    .filter((attachment) => attachment.kind !== "image")
    .map(cloneAttachment);

  return persistentAttachments.length > 0 ? persistentAttachments : undefined;
}

export function TracingViewer({ chatEnabled, chatModel }: TracingViewerProps) {
  const [traceData, setTraceData] = useState<TraceData | null>(null);
  const [traceLoadedAt, setTraceLoadedAt] = useState<string | null>(null);
  const [previousTraceSnapshot, setPreviousTraceSnapshot] = useState<TraceSnapshot | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<TraceEvent | null>(null);
  const [tool, setTool] = useState<"select" | "pan">("select");
  const [searchQuery, setSearchQuery] = useState("");
  const [filename, setFilename] = useState<string | undefined>();
  const [showFlowEvents, setShowFlowEvents] = useState(false);
  const [showProcesses, setShowProcesses] = useState(true);
  const [viewState, setViewState] = useState<ViewState>({
    startTime: 0,
    endTime: 1000000,
    scale: 1,
  });
  const [chatMessages, setChatMessages] = useState<ChatPanelMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatErrorMessage, setChatErrorMessage] = useState<string | null>(null);
  const [chatResponseId, setChatResponseId] = useState<string | null>(null);
  const [timelineApi, setTimelineApi] = useState<TimelineApi | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<TraceChatAttachment[]>([]);
  const [isCaptureMode, setIsCaptureMode] = useState(false);
  const [captureOrigin, setCaptureOrigin] = useState<CapturePoint | null>(null);
  const [captureCurrent, setCaptureCurrent] = useState<CapturePoint | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const hasRestoredPersistentChatRef = useRef(false);

  const processes = useMemo(() => {
    if (!traceData) return new Map<number, Process>();

    const processMap = new Map<number, Process>();

    for (const event of traceData.traceEvents) {
      if (event.ph === "M") {
        if (event.name === "process_name") {
          if (!processMap.has(event.pid)) {
            processMap.set(event.pid, {
              pid: event.pid,
              name: String(event.args?.name || `Process ${event.pid}`),
              threads: new Map(),
            });
          } else {
            const process = processMap.get(event.pid)!;
            process.name = String(event.args?.name || process.name);
          }
        } else if (event.name === "thread_name") {
          if (!processMap.has(event.pid)) {
            processMap.set(event.pid, {
              pid: event.pid,
              name: `Process ${event.pid}`,
              threads: new Map(),
            });
          }
          const process = processMap.get(event.pid)!;
          if (!process.threads.has(event.tid)) {
            process.threads.set(event.tid, {
              pid: event.pid,
              tid: event.tid,
              name: String(event.args?.name || `Thread ${event.tid}`),
              events: [],
            });
          } else {
            const thread = process.threads.get(event.tid)!;
            thread.name = String(event.args?.name || thread.name);
          }
        }
      }
    }

    for (const event of traceData.traceEvents) {
      if (event.ph === "M") continue;

      if (!processMap.has(event.pid)) {
        processMap.set(event.pid, {
          pid: event.pid,
          name: `Process ${event.pid}`,
          threads: new Map(),
        });
      }

      const process = processMap.get(event.pid)!;

      if (!process.threads.has(event.tid)) {
        process.threads.set(event.tid, {
          pid: event.pid,
          tid: event.tid,
          name: `Thread ${event.tid}`,
          events: [],
        });
      }

      process.threads.get(event.tid)!.events.push(event);
    }

    for (const process of processMap.values()) {
      for (const [tid, thread] of process.threads) {
        if (thread.events.length === 0) {
          process.threads.delete(tid);
          continue;
        }

        thread.events.sort((a, b) => a.ts - b.ts);
      }
    }

    for (const [pid, process] of processMap) {
      if (process.threads.size === 0) {
        processMap.delete(pid);
      }
    }

    return processMap;
  }, [traceData]);

  const traceIndex = useMemo(() => buildTraceIndex(traceData, processes), [traceData, processes]);

  const currentTraceSnapshot = useMemo(() => {
    if (!traceData || !traceIndex) return null;

    return buildTraceSnapshot(traceData, traceIndex, {
      label: filename ?? "Current trace",
      filename,
      loadedAt: traceLoadedAt ?? undefined,
    });
  }, [filename, traceData, traceIndex, traceLoadedAt]);

  const currentSelectedEventId = useMemo(() => {
    if (!selectedEvent || !traceIndex) return null;
    return resolveTraceEventId(traceIndex, selectedEvent);
  }, [selectedEvent, traceIndex]);

  const currentViewSummary = useMemo(() => {
    if (!traceIndex) return null;
    return buildViewportSummary(traceIndex, {
      viewState,
      selectedEventId: currentSelectedEventId,
      searchQuery,
    });
  }, [currentSelectedEventId, searchQuery, traceIndex, viewState]);

  const comparisonToPrevious = useMemo(
    () => buildTraceDiffSummary(previousTraceSnapshot, currentTraceSnapshot),
    [currentTraceSnapshot, previousTraceSnapshot]
  );

  const chatContext = useMemo<TraceChatContext>(
    () => ({
      currentTrace: currentTraceSnapshot,
      previousTrace: previousTraceSnapshot,
      currentView: currentViewSummary,
      comparisonToPrevious,
    }),
    [comparisonToPrevious, currentTraceSnapshot, currentViewSummary, previousTraceSnapshot]
  );

  const captureRect = useMemo(
    () => normalizeCaptureRect(captureOrigin, captureCurrent),
    [captureCurrent, captureOrigin]
  );

  const timeBounds = useMemo(() => {
    if (!traceData || traceData.traceEvents.length === 0) {
      return { min: 0, max: 1000000 };
    }

    let min = Infinity;
    let max = -Infinity;

    for (const event of traceData.traceEvents) {
      if (event.ph === "M") continue;
      min = Math.min(min, event.ts);
      max = Math.max(max, event.ts + (event.dur || 0));
    }

    return { min, max };
  }, [traceData]);

  const buildRuntimeChatContext = useCallback(
    (runtime: ToolExecutionRuntime): TraceChatContext => {
      if (!traceIndex) {
        return {
          currentTrace: currentTraceSnapshot,
          previousTrace: previousTraceSnapshot,
          currentView: null,
          comparisonToPrevious,
        };
      }

      const selectedEventId = resolveTraceEventId(traceIndex, runtime.selectedEvent);

      return {
        currentTrace: currentTraceSnapshot,
        previousTrace: previousTraceSnapshot,
        currentView: buildViewportSummary(traceIndex, {
          viewState: runtime.viewState,
          selectedEventId,
          searchQuery,
        }),
        comparisonToPrevious: buildTraceDiffSummary(
          previousTraceSnapshot,
          currentTraceSnapshot
        ),
      };
    },
    [
      comparisonToPrevious,
      currentTraceSnapshot,
      previousTraceSnapshot,
      searchQuery,
      traceIndex,
    ]
  );

  const loadTraceData = useCallback(
    (data: TraceData, name?: string) => {
      if (currentTraceSnapshot) {
        setPreviousTraceSnapshot(currentTraceSnapshot);
      }

      const loadedAt = new Date().toISOString();
      setTraceLoadedAt(loadedAt);
      setTraceData(data);
      setSelectedEvent(null);
      setFilename(name);
      setIsCaptureMode(false);
      setCaptureOrigin(null);
      setCaptureCurrent(null);

      let min = Infinity;
      let max = -Infinity;

      for (const event of data.traceEvents) {
        if (event.ph === "M") continue;
        min = Math.min(min, event.ts);
        max = Math.max(max, event.ts + (event.dur || 0));
      }

      const padding = (max - min) * 0.05;
      setViewState({
        startTime: min - padding,
        endTime: max + padding,
        scale: 1,
      });

      const traceLabel = name ?? "trace";
      setChatMessages((previousMessages) => [
        ...previousMessages,
        {
          id: createLocalId("tool"),
          role: "tool",
          content: currentTraceSnapshot
            ? `Loaded ${traceLabel}. Previous trace "${currentTraceSnapshot.label}" is still available for comparison.`
            : `Loaded ${traceLabel}.`,
        },
      ]);
    },
    [currentTraceSnapshot]
  );

  const handleLoadFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const content = event.target?.result as string;
          const data = JSON.parse(content) as TraceData;

          if (Array.isArray(data)) {
            loadTraceData({ traceEvents: data }, file.name);
          } else if (data.traceEvents) {
            loadTraceData(data, file.name);
          } else {
            alert("Invalid trace format. Expected Chrome trace JSON format.");
          }
        } catch {
          alert("Failed to parse trace file. Make sure it's valid JSON.");
        }
      };
      reader.readAsText(file);

      e.target.value = "";
    },
    [loadTraceData]
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
        const nextAttachment: TraceChatAttachment = {
          id: createLocalId("image"),
          kind: "image",
          source: "manual_capture",
          label: `Trace capture ${previousAttachments.filter((item) => item.kind === "image").length + 1}`,
          createdAt,
          traceId: currentTraceSnapshot?.id ?? null,
          traceLabel: currentTraceSnapshot?.label ?? null,
          imageDataUrl: croppedCanvas.toDataURL("image/png"),
          mimeType: "image/png",
          width: sourceWidth,
          height: sourceHeight,
        };

        return [...previousAttachments, nextAttachment];
      });
      setChatErrorMessage(null);
    },
    [currentTraceSnapshot]
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

  const handleAttachSelectionToChat = useCallback(() => {
    if (!selectedEvent || !traceIndex || !currentTraceSnapshot) {
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
      traceId: currentTraceSnapshot.id,
      traceLabel: currentTraceSnapshot.label,
      fingerprint: [
        currentTraceSnapshot.id,
        eventId,
        inspection.event.ts,
        inspection.event.dur,
        inspection.event.pid,
        inspection.event.tid,
      ].join(":"),
      trace: buildAttachedTraceSummary(currentTraceSnapshot),
      event: inspection.event,
      inspection,
      rawEvent: JSON.parse(JSON.stringify(selectedEvent)) as TraceEvent,
    };

    setPendingAttachments((previousAttachments) => [
      ...previousAttachments,
      nextAttachment,
    ]);
    setChatErrorMessage(null);
  }, [currentTraceSnapshot, selectedEvent, traceIndex]);

  const handleZoomIn = useCallback(() => {
    const center = (viewState.startTime + viewState.endTime) / 2;
    const duration = viewState.endTime - viewState.startTime;
    const newDuration = duration / 1.5;
    setViewState({
      ...viewState,
      startTime: center - newDuration / 2,
      endTime: center + newDuration / 2,
    });
  }, [viewState]);

  const handleZoomOut = useCallback(() => {
    const center = (viewState.startTime + viewState.endTime) / 2;
    const duration = viewState.endTime - viewState.startTime;
    const newDuration = duration * 1.5;
    setViewState({
      ...viewState,
      startTime: center - newDuration / 2,
      endTime: center + newDuration / 2,
    });
  }, [viewState]);

  const handleResetView = useCallback(() => {
    const padding = (timeBounds.max - timeBounds.min) * 0.05;
    setViewState({
      startTime: timeBounds.min - padding,
      endTime: timeBounds.max + padding,
      scale: 1,
    });
  }, [timeBounds]);

  const handleFitToWindow = useCallback(() => {
    const padding = (timeBounds.max - timeBounds.min) * 0.02;
    setViewState({
      startTime: timeBounds.min - padding,
      endTime: timeBounds.max + padding,
      scale: 1,
    });
  }, [timeBounds]);

  const handlePanLeft = useCallback(() => {
    const duration = viewState.endTime - viewState.startTime;
    const panAmount = duration * 0.2;
    setViewState({
      ...viewState,
      startTime: viewState.startTime - panAmount,
      endTime: viewState.endTime - panAmount,
    });
  }, [viewState]);

  const handlePanRight = useCallback(() => {
    const duration = viewState.endTime - viewState.startTime;
    const panAmount = duration * 0.2;
    setViewState({
      ...viewState,
      startTime: viewState.startTime + panAmount,
      endTime: viewState.endTime + panAmount,
    });
  }, [viewState]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

       if (isCaptureMode && e.key === "Escape") {
        e.preventDefault();
        cancelAreaCapture();
        return;
      }

      switch (e.key.toLowerCase()) {
        case "w":
          handleZoomIn();
          break;
        case "s":
          handleZoomOut();
          break;
        case "a":
          handlePanLeft();
          break;
        case "d":
          handlePanRight();
          break;
        case "1":
          setTool("select");
          break;
        case "2":
          setTool("pan");
          break;
        case "0":
          handleFitToWindow();
          break;
        case "escape":
          setSelectedEvent(null);
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    cancelAreaCapture,
    handleFitToWindow,
    handlePanLeft,
    handlePanRight,
    handleZoomIn,
    handleZoomOut,
    isCaptureMode,
  ]);

  const requestTraceChat = useCallback(
    async (
      payload: {
        previousResponseId: string | null;
        userMessage?: string | null;
        toolOutputs?: TraceChatToolResult[];
        context: TraceChatContext;
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

        let event: TraceChatStreamEvent;
        try {
          event = JSON.parse(line) as TraceChatStreamEvent;
        } catch {
          return;
        }

        if (event.type === "assistant_delta") {
          onAssistantDelta(event.delta);
          return;
        }

        if (event.type === "assistant_done") {
          finalResponse = event.response;
          return;
        }

        if (event.type === "error") {
          throw new Error(event.error);
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
        viewState: runtime.viewState,
        selectedEvent: runtime.selectedEvent,
      };

      if (!traceIndex || !currentTraceSnapshot) {
        return {
          runtime: nextRuntime,
          logMessage: "Assistant requested a trace inspection before any trace was loaded.",
          output: {
            success: false,
            error: "No trace is currently loaded.",
          },
        };
      }

      switch (toolCall.name) {
        case "search_events": {
          const query =
            typeof toolCall.arguments.query === "string" ? toolCall.arguments.query : "";
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          const matches = searchTraceEvents(traceIndex, query, limit, nextRuntime.viewState);

          return {
            runtime: nextRuntime,
            logMessage: matches.length
              ? `Assistant searched for "${query}" and found ${matches.length} matching spans.`
              : `Assistant searched for "${query}" but found no matching spans.`,
            output: {
              query,
              matchCount: matches.length,
              matches,
            },
          };
        }

        case "inspect_event": {
          const eventId =
            typeof toolCall.arguments.event_id === "string"
              ? toolCall.arguments.event_id
              : "";
          const inspection = inspectTraceEvent(traceIndex, eventId);

          return {
            runtime: nextRuntime,
            logMessage: inspection
              ? `Assistant inspected ${inspection.event.name} on ${inspection.event.threadName}.`
              : "Assistant tried to inspect an event that is no longer available.",
            output:
              inspection ?? {
                success: false,
                error: `Event "${eventId}" was not found in the current trace.`,
              },
          };
        }

        case "inspect_current_view": {
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          const selectedEventId = resolveTraceEventId(
            traceIndex,
            nextRuntime.selectedEvent
          );
          const viewSummary = buildViewportSummary(traceIndex, {
            viewState: nextRuntime.viewState,
            selectedEventId,
            searchQuery,
          });

          return {
            runtime: nextRuntime,
            logMessage: "Assistant inspected the current viewport.",
            output: {
              ...viewSummary,
              topVisibleHotspots: viewSummary.topVisibleHotspots.slice(0, limit),
              topVisibleSpikeHotspots: viewSummary.topVisibleSpikeHotspots.slice(0, limit),
              longestVisibleEvents: viewSummary.longestVisibleEvents.slice(0, limit),
              sampleVisibleSpikeEvents: viewSummary.sampleVisibleSpikeEvents.slice(0, limit),
              visibleProcesses: viewSummary.visibleProcesses.slice(0, Math.min(limit, 6)),
              searchMatches: viewSummary.searchMatches.slice(0, limit),
            },
          };
        }

        case "focus_event": {
          const eventId =
            typeof toolCall.arguments.event_id === "string"
              ? toolCall.arguments.event_id
              : "";
          const paddingRatio = clampNumber(toolCall.arguments.padding_ratio, 0, 2, 0.35);
          const targetEvent = traceIndex.eventById.get(eventId);

          if (!targetEvent) {
            return {
              runtime: nextRuntime,
              logMessage: "Assistant tried to focus an event that is no longer available.",
              output: {
                success: false,
                error: `Event "${eventId}" was not found in the current trace.`,
              },
            };
          }

          const baseDuration = Math.max(targetEvent.dur, 25000);
          const padding = Math.max(baseDuration * paddingRatio, 10000);
          nextRuntime.viewState = {
            startTime: targetEvent.ts - padding,
            endTime: targetEvent.endTime + padding,
            scale: 1,
          };
          nextRuntime.selectedEvent = targetEvent.event;

          setSelectedEvent(targetEvent.event);
          setViewState(nextRuntime.viewState);
          await waitForFrames();

          const inspection = inspectTraceEvent(traceIndex, eventId);
          const selectedEventId = resolveTraceEventId(
            traceIndex,
            nextRuntime.selectedEvent
          );
          const viewSummary = buildViewportSummary(traceIndex, {
            viewState: nextRuntime.viewState,
            selectedEventId,
            searchQuery,
          });

          return {
            runtime: nextRuntime,
            logMessage: `Assistant focused ${targetEvent.name} on ${targetEvent.threadName}.`,
            output: {
              success: true,
              focusedEvent: inspection?.event ?? null,
              currentView: viewSummary,
            },
          };
        }

        case "set_view_range": {
          const startTimeUs = clampNumber(
            toolCall.arguments.start_time_us,
            -Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER,
            nextRuntime.viewState.startTime
          );
          const endTimeUs = clampNumber(
            toolCall.arguments.end_time_us,
            -Number.MAX_SAFE_INTEGER,
            Number.MAX_SAFE_INTEGER,
            nextRuntime.viewState.endTime
          );
          const minSpan = 1000;
          const startTime = Math.min(startTimeUs, endTimeUs - minSpan);
          const endTime = Math.max(endTimeUs, startTimeUs + minSpan);
          nextRuntime.viewState = {
            startTime,
            endTime,
            scale: 1,
          };

          setViewState(nextRuntime.viewState);
          await waitForFrames();

          const selectedEventId = resolveTraceEventId(
            traceIndex,
            nextRuntime.selectedEvent
          );
          const viewSummary = buildViewportSummary(traceIndex, {
            viewState: nextRuntime.viewState,
            selectedEventId,
            searchQuery,
          });

          return {
            runtime: nextRuntime,
            logMessage: `Assistant zoomed to a ${formatTimeShort(
              endTime - startTime
            )} window.`,
            output: {
              success: true,
              currentView: viewSummary,
            },
          };
        }

        case "fit_to_trace": {
          const includePadding = Boolean(toolCall.arguments.include_padding);
          const padding = includePadding ? currentTraceSnapshot.bounds.duration * 0.02 : 0;
          nextRuntime.viewState = {
            startTime: currentTraceSnapshot.bounds.startTime - padding,
            endTime: currentTraceSnapshot.bounds.endTime + padding,
            scale: 1,
          };

          setViewState(nextRuntime.viewState);
          await waitForFrames();

          const selectedEventId = resolveTraceEventId(
            traceIndex,
            nextRuntime.selectedEvent
          );
          const viewSummary = buildViewportSummary(traceIndex, {
            viewState: nextRuntime.viewState,
            selectedEventId,
            searchQuery,
          });

          return {
            runtime: nextRuntime,
            logMessage: "Assistant reset the viewport to the full trace.",
            output: {
              success: true,
              currentView: viewSummary,
            },
          };
        }

        case "clear_selection": {
          const keepView = Boolean(toolCall.arguments.keep_view);
          nextRuntime.selectedEvent = null;
          setSelectedEvent(null);

          if (!keepView) {
            const padding = currentTraceSnapshot.bounds.duration * 0.02;
            nextRuntime.viewState = {
              startTime: currentTraceSnapshot.bounds.startTime - padding,
              endTime: currentTraceSnapshot.bounds.endTime + padding,
              scale: 1,
            };
            setViewState(nextRuntime.viewState);
          }

          await waitForFrames();

          const viewSummary = buildViewportSummary(traceIndex, {
            viewState: nextRuntime.viewState,
            selectedEventId: null,
            searchQuery,
          });

          return {
            runtime: nextRuntime,
            logMessage: "Assistant cleared the current selection.",
            output: {
              success: true,
              currentView: viewSummary,
            },
          };
        }

        case "compare_with_previous": {
          const limit = clampNumber(toolCall.arguments.limit, 1, 12, 6);
          const comparison = buildTraceDiffSummary(
            previousTraceSnapshot,
            currentTraceSnapshot
          );

          return {
            runtime: nextRuntime,
            logMessage: comparison?.available
              ? "Assistant compared the current trace with the preserved previous trace."
              : "Assistant checked for a previous trace comparison but none is available yet.",
            output: comparison
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
      currentTraceSnapshot,
      previousTraceSnapshot,
      searchQuery,
      traceIndex,
    ]
  );

  const handleSendMessage = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      const outgoingAttachments = pendingAttachments.map(cloneAttachment);
      if ((trimmed.length === 0 && outgoingAttachments.length === 0) || chatBusy) return;
      const { displayMessage, repoMentions } = extractGitHubMentions(trimmed);

      setPendingAttachments([]);
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
      let pendingRepoMentions = repoMentions.length > 0 ? repoMentions : undefined;
      const runtime: ToolExecutionRuntime = {
        viewState,
        selectedEvent,
      };

      try {
        for (let step = 0; step < TOOL_STEP_LIMIT; step += 1) {
          let streamedAssistantId: string | null = null;
          let streamedAssistantText = "";

          const response = await requestTraceChat({
            previousResponseId: latestResponseId,
            userMessage: pendingUserMessage,
            toolOutputs: pendingToolOutputs,
            context: buildRuntimeChatContext(runtime),
            screenshotDataUrl: timelineApi?.captureImage() ?? null,
            attachments: pendingRequestAttachments,
            repoMentions: pendingRepoMentions,
          }, (delta) => {
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
          });

          latestResponseId = response.responseId;
          const finalAssistantText = response.assistantText.trim();

          if (streamedAssistantId && finalAssistantText && finalAssistantText !== streamedAssistantText) {
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

          for (const toolCall of response.toolCalls) {
            const execution = await executeToolCall(toolCall, runtime);
            runtime.viewState = execution.runtime.viewState;
            runtime.selectedEvent = execution.runtime.selectedEvent;
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
          pendingRepoMentions = undefined;
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
      buildRuntimeChatContext,
      chatBusy,
      chatResponseId,
      executeToolCall,
      pendingAttachments,
      requestTraceChat,
      selectedEvent,
      timelineApi,
      viewState,
    ]
  );

  const renderMainWorkspace = () => (
    <div className="h-full flex flex-col bg-white">
      <div ref={workspaceRef} className="relative flex-1 overflow-hidden">
        {!traceData ? (
          <EmptyState onLoadFile={handleLoadFile} />
        ) : (
          <div className="flex h-full overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col">
              <Minimap
                traceData={traceData}
                viewState={viewState}
                onViewStateChange={setViewState}
                timeBounds={timeBounds}
              />
              <Timeline
                processes={processes}
                viewState={viewState}
                onViewStateChange={setViewState}
                onEventSelect={setSelectedEvent}
                selectedEvent={selectedEvent}
                tool={tool}
                searchQuery={searchQuery}
                onRegisterApi={setTimelineApi}
              />

              {selectedEvent && (
                <DetailsPanel
                  event={selectedEvent}
                  processes={processes}
                  onClose={() => setSelectedEvent(null)}
                  onAttachToChat={handleAttachSelectionToChat}
                />
              )}
            </div>

            <SideToolbar
              tool={tool}
              onToolChange={setTool}
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              onFitToWindow={handleFitToWindow}
              onResetView={handleResetView}
              hasData={traceData !== null}
            />
          </div>
        )}

        {isCaptureMode && (
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
        )}
      </div>

      {traceData && (
        <StatusBar
          viewState={viewState}
          processes={processes}
          eventCount={traceData.traceEvents.filter((event) => event.ph !== "M").length}
          selectedEvent={selectedEvent}
        />
      )}
    </div>
  );

  return (
    <div className="h-screen flex flex-col bg-white">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.json.gz"
        onChange={handleFileChange}
        className="hidden"
      />

      <Toolbar
        onLoadFile={handleLoadFile}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        hasData={traceData !== null}
        filename={filename}
        showFlowEvents={showFlowEvents}
        onToggleFlowEvents={() => setShowFlowEvents(!showFlowEvents)}
        showProcesses={showProcesses}
        onToggleProcesses={() => setShowProcesses(!showProcesses)}
      />

      <ResizablePanelGroup direction="horizontal" className="flex-1 overflow-hidden">
        <ResizablePanel defaultSize={74} minSize={45}>
          {renderMainWorkspace()}
        </ResizablePanel>
        <ResizableHandle withHandle className="bg-[#ccc]" />
        <ResizablePanel defaultSize={26} minSize={22}>
          <ChatPanel
            enabled={chatEnabled}
            model={chatModel}
            hasTrace={traceData !== null}
            currentTraceLabel={chatContext.currentTrace?.label}
            previousTraceLabel={chatContext.previousTrace?.label}
            messages={chatMessages}
            attachments={pendingAttachments}
            isBusy={chatBusy}
            isCaptureMode={isCaptureMode}
            errorMessage={chatErrorMessage}
            onRemoveAttachment={handleRemoveAttachment}
            onSendMessage={handleSendMessage}
            onStartAreaCapture={handleStartAreaCapture}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
