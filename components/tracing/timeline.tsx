"use client";

import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import type { TraceEvent, Process, ViewState } from "@/lib/trace-types";
import {
  formatTimeShort,
  getTraceEventKind,
  getEventColor,
  isSpikeEvent,
  calculateTickInterval,
  SPIKE_EVENT_DURATION_THRESHOLD_US,
} from "@/lib/trace-types";

interface TimelineProps {
  processes: Map<number, Process>;
  viewState: ViewState;
  onViewStateChange: (state: ViewState) => void;
  onEventSelect: (event: TraceEvent | null) => void;
  selectedEvent: TraceEvent | null;
  tool: "select" | "pan";
  searchQuery: string;
  onRegisterApi?: ((api: { captureImage: () => string | null } | null) => void) | undefined;
  evidenceHighlight?: TimelineEvidenceHighlight | null;
}

const ROW_HEIGHT = 14;
const PROCESS_HEADER_HEIGHT = 22;
const THREAD_HEADER_WIDTH = 180;
const TIME_RULER_HEIGHT = 22;
const SPIKE_AREA_HEIGHT = 60;
const COUNTER_TRACK_HEIGHT = 32;
const COUNTER_TRACK_GAP = 2;
const THREAD_SECTION_GAP = 6;
const MIN_EVENT_WIDTH = 1;

interface NestedEvent extends TraceEvent {
  depth: number;
}

interface CounterTrackData {
  key: string;
  name: string;
  events: Array<{ ts: number; value: number }>;
  minValue: number;
  maxValue: number;
}

interface ProcessThreadData {
  tid: number;
  threadName: string;
  maxDepth: number;
  events: NestedEvent[];
  instantEvents: TraceEvent[];
  counterTracks: CounterTrackData[];
}

interface ThreadLayoutEntry {
  tid: number;
  threadName: string;
  flameTop: number;
  flameHeight: number;
  spikeTop: number;
  counterTop: number;
  counterHeight: number;
  contentHeight: number;
  eventCount: number;
  spikeCount: number;
  counterTrackCount: number;
}

export interface TimelineEvidenceHighlight {
  id: string;
  title: string;
  description?: string;
  startTime: number;
  endTime: number;
  processName?: string;
  threadName?: string;
  event?: TraceEvent | null;
}

interface ProcessLayoutEntry {
  pid: number;
  processName: string;
  headerTop: number;
  contentTop: number;
  contentHeight: number;
  collapsed: boolean;
  threadLayouts: ThreadLayoutEntry[];
}

interface HighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface HighlightOverlayGeometry {
  band: HighlightRect;
  exact: HighlightRect | null;
  markerLeft: number;
  markerTop: number;
}

function numericCounterValue(event: TraceEvent): number | null {
  if (!event.args) return null;
  for (const value of Object.values(event.args)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function areSameTraceEvent(a: TraceEvent, b: TraceEvent): boolean {
  return (
    a.name === b.name &&
    a.ts === b.ts &&
    a.pid === b.pid &&
    a.tid === b.tid &&
    (a.dur ?? 0) === (b.dur ?? 0) &&
    a.ph === b.ph
  );
}

function getSpikeHeight(event: TraceEvent): number {
  if ((event.dur ?? 0) > 0) {
    const durationRatio = Math.min(
      1,
      (event.dur ?? 0) / SPIKE_EVENT_DURATION_THRESHOLD_US
    );
    return 8 + durationRatio * (SPIKE_AREA_HEIGHT - 16);
  }

  return 14;
}

// Darken a color
function darkenColor(color: string, factor: number): string {
  const hex = color.replace("#", "");
  const r = Math.max(0, parseInt(hex.substring(0, 2), 16) * (1 - factor));
  const g = Math.max(0, parseInt(hex.substring(2, 4), 16) * (1 - factor));
  const b = Math.max(0, parseInt(hex.substring(4, 6), 16) * (1 - factor));
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

// Get contrast color for text
function getContrastColor(bgColor: string): string {
  const hex = bgColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000" : "#fff";
}

function truncateCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }

  let truncated = text;
  while (truncated.length > 4 && ctx.measureText(`${truncated}...`).width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }

  return truncated.length < text.length ? `${truncated}...` : truncated;
}

function buildNestedEvents(events: TraceEvent[]): { maxDepth: number; events: NestedEvent[] } {
  const sortedEvents = events.slice().sort((left, right) => {
    if (left.ts !== right.ts) return left.ts - right.ts;
    return (right.dur || 0) - (left.dur || 0);
  });
  const nestedEvents: NestedEvent[] = [];
  const activeIntervals: { end: number; depth: number }[] = [];

  for (const event of sortedEvents) {
    const eventEnd = event.ts + (event.dur || 0);

    while (activeIntervals.length > 0) {
      let allEnded = true;
      for (let index = activeIntervals.length - 1; index >= 0; index -= 1) {
        if (activeIntervals[index].end > event.ts) {
          allEnded = false;
          break;
        }
      }
      if (allEnded) {
        activeIntervals.pop();
      } else {
        break;
      }
    }

    const stillActive = activeIntervals.filter((interval) => interval.end > event.ts);
    activeIntervals.length = 0;
    activeIntervals.push(...stillActive);

    let depth = 0;
    for (const interval of activeIntervals) {
      if (interval.end > event.ts) {
        depth = Math.max(depth, interval.depth + 1);
      }
    }

    nestedEvents.push({ ...event, depth });
    activeIntervals.push({ end: eventEnd, depth });
    activeIntervals.sort((left, right) => right.end - left.end);
  }

  const maxDepth = nestedEvents.reduce((max, event) => Math.max(max, event.depth), -1) + 1;
  return {
    maxDepth: Math.max(maxDepth, 1),
    events: nestedEvents,
  };
}

export function Timeline({
  processes,
  viewState,
  onViewStateChange,
  onEventSelect,
  selectedEvent,
  tool,
  searchQuery,
  onRegisterApi,
  evidenceHighlight,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [scrollY, setScrollY] = useState(0);
  const [hoveredEvent, setHoveredEvent] = useState<TraceEvent | null>(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [collapsedProcesses, setCollapsedProcesses] = useState<Set<number>>(new Set());
  const [activeEvidenceHighlight, setActiveEvidenceHighlight] =
    useState<TimelineEvidenceHighlight | null>(null);
  const [isEvidenceHighlightFading, setIsEvidenceHighlightFading] = useState(false);
  const evidenceHighlightTimeoutsRef = useRef<{
    fade: number | null;
    clear: number | null;
  }>({
    fade: null,
    clear: null,
  });

  const captureImage = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) return null;

    const maxWidth = 1600;
    const displayWidth = Math.max(canvasSize.width, 1);
    const displayHeight = Math.max(canvasSize.height, 1);
    const scale = Math.min(1, maxWidth / displayWidth);
    const exportWidth = Math.max(1, Math.round(displayWidth * scale));
    const exportHeight = Math.max(1, Math.round(displayHeight * scale));
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = exportWidth;
    exportCanvas.height = exportHeight;
    const exportContext = exportCanvas.getContext("2d");

    if (!exportContext) return null;

    exportContext.drawImage(
      canvas,
      0,
      0,
      canvas.width,
      canvas.height,
      0,
      0,
      exportWidth,
      exportHeight
    );

    return exportCanvas.toDataURL("image/png");
  }, [canvasSize.height, canvasSize.width]);

  useEffect(() => {
    if (!onRegisterApi) return;

    onRegisterApi({
      captureImage,
    });

    return () => onRegisterApi(null);
  }, [captureImage, onRegisterApi]);

  // Calculate nested events with depth for flame graph
  const processedData = useMemo(() => {
    const result = new Map<number, { threads: ProcessThreadData[] }>();

    processes.forEach((process, pid) => {
      const threads = [...process.threads.values()]
        .sort((left, right) => left.tid - right.tid)
        .map((thread) => {
          const spanEvents = thread.events.filter(
            (event) => getTraceEventKind(event) === "span"
          );
          const instantEvents = thread.events.filter((event) => isSpikeEvent(event));
          const nested = buildNestedEvents(spanEvents);

          const counterGroupMap = new Map<string, {
            name: string;
            events: Array<{ ts: number; value: number }>;
          }>();
          for (const event of thread.events) {
            if (getTraceEventKind(event) !== "counter") continue;
            const value = numericCounterValue(event);
            if (value === null) continue;
            const key = `${event.name}::${event.cat}`;
            const group = counterGroupMap.get(key) ?? { name: event.name, events: [] };
            group.events.push({ ts: event.ts, value });
            counterGroupMap.set(key, group);
          }
          const counterTracks: CounterTrackData[] = [];
          for (const [key, group] of counterGroupMap) {
            group.events.sort((a, b) => a.ts - b.ts);
            let min = Infinity;
            let max = -Infinity;
            for (const e of group.events) {
              if (e.value < min) min = e.value;
              if (e.value > max) max = e.value;
            }
            counterTracks.push({ key, name: group.name, events: group.events, minValue: min, maxValue: max });
          }

          return {
            tid: thread.tid,
            threadName: thread.name,
            maxDepth: nested.maxDepth,
            events: nested.events,
            instantEvents,
            counterTracks,
          };
        })
        .filter((thread) => thread.events.length > 0 || thread.instantEvents.length > 0 || thread.counterTracks.length > 0);

      result.set(pid, { threads });
    });

    return result;
  }, [processes]);

  const processLayouts = useMemo(() => {
    const layouts: ProcessLayoutEntry[] = [];
    let currentY = TIME_RULER_HEIGHT;

    processes.forEach((process, pid) => {
      const data = processedData.get(pid);
      const collapsed = collapsedProcesses.has(pid);
      const headerTop = currentY;
      const contentTop = headerTop + PROCESS_HEADER_HEIGHT;
      const threadLayouts: ThreadLayoutEntry[] = [];
      let threadCursorY = contentTop;

      if (!collapsed && data) {
        data.threads.forEach((thread, index) => {
          if (index > 0) {
            threadCursorY += THREAD_SECTION_GAP;
          }

          const flameHeight = thread.maxDepth * ROW_HEIGHT;
          const spikeTop = threadCursorY + flameHeight;
          const counterTop = threadCursorY + flameHeight + SPIKE_AREA_HEIGHT;
          const counterHeight = thread.counterTracks.length > 0
            ? thread.counterTracks.length * COUNTER_TRACK_HEIGHT
              + (thread.counterTracks.length - 1) * COUNTER_TRACK_GAP
            : 0;
          const contentHeight = flameHeight + SPIKE_AREA_HEIGHT + counterHeight;

          threadLayouts.push({
            tid: thread.tid,
            threadName: thread.threadName,
            flameTop: threadCursorY,
            flameHeight,
            spikeTop,
            counterTop,
            counterHeight,
            contentHeight,
            eventCount: thread.events.length,
            spikeCount: thread.instantEvents.length,
            counterTrackCount: thread.counterTracks.length,
          });

          threadCursorY += contentHeight;
        });
      }

      const contentHeight =
        threadLayouts.length > 0
          ? threadCursorY - contentTop
          : 0;

      layouts.push({
        pid,
        processName: process.name,
        headerTop,
        contentTop,
        contentHeight,
        collapsed,
        threadLayouts,
      });

      currentY += PROCESS_HEADER_HEIGHT + contentHeight;
    });

    return layouts;
  }, [collapsedProcesses, processes, processedData]);

  // Calculate total height needed
  const totalHeight = useMemo(() => {
    const lastLayout = processLayouts[processLayouts.length - 1];
    if (!lastLayout) return TIME_RULER_HEIGHT;

    return lastLayout.headerTop + PROCESS_HEADER_HEIGHT + lastLayout.contentHeight;
  }, [processLayouts]);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ width, height });
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Time to pixel conversion
  const timeToPixel = useCallback(
    (time: number): number => {
      const visibleDuration = viewState.endTime - viewState.startTime;
      const drawableWidth = Math.max(canvasSize.width - THREAD_HEADER_WIDTH, 1);
      const pixelsPerMicrosecond = drawableWidth / Math.max(visibleDuration, 1);
      return THREAD_HEADER_WIDTH + (time - viewState.startTime) * pixelsPerMicrosecond;
    },
    [viewState, canvasSize.width]
  );

  // Pixel to time conversion
  const pixelToTime = useCallback(
    (pixel: number): number => {
      const visibleDuration = viewState.endTime - viewState.startTime;
      const drawableWidth = Math.max(canvasSize.width - THREAD_HEADER_WIDTH, 1);
      const pixelsPerMicrosecond = drawableWidth / Math.max(visibleDuration, 1);
      return viewState.startTime + (pixel - THREAD_HEADER_WIDTH) / pixelsPerMicrosecond;
    },
    [viewState, canvasSize.width]
  );

  const clearEvidenceHighlightTimeouts = useCallback(() => {
    const { fade, clear } = evidenceHighlightTimeoutsRef.current;
    if (fade !== null) {
      window.clearTimeout(fade);
      evidenceHighlightTimeoutsRef.current.fade = null;
    }
    if (clear !== null) {
      window.clearTimeout(clear);
      evidenceHighlightTimeoutsRef.current.clear = null;
    }
  }, []);

  useEffect(() => {
    if (!evidenceHighlight) return;

    clearEvidenceHighlightTimeouts();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveEvidenceHighlight(evidenceHighlight);
    setIsEvidenceHighlightFading(false);

    evidenceHighlightTimeoutsRef.current.fade = window.setTimeout(() => {
      setIsEvidenceHighlightFading(true);
    }, 4200);

    evidenceHighlightTimeoutsRef.current.clear = window.setTimeout(() => {
      setActiveEvidenceHighlight((currentHighlight) =>
        currentHighlight?.id === evidenceHighlight.id ? null : currentHighlight
      );
      setIsEvidenceHighlightFading(false);
    }, 5000);
  }, [clearEvidenceHighlightTimeouts, evidenceHighlight]);

  useEffect(() => clearEvidenceHighlightTimeouts, [clearEvidenceHighlightTimeouts]);

  const resolveHighlightProcessId = useCallback(
    (highlight: TimelineEvidenceHighlight | null): number | null => {
      if (!highlight) return null;
      if (highlight.event) return highlight.event.pid;

      if (!highlight.processName) return null;

      for (const [pid, process] of processes) {
        if (process.name === highlight.processName) {
          return pid;
        }
      }

      return null;
    },
    [processes]
  );

  const resolveHighlightThreadLayout = useCallback(
    (
      highlight: TimelineEvidenceHighlight,
      layout: ProcessLayoutEntry
    ): ThreadLayoutEntry | null => {
      if (highlight.event) {
        return (
          layout.threadLayouts.find((threadLayout) => threadLayout.tid === highlight.event?.tid) ??
          null
        );
      }

      if (highlight.threadName) {
        return (
          layout.threadLayouts.find((threadLayout) => threadLayout.threadName === highlight.threadName) ??
          null
        );
      }

      return null;
    },
    []
  );

  const resolveExactHighlightRect = useCallback(
    (
      highlight: TimelineEvidenceHighlight,
      layout: ProcessLayoutEntry
    ): HighlightRect | null => {
      if (!highlight.event) return null;

      const data = processedData.get(layout.pid);
      if (!data) return null;
      const threadLayout = resolveHighlightThreadLayout(highlight, layout);
      if (!threadLayout) return null;
      const threadData = data.threads.find((thread) => thread.tid === threadLayout.tid);
      if (!threadData) return null;

      if (isSpikeEvent(highlight.event)) {
        const spikeEvent = threadData.instantEvents.find((event) =>
          areSameTraceEvent(event, highlight.event!)
        );
        if (!spikeEvent) return null;

        const spikeX = timeToPixel(spikeEvent.ts);
        const spikeHeight = getSpikeHeight(spikeEvent);
        const width = 16;

        return {
          left: Math.max(THREAD_HEADER_WIDTH, Math.min(canvasSize.width - width, spikeX - width / 2)),
          top: threadLayout.spikeTop + SPIKE_AREA_HEIGHT - spikeHeight,
          width,
          height: Math.max(spikeHeight, 12),
        };
      }

      const nestedEvent = threadData.events.find((event) =>
        areSameTraceEvent(event, highlight.event!)
      );
      if (!nestedEvent) return null;

      const eventStart = Math.min(
        Math.max(timeToPixel(nestedEvent.ts), THREAD_HEADER_WIDTH),
        canvasSize.width
      );
      const eventEnd = Math.min(
        Math.max(timeToPixel(nestedEvent.ts + (nestedEvent.dur || 0)), THREAD_HEADER_WIDTH),
        canvasSize.width
      );

      return {
        left: eventStart,
        top: threadLayout.flameTop + nestedEvent.depth * ROW_HEIGHT,
        width: Math.max(eventEnd - eventStart, 10),
        height: ROW_HEIGHT - 1,
      };
    },
    [canvasSize.width, processedData, resolveHighlightThreadLayout, timeToPixel]
  );

  useEffect(() => {
    if (!activeEvidenceHighlight) return;

    const targetPid = resolveHighlightProcessId(activeEvidenceHighlight);
    if (targetPid === null) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsedProcesses((previousCollapsed) => {
      if (!previousCollapsed.has(targetPid)) return previousCollapsed;

      const nextCollapsed = new Set(previousCollapsed);
      nextCollapsed.delete(targetPid);
      return nextCollapsed;
    });
  }, [activeEvidenceHighlight, resolveHighlightProcessId]);

  useEffect(() => {
    if (!activeEvidenceHighlight || canvasSize.height <= TIME_RULER_HEIGHT) return;

    const targetPid = resolveHighlightProcessId(activeEvidenceHighlight);
    if (targetPid === null) return;

    const layout = processLayouts.find((entry) => entry.pid === targetPid);
    if (!layout || layout.collapsed) return;
    const threadLayout = resolveHighlightThreadLayout(activeEvidenceHighlight, layout);

    const exactRect = resolveExactHighlightRect(activeEvidenceHighlight, layout);
    const focusTop = exactRect?.top ?? threadLayout?.flameTop ?? layout.contentTop;
    const focusBottom = exactRect
      ? exactRect.top + exactRect.height
      : threadLayout
        ? threadLayout.spikeTop + SPIKE_AREA_HEIGHT
        : layout.contentTop + layout.contentHeight;
    const focusCenter = (focusTop + focusBottom) / 2;
    const maxScroll = Math.max(totalHeight - canvasSize.height, 0);
    const nextScrollY = Math.max(0, Math.min(maxScroll, focusCenter - canvasSize.height * 0.36));

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScrollY((previousScrollY) =>
      Math.abs(previousScrollY - nextScrollY) < 4 ? previousScrollY : nextScrollY
    );
  }, [
    activeEvidenceHighlight,
    canvasSize.height,
    processLayouts,
    resolveExactHighlightRect,
    resolveHighlightProcessId,
    resolveHighlightThreadLayout,
    totalHeight,
  ]);

  const highlightOverlayGeometry = useMemo<HighlightOverlayGeometry | null>(() => {
    if (!activeEvidenceHighlight || canvasSize.width <= THREAD_HEADER_WIDTH) return null;

    const targetPid = resolveHighlightProcessId(activeEvidenceHighlight);
    if (targetPid === null) return null;

    const layout = processLayouts.find((entry) => entry.pid === targetPid);
    if (!layout || layout.collapsed) return null;
    const threadLayout = resolveHighlightThreadLayout(activeEvidenceHighlight, layout);

    const bandLeft = Math.max(
      THREAD_HEADER_WIDTH,
      Math.min(canvasSize.width - 2, timeToPixel(activeEvidenceHighlight.startTime))
    );
    const bandRight = Math.max(
      bandLeft + 2,
      Math.min(canvasSize.width, timeToPixel(activeEvidenceHighlight.endTime))
    );
    const bandTop = Math.max(
      TIME_RULER_HEIGHT,
      (threadLayout?.flameTop ?? layout.contentTop) - scrollY
    );
    const bandBottom = Math.min(
      canvasSize.height,
      (
        threadLayout
          ? threadLayout.spikeTop + SPIKE_AREA_HEIGHT
          : layout.contentTop + layout.contentHeight
      ) - scrollY
    );

    if (bandBottom <= bandTop) return null;

    const exactRectAbs = resolveExactHighlightRect(activeEvidenceHighlight, layout);
    const exactRect =
      exactRectAbs === null
        ? null
        : {
            ...exactRectAbs,
            top: exactRectAbs.top - scrollY,
          };

    const markerLeft = exactRect
      ? exactRect.left + Math.min(exactRect.width / 2, 18)
      : bandLeft + 18;
    const markerTop = exactRect ? exactRect.top + 4 : bandTop + 10;
    return {
      band: {
        left: bandLeft,
        top: bandTop,
        width: bandRight - bandLeft,
        height: bandBottom - bandTop,
      },
      exact: exactRect,
      markerLeft,
      markerTop,
    };
  }, [
    activeEvidenceHighlight,
    canvasSize.height,
    canvasSize.width,
    processLayouts,
    resolveExactHighlightRect,
    resolveHighlightProcessId,
    resolveHighlightThreadLayout,
    scrollY,
    timeToPixel,
  ]);

  // Find event at position
  const findEventAtPosition = useCallback(
    (x: number, y: number): TraceEvent | null => {
      const time = pixelToTime(x);
      for (const layout of processLayouts) {
        if (layout.collapsed) continue;

        const data = processedData.get(layout.pid);
        if (!data) continue;

        for (const threadLayout of layout.threadLayouts) {
          const threadData = data.threads.find((thread) => thread.tid === threadLayout.tid);
          if (!threadData) continue;

          const flameGraphTop = threadLayout.flameTop - scrollY;
          const flameGraphBottom = flameGraphTop + threadLayout.flameHeight;

          if (y < flameGraphTop || y >= flameGraphBottom) {
            continue;
          }

          const relativeY = y - flameGraphTop;
          const targetDepth = Math.floor(relativeY / ROW_HEIGHT);

          for (const event of threadData.events) {
            if (event.depth !== targetDepth) continue;

            const eventStart = event.ts;
            const eventEnd = event.ts + (event.dur || 0);
            if (time >= eventStart && time <= eventEnd) {
              return event;
            }
          }
        }
      }

      return null;
    },
    [pixelToTime, processLayouts, processedData, scrollY]
  );

  // Draw the timeline
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.width * dpr;
    canvas.height = canvasSize.height * dpr;
    ctx.scale(dpr, dpr);

    // Clear canvas - light background
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvasSize.width, canvasSize.height);

    // Draw time ruler background
    ctx.fillStyle = "#f8f8f8";
    ctx.fillRect(THREAD_HEADER_WIDTH, 0, canvasSize.width - THREAD_HEADER_WIDTH, TIME_RULER_HEIGHT);

    // Draw time ruler
    const visibleDuration = viewState.endTime - viewState.startTime;
    const tickInterval = calculateTickInterval(visibleDuration);
    const startTick = Math.floor(viewState.startTime / tickInterval) * tickInterval;

    ctx.strokeStyle = "#999";
    ctx.fillStyle = "#333";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";

    for (let time = startTick; time <= viewState.endTime; time += tickInterval) {
      const x = timeToPixel(time);
      if (x < THREAD_HEADER_WIDTH) continue;

      ctx.beginPath();
      ctx.moveTo(x, TIME_RULER_HEIGHT - 5);
      ctx.lineTo(x, TIME_RULER_HEIGHT);
      ctx.stroke();

      // Format time as seconds
      const seconds = time / 1_000_000;
      ctx.fillText(`${seconds.toFixed(seconds >= 1 ? 0 : 1)} s`, x, TIME_RULER_HEIGHT - 7);
    }

    // Draw separator lines
    ctx.strokeStyle = "#ccc";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(THREAD_HEADER_WIDTH, 0);
    ctx.lineTo(THREAD_HEADER_WIDTH, canvasSize.height);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, TIME_RULER_HEIGHT);
    ctx.lineTo(canvasSize.width, TIME_RULER_HEIGHT);
    ctx.stroke();

    // Draw processes
    let eventColorIndex = 0;

    for (const layout of processLayouts) {
      const process = processes.get(layout.pid);
      if (!process) continue;
      const headerY = layout.headerTop - scrollY;
      
      // Draw process header
      if (headerY + PROCESS_HEADER_HEIGHT > TIME_RULER_HEIGHT && headerY < canvasSize.height) {
        const visibleHeaderY = Math.max(headerY, TIME_RULER_HEIGHT);
        
        // Header background
        ctx.fillStyle = "#f0f0f0";
        ctx.fillRect(0, visibleHeaderY, canvasSize.width, PROCESS_HEADER_HEIGHT);

        // Collapse arrow
        ctx.fillStyle = "#333";
        ctx.font = "12px sans-serif";
        const isCollapsed = collapsedProcesses.has(layout.pid);
        ctx.fillText(isCollapsed ? "▸" : "▾", 8, visibleHeaderY + 15);

        // Process name
        ctx.fillStyle = "#000";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(process.name, 22, visibleHeaderY + 15);

        // X button to close/remove process
        ctx.fillStyle = "#666";
        ctx.font = "bold 12px sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("X", canvasSize.width - 10, visibleHeaderY + 15);

        // Bottom border
        ctx.strokeStyle = "#ccc";
        ctx.beginPath();
        ctx.moveTo(0, visibleHeaderY + PROCESS_HEADER_HEIGHT);
        ctx.lineTo(canvasSize.width, visibleHeaderY + PROCESS_HEADER_HEIGHT);
        ctx.stroke();
      }

      if (layout.collapsed) continue;

      const data = processedData.get(layout.pid);
      if (!data) continue;

      for (const threadLayout of layout.threadLayouts) {
        const threadData = data.threads.find((thread) => thread.tid === threadLayout.tid);
        if (!threadData) continue;

        const flameGraphTop = threadLayout.flameTop - scrollY;
        const spikeAreaTop = threadLayout.spikeTop - scrollY;
        const counterAreaTop = threadLayout.counterTop - scrollY;
        const blockTop = flameGraphTop;
        const blockBottom = threadLayout.counterHeight > 0
          ? counterAreaTop + threadLayout.counterHeight
          : spikeAreaTop + SPIKE_AREA_HEIGHT;

        if (blockBottom < TIME_RULER_HEIGHT || blockTop > canvasSize.height) {
          continue;
        }

        ctx.fillStyle = "#fff";
        ctx.fillRect(
          THREAD_HEADER_WIDTH,
          flameGraphTop,
          canvasSize.width - THREAD_HEADER_WIDTH,
          threadLayout.flameHeight
        );

        ctx.fillStyle = "#f8f8f8";
        ctx.fillRect(0, flameGraphTop, THREAD_HEADER_WIDTH, threadLayout.contentHeight);

        ctx.strokeStyle = "#e3e3e3";
        ctx.beginPath();
        ctx.moveTo(0, blockTop);
        ctx.lineTo(canvasSize.width, blockTop);
        ctx.stroke();

        const isSelectedThread = selectedEvent?.pid === layout.pid && selectedEvent?.tid === threadLayout.tid;
        if (isSelectedThread) {
          ctx.fillStyle = "rgba(66, 133, 244, 0.08)";
          ctx.fillRect(0, flameGraphTop, THREAD_HEADER_WIDTH, threadLayout.contentHeight);
        }

        ctx.textAlign = "left";
        ctx.fillStyle = "#222";
        ctx.font = "600 11px sans-serif";
        const threadName = truncateCanvasText(ctx, threadLayout.threadName, THREAD_HEADER_WIDTH - 16);
        ctx.fillText(threadName, 10, flameGraphTop + 14);

        ctx.fillStyle = "#666";
        ctx.font = "10px sans-serif";
        ctx.fillText(`tid ${threadLayout.tid}`, 10, flameGraphTop + 28);
        const statsText = threadLayout.counterTrackCount > 0
          ? `${threadLayout.eventCount} spans · ${threadLayout.spikeCount} spikes · ${threadLayout.counterTrackCount} counters`
          : `${threadLayout.eventCount} spans · ${threadLayout.spikeCount} spikes`;
        ctx.fillText(statsText, 10, flameGraphTop + 41);

        ctx.strokeStyle = "#e6e6e6";
        ctx.beginPath();
        ctx.moveTo(THREAD_HEADER_WIDTH - 1, flameGraphTop);
        ctx.lineTo(THREAD_HEADER_WIDTH - 1, blockBottom);
        ctx.stroke();

        for (const event of threadData.events) {
          const eventStart = event.ts;
          const eventEnd = event.ts + (event.dur || 0);

          if (eventEnd < viewState.startTime || eventStart > viewState.endTime) continue;

          const x1 = Math.max(timeToPixel(eventStart), THREAD_HEADER_WIDTH);
          const x2 = Math.min(timeToPixel(eventEnd), canvasSize.width);
          const width = x2 - x1;

          if (width < 0.3) continue;

          const eventY = flameGraphTop + event.depth * ROW_HEIGHT;
          const eventHeight = ROW_HEIGHT - 1;

          const color = getEventColor(event, eventColorIndex++);
          const isSelected = selectedEvent?.name === event.name && selectedEvent?.ts === event.ts;
          const isHovered = hoveredEvent?.name === event.name && hoveredEvent?.ts === event.ts;
          const matchesSearch = searchQuery && event.name.toLowerCase().includes(searchQuery.toLowerCase());

          ctx.fillStyle = color;
          ctx.fillRect(x1, eventY, Math.max(width, MIN_EVENT_WIDTH), eventHeight);

          ctx.strokeStyle = darkenColor(color, 0.15);
          ctx.lineWidth = 0.5;
          ctx.strokeRect(x1, eventY, Math.max(width, MIN_EVENT_WIDTH), eventHeight);

          if (isSelected) {
            ctx.strokeStyle = "#000";
            ctx.lineWidth = 2;
            ctx.strokeRect(x1, eventY, Math.max(width, MIN_EVENT_WIDTH), eventHeight);
          } else if (isHovered) {
            ctx.strokeStyle = "#666";
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x1, eventY, Math.max(width, MIN_EVENT_WIDTH), eventHeight);
          }

          if (matchesSearch) {
            ctx.strokeStyle = "#ff0";
            ctx.lineWidth = 2;
            ctx.strokeRect(x1 - 1, eventY - 1, width + 2, eventHeight + 2);
          }

          if (width > 20) {
            ctx.fillStyle = getContrastColor(color);
            ctx.font = "10px sans-serif";
            ctx.textAlign = "left";

            const textX = x1 + 2;
            const maxTextWidth = width - 4;
            const displayName = truncateCanvasText(ctx, event.name, maxTextWidth);

            if (displayName.length > 3) {
              ctx.fillText(displayName, textX, eventY + 10);
            }
          }
        }

        ctx.fillStyle = "#fafafa";
        ctx.fillRect(
          THREAD_HEADER_WIDTH,
          spikeAreaTop,
          canvasSize.width - THREAD_HEADER_WIDTH,
          SPIKE_AREA_HEIGHT
        );

        for (const event of threadData.instantEvents) {
          const x = timeToPixel(event.ts);
          if (x < THREAD_HEADER_WIDTH || x > canvasSize.width) continue;

          const color = getEventColor(event, eventColorIndex++);
          const spikeHeight = getSpikeHeight(event);

          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, spikeAreaTop + SPIKE_AREA_HEIGHT);
          ctx.lineTo(x, spikeAreaTop + SPIKE_AREA_HEIGHT - spikeHeight);
          ctx.stroke();
        }

        ctx.strokeStyle = "#eee";
        ctx.lineWidth = 1;
        for (let depth = 0; depth <= threadData.maxDepth; depth += 1) {
          const y = flameGraphTop + depth * ROW_HEIGHT;
          ctx.beginPath();
          ctx.moveTo(THREAD_HEADER_WIDTH, y);
          ctx.lineTo(canvasSize.width, y);
          ctx.stroke();
        }

        ctx.strokeStyle = "#ddd";
        ctx.beginPath();
        ctx.moveTo(0, spikeAreaTop + SPIKE_AREA_HEIGHT);
        ctx.lineTo(canvasSize.width, spikeAreaTop + SPIKE_AREA_HEIGHT);
        ctx.stroke();

        for (let trackIndex = 0; trackIndex < threadData.counterTracks.length; trackIndex++) {
          const track = threadData.counterTracks[trackIndex];
          const trackTop = counterAreaTop + trackIndex * (COUNTER_TRACK_HEIGHT + COUNTER_TRACK_GAP);
          const trackBottom = trackTop + COUNTER_TRACK_HEIGHT;

          if (trackBottom < TIME_RULER_HEIGHT || trackTop > canvasSize.height) continue;

          ctx.fillStyle = "#fcfcfc";
          ctx.fillRect(THREAD_HEADER_WIDTH, trackTop, canvasSize.width - THREAD_HEADER_WIDTH, COUNTER_TRACK_HEIGHT);

          ctx.fillStyle = "#888";
          ctx.font = "9px sans-serif";
          ctx.textAlign = "left";
          ctx.fillText(truncateCanvasText(ctx, track.name, THREAD_HEADER_WIDTH - 16), 12, trackTop + COUNTER_TRACK_HEIGHT / 2 + 3);

          let visibleEvents: Array<{ ts: number; value: number }> = [];
          let foundFirst = false;
          for (let i = 0; i < track.events.length; i++) {
            const e = track.events[i];
            if (e.ts > viewState.endTime) {
              visibleEvents.push(e);
              break;
            }
            if (e.ts >= viewState.startTime) {
              if (!foundFirst && i > 0) visibleEvents.push(track.events[i - 1]);
              foundFirst = true;
              visibleEvents.push(e);
            }
          }
          if (!foundFirst && track.events.length > 0) {
            const last = track.events[track.events.length - 1];
            if (last.ts < viewState.startTime) visibleEvents = [last];
          }
          if (visibleEvents.length === 0) continue;

          const maxPoints = 2000;
          if (visibleEvents.length > maxPoints) {
            const step = Math.ceil(visibleEvents.length / maxPoints);
            const downsampled: typeof visibleEvents = [];
            for (let i = 0; i < visibleEvents.length; i += step) {
              let best = visibleEvents[i];
              const end = Math.min(i + step, visibleEvents.length);
              for (let j = i + 1; j < end; j++) {
                if (visibleEvents[j].value > best.value) best = visibleEvents[j];
              }
              downsampled.push(best);
            }
            visibleEvents = downsampled;
          }

          const valueRange = track.maxValue - track.minValue;
          const effectiveRange = valueRange > 0 ? valueRange : 1;
          const pad = 2;
          const valueToY = (v: number) =>
            trackBottom - pad - ((v - track.minValue) / effectiveRange) * (COUNTER_TRACK_HEIGHT - pad * 2);

          if (visibleEvents.length >= 2) {
            const clampX = (ts: number) => Math.min(Math.max(timeToPixel(ts), THREAD_HEADER_WIDTH), canvasSize.width);

            ctx.beginPath();
            ctx.moveTo(clampX(visibleEvents[0].ts), trackBottom - pad);
            ctx.lineTo(clampX(visibleEvents[0].ts), valueToY(visibleEvents[0].value));
            for (let i = 1; i < visibleEvents.length; i++) {
              ctx.lineTo(clampX(visibleEvents[i].ts), valueToY(visibleEvents[i].value));
            }
            ctx.lineTo(clampX(visibleEvents[visibleEvents.length - 1].ts), trackBottom - pad);
            ctx.closePath();
            ctx.fillStyle = "rgba(100, 149, 237, 0.12)";
            ctx.fill();

            ctx.beginPath();
            ctx.moveTo(clampX(visibleEvents[0].ts), valueToY(visibleEvents[0].value));
            for (let i = 1; i < visibleEvents.length; i++) {
              ctx.lineTo(clampX(visibleEvents[i].ts), valueToY(visibleEvents[i].value));
            }
            ctx.strokeStyle = "rgba(70, 130, 220, 0.6)";
            ctx.lineWidth = 1;
            ctx.stroke();
          } else if (visibleEvents.length === 1) {
            ctx.fillStyle = "rgba(70, 130, 220, 0.6)";
            ctx.beginPath();
            ctx.arc(timeToPixel(visibleEvents[0].ts), valueToY(visibleEvents[0].value), 2, 0, Math.PI * 2);
            ctx.fill();
          }

          ctx.strokeStyle = "#eee";
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(THREAD_HEADER_WIDTH, trackBottom);
          ctx.lineTo(canvasSize.width, trackBottom);
          ctx.stroke();
        }
      }
    }

    // Draw vertical grid lines
    ctx.strokeStyle = "rgba(255, 0, 255, 0.3)";
    ctx.lineWidth = 1;
    for (let time = startTick; time <= viewState.endTime; time += tickInterval) {
      const x = timeToPixel(time);
      if (x < THREAD_HEADER_WIDTH) continue;

      ctx.beginPath();
      ctx.moveTo(x, TIME_RULER_HEIGHT);
      ctx.lineTo(x, canvasSize.height);
      ctx.stroke();
    }

    // Draw hover tooltip
    if (hoveredEvent && !isPanning) {
      const dur = hoveredEvent.dur || 0;
      const category = hoveredEvent.cat || "N/A";
      const tooltipLines = [
        hoveredEvent.name,
        `Duration: ${formatTimeShort(dur)}`,
        `Category: ${category}`,
        `Start: ${(hoveredEvent.ts / 1_000_000).toFixed(6)} s`,
      ];

      ctx.font = "11px sans-serif";
      const maxWidth = Math.max(...tooltipLines.map((l) => ctx.measureText(l).width));
      const padding = 8;
      const lineHeight = 16;
      const tooltipWidth = Math.min(maxWidth + padding * 2, 450);
      const tooltipHeight = tooltipLines.length * lineHeight + padding * 2 - 4;

      const tooltipX = Math.min(mousePos.x + 15, canvasSize.width - tooltipWidth - 10);
      const tooltipY = Math.max(mousePos.y - tooltipHeight - 10, TIME_RULER_HEIGHT + 5);

      // Shadow
      ctx.fillStyle = "rgba(0, 0, 0, 0.15)";
      ctx.fillRect(tooltipX + 3, tooltipY + 3, tooltipWidth, tooltipHeight);

      // Background
      ctx.fillStyle = "#fff";
      ctx.fillRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight);
      ctx.strokeStyle = "#999";
      ctx.lineWidth = 1;
      ctx.strokeRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight);

      // Text
      ctx.fillStyle = "#000";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "left";

      let displayName = tooltipLines[0];
      while (ctx.measureText(displayName).width > tooltipWidth - padding * 2 && displayName.length > 5) {
        displayName = displayName.slice(0, -5) + "...";
      }
      ctx.fillText(displayName, tooltipX + padding, tooltipY + padding + 12);

      ctx.fillStyle = "#333";
      ctx.font = "11px sans-serif";
      for (let i = 1; i < tooltipLines.length; i++) {
        ctx.fillText(tooltipLines[i], tooltipX + padding, tooltipY + padding + 12 + i * lineHeight);
      }
    }
  }, [
    canvasSize,
    collapsedProcesses,
    hoveredEvent,
    isPanning,
    mousePos,
    processes,
    processLayouts,
    processedData,
    scrollY,
    searchQuery,
    selectedEvent,
    timeToPixel,
    viewState,
  ]);

  // Handle click on process header to toggle collapse
  const handleProcessHeaderClick = useCallback((pid: number) => {
    setCollapsedProcesses((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) {
        next.delete(pid);
      } else {
        next.add(pid);
      }
      return next;
    });
  }, []);

  // Handle mouse events
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Check if clicking on a process header
      for (const layout of processLayouts) {
        const headerY = layout.headerTop - scrollY;
        if (y >= headerY && y < headerY + PROCESS_HEADER_HEIGHT) {
          if (x < 20) {
            // Clicked collapse arrow
            handleProcessHeaderClick(layout.pid);
            return;
          }
        }
      }

      if (tool === "pan" || e.button === 1) {
        setIsPanning(true);
        setPanStart({ x: e.clientX, y: e.clientY });
        e.preventDefault();
      } else if (tool === "select" && x > THREAD_HEADER_WIDTH) {
        const event = findEventAtPosition(x, y);
        onEventSelect(event);
      }
    },
    [tool, findEventAtPosition, handleProcessHeaderClick, onEventSelect, processLayouts, scrollY]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setMousePos({ x, y });

      if (isPanning) {
        const dx = e.clientX - panStart.x;
        const dy = e.clientY - panStart.y;

        const visibleDuration = viewState.endTime - viewState.startTime;
        const drawableWidth = Math.max(canvasSize.width - THREAD_HEADER_WIDTH, 1);
        const pixelsPerMicrosecond = drawableWidth / Math.max(visibleDuration, 1);
        const timeDelta = -dx / pixelsPerMicrosecond;

        onViewStateChange({
          ...viewState,
          startTime: viewState.startTime + timeDelta,
          endTime: viewState.endTime + timeDelta,
        });

        setScrollY(Math.max(0, Math.min(totalHeight - canvasSize.height, scrollY - dy)));
        setPanStart({ x: e.clientX, y: e.clientY });
      } else if (x > THREAD_HEADER_WIDTH) {
        const event = findEventAtPosition(x, y);
        setHoveredEvent(event);
      } else {
        setHoveredEvent(null);
      }
    },
    [
      canvasSize.height,
      canvasSize.width,
      findEventAtPosition,
      isPanning,
      onViewStateChange,
      panStart,
      scrollY,
      totalHeight,
      viewState,
    ]
  );

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsPanning(false);
    setHoveredEvent(null);
  }, []);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left;

      if (e.ctrlKey || e.metaKey) {
        // Zoom
        e.preventDefault();
        const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
        const mouseTime = pixelToTime(x);
        const visibleDuration = viewState.endTime - viewState.startTime;
        const newDuration = visibleDuration * zoomFactor;

        const drawableWidth = Math.max(canvasSize.width - THREAD_HEADER_WIDTH, 1);
        const mouseRatio = (x - THREAD_HEADER_WIDTH) / drawableWidth;
        const newStartTime = mouseTime - newDuration * mouseRatio;
        const newEndTime = newStartTime + newDuration;

        onViewStateChange({
          ...viewState,
          startTime: newStartTime,
          endTime: newEndTime,
        });
      } else {
        // Scroll vertically
        const newScrollY = Math.max(0, Math.min(totalHeight - canvasSize.height, scrollY + e.deltaY));
        setScrollY(newScrollY);
      }
    },
    [viewState, onViewStateChange, canvasSize, pixelToTime, scrollY, totalHeight]
  );

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 flex-1 overflow-hidden"
      style={{ cursor: tool === "pan" || isPanning ? "grab" : "default" }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "100%" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      />

      {highlightOverlayGeometry && activeEvidenceHighlight && (
        <div
          className={`pointer-events-none absolute inset-0 transition-opacity duration-700 ${
            isEvidenceHighlightFading ? "opacity-0" : "opacity-100"
          }`}
        >
          <div
            className="absolute rounded-xl border border-[#5b95ff] bg-[#5b95ff]/10 shadow-[0_0_0_1px_rgba(66,133,244,0.08)]"
            style={{
              left: highlightOverlayGeometry.band.left,
              top: highlightOverlayGeometry.band.top,
              width: highlightOverlayGeometry.band.width,
              height: highlightOverlayGeometry.band.height,
            }}
          />

          {highlightOverlayGeometry.exact && (
            <div
              className="absolute animate-pulse rounded-md border-2 border-[#1a73e8] bg-white/10 shadow-[0_0_0_3px_rgba(26,115,232,0.18)]"
              style={{
                left: highlightOverlayGeometry.exact.left,
                top: highlightOverlayGeometry.exact.top,
                width: highlightOverlayGeometry.exact.width,
                height: highlightOverlayGeometry.exact.height,
              }}
            />
          )}

          <div
            className="absolute h-3 w-3 rounded-full border-2 border-white bg-[#1a73e8] shadow-[0_0_0_3px_rgba(26,115,232,0.2)]"
            style={{
              left: highlightOverlayGeometry.markerLeft - 6,
              top: highlightOverlayGeometry.markerTop - 6,
            }}
          />
        </div>
      )}
    </div>
  );
}
