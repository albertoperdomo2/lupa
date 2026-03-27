"use client";

import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import type { TraceEvent, Process, ViewState } from "@/lib/trace-types";
import { getEventColor, formatTimeShort } from "@/lib/trace-types";

interface TimelineProps {
  processes: Map<number, Process>;
  viewState: ViewState;
  onViewStateChange: (state: ViewState) => void;
  onEventSelect: (event: TraceEvent | null) => void;
  selectedEvent: TraceEvent | null;
  tool: "select" | "pan";
  searchQuery: string;
}

const ROW_HEIGHT = 14;
const PROCESS_HEADER_HEIGHT = 22;
const THREAD_HEADER_WIDTH = 250;
const TIME_RULER_HEIGHT = 22;
const SPIKE_AREA_HEIGHT = 60;
const MIN_EVENT_WIDTH = 1;

interface NestedEvent extends TraceEvent {
  depth: number;
}

// Calculate tick interval based on visible duration
function calculateTickInterval(visibleDuration: number): number {
  const targetTicks = 10;
  const rawInterval = visibleDuration / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawInterval)));
  const normalized = rawInterval / magnitude;
  
  let interval: number;
  if (normalized < 1.5) interval = magnitude;
  else if (normalized < 3) interval = 2 * magnitude;
  else if (normalized < 7) interval = 5 * magnitude;
  else interval = 10 * magnitude;
  
  return interval;
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

export function Timeline({
  processes,
  viewState,
  onViewStateChange,
  onEventSelect,
  selectedEvent,
  tool,
  searchQuery,
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

  // Calculate nested events with depth for flame graph
  const processedData = useMemo(() => {
    const result = new Map<number, {
      maxDepth: number;
      events: NestedEvent[];
      instantEvents: TraceEvent[];
    }>();

    processes.forEach((process, pid) => {
      // Collect all events for this process
      const allEvents: TraceEvent[] = [];
      const instantEvents: TraceEvent[] = [];
      
      process.threads.forEach((thread) => {
        thread.events.forEach(e => {
          if (e.ph === "X" || e.ph === "B") {
            const dur = e.dur || 0;
            if (dur < 1000) { // Very short events go to spikes
              instantEvents.push(e);
            } else {
              allEvents.push(e);
            }
          } else if (e.ph === "i" || e.ph === "I" || e.ph === "R") {
            instantEvents.push(e);
          }
        });
      });

      // Sort by start time, then by duration (longer events first for proper nesting)
      allEvents.sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        return (b.dur || 0) - (a.dur || 0);
      });

      // Calculate depths using interval tree approach
      const nestedEvents: NestedEvent[] = [];
      const activeIntervals: { end: number; depth: number }[] = [];

      for (const event of allEvents) {
        const eventEnd = event.ts + (event.dur || 0);

        // Remove intervals that have ended before this event starts
        while (activeIntervals.length > 0) {
          // Find the deepest active interval
          let allEnded = true;
          for (let i = activeIntervals.length - 1; i >= 0; i--) {
            if (activeIntervals[i].end > event.ts) {
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

        // Clean up ended intervals
        const stillActive = activeIntervals.filter(interval => interval.end > event.ts);
        activeIntervals.length = 0;
        activeIntervals.push(...stillActive);

        // Find depth - it's the number of active overlapping intervals
        let depth = 0;
        for (const interval of activeIntervals) {
          if (interval.end > event.ts) {
            depth = Math.max(depth, interval.depth + 1);
          }
        }

        nestedEvents.push({ ...event, depth });
        activeIntervals.push({ end: eventEnd, depth });
        
        // Keep sorted by end time (descending)
        activeIntervals.sort((a, b) => b.end - a.end);
      }

      const maxDepth = nestedEvents.reduce((max, e) => Math.max(max, e.depth), -1) + 1;

      result.set(pid, { 
        maxDepth: Math.max(maxDepth, 1),
        events: nestedEvents,
        instantEvents
      });
    });

    return result;
  }, [processes]);

  // Calculate total height needed
  const totalHeight = useMemo(() => {
    let height = TIME_RULER_HEIGHT;
    
    processes.forEach((process, pid) => {
      height += PROCESS_HEADER_HEIGHT;
      
      if (!collapsedProcesses.has(pid)) {
        const data = processedData.get(pid);
        if (data) {
          // Height for flame graph rows + spike area
          height += data.maxDepth * ROW_HEIGHT + SPIKE_AREA_HEIGHT + 4;
        }
      }
    });
    
    return height;
  }, [processes, collapsedProcesses, processedData]);

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
      const pixelsPerMicrosecond = (canvasSize.width - THREAD_HEADER_WIDTH) / visibleDuration;
      return THREAD_HEADER_WIDTH + (time - viewState.startTime) * pixelsPerMicrosecond;
    },
    [viewState, canvasSize.width]
  );

  // Pixel to time conversion
  const pixelToTime = useCallback(
    (pixel: number): number => {
      const visibleDuration = viewState.endTime - viewState.startTime;
      const pixelsPerMicrosecond = (canvasSize.width - THREAD_HEADER_WIDTH) / visibleDuration;
      return viewState.startTime + (pixel - THREAD_HEADER_WIDTH) / pixelsPerMicrosecond;
    },
    [viewState, canvasSize.width]
  );

  // Find event at position
  const findEventAtPosition = useCallback(
    (x: number, y: number): TraceEvent | null => {
      const time = pixelToTime(x);
      let currentY = TIME_RULER_HEIGHT - scrollY;

      for (const [pid] of processes) {
        currentY += PROCESS_HEADER_HEIGHT;
        
        if (collapsedProcesses.has(pid)) continue;

        const data = processedData.get(pid);
        if (!data) continue;

        const flameGraphHeight = data.maxDepth * ROW_HEIGHT;
        const flameGraphTop = currentY;
        const flameGraphBottom = currentY + flameGraphHeight;

        if (y >= flameGraphTop && y < flameGraphBottom) {
          // Find which depth row we're in
          const relativeY = y - flameGraphTop;
          const targetDepth = Math.floor(relativeY / ROW_HEIGHT);
          
          // Find events at this depth that contain the time
          for (const event of data.events) {
            if (event.depth === targetDepth) {
              const eventStart = event.ts;
              const eventEnd = event.ts + (event.dur || 0);
              if (time >= eventStart && time <= eventEnd) {
                return event;
              }
            }
          }
        }

        currentY += flameGraphHeight + SPIKE_AREA_HEIGHT + 4;
      }

      return null;
    },
    [processes, pixelToTime, scrollY, collapsedProcesses, processedData]
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
    let currentY = TIME_RULER_HEIGHT - scrollY;
    let eventColorIndex = 0;

    for (const [pid, process] of processes) {
      const headerY = currentY;
      
      // Draw process header
      if (headerY + PROCESS_HEADER_HEIGHT > TIME_RULER_HEIGHT && headerY < canvasSize.height) {
        const visibleHeaderY = Math.max(headerY, TIME_RULER_HEIGHT);
        
        // Header background
        ctx.fillStyle = "#f0f0f0";
        ctx.fillRect(0, visibleHeaderY, canvasSize.width, PROCESS_HEADER_HEIGHT);

        // Collapse arrow
        ctx.fillStyle = "#333";
        ctx.font = "12px sans-serif";
        const isCollapsed = collapsedProcesses.has(pid);
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

      currentY += PROCESS_HEADER_HEIGHT;

      if (collapsedProcesses.has(pid)) continue;

      const data = processedData.get(pid);
      if (!data) continue;

      const flameGraphTop = currentY;
      const flameGraphHeight = data.maxDepth * ROW_HEIGHT;

      // Draw flame graph area background
      ctx.fillStyle = "#fff";
      ctx.fillRect(THREAD_HEADER_WIDTH, flameGraphTop, canvasSize.width - THREAD_HEADER_WIDTH, flameGraphHeight);

      // Draw left sidebar with process info
      ctx.fillStyle = "#f8f8f8";
      ctx.fillRect(0, flameGraphTop, THREAD_HEADER_WIDTH, flameGraphHeight + SPIKE_AREA_HEIGHT);

      // Draw events as flame graph (stacking vertically)
      for (const event of data.events) {
        const eventStart = event.ts;
        const eventEnd = event.ts + (event.dur || 0);

        // Skip events outside visible range
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

        // Draw event rectangle
        ctx.fillStyle = color;
        ctx.fillRect(x1, eventY, Math.max(width, MIN_EVENT_WIDTH), eventHeight);

        // Draw border
        ctx.strokeStyle = darkenColor(color, 0.15);
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x1, eventY, Math.max(width, MIN_EVENT_WIDTH), eventHeight);

        // Highlight for selection/hover
        if (isSelected) {
          ctx.strokeStyle = "#000";
          ctx.lineWidth = 2;
          ctx.strokeRect(x1, eventY, Math.max(width, MIN_EVENT_WIDTH), eventHeight);
        } else if (isHovered) {
          ctx.strokeStyle = "#666";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x1, eventY, Math.max(width, MIN_EVENT_WIDTH), eventHeight);
        }

        // Search highlight
        if (matchesSearch) {
          ctx.strokeStyle = "#ff0";
          ctx.lineWidth = 2;
          ctx.strokeRect(x1 - 1, eventY - 1, width + 2, eventHeight + 2);
        }

        // Draw event name if wide enough
        if (width > 20) {
          ctx.fillStyle = getContrastColor(color);
          ctx.font = "10px sans-serif";
          ctx.textAlign = "left";

          const textX = x1 + 2;
          const maxTextWidth = width - 4;
          let displayName = event.name;

          // Truncate with ellipsis
          while (ctx.measureText(displayName).width > maxTextWidth && displayName.length > 4) {
            displayName = displayName.slice(0, -4) + "...";
          }

          if (displayName.length > 3) {
            ctx.fillText(displayName, textX, eventY + 10);
          }
        }
      }

      // Draw spike area (instant events and very short events)
      const spikeAreaTop = flameGraphTop + flameGraphHeight;
      
      // Spike area background
      ctx.fillStyle = "#fafafa";
      ctx.fillRect(THREAD_HEADER_WIDTH, spikeAreaTop, canvasSize.width - THREAD_HEADER_WIDTH, SPIKE_AREA_HEIGHT);

      // Draw spikes
      for (const event of data.instantEvents) {
        const x = timeToPixel(event.ts);
        if (x < THREAD_HEADER_WIDTH || x > canvasSize.width) continue;

        const color = getEventColor(event, eventColorIndex++);
        const spikeHeight = 5 + Math.random() * (SPIKE_AREA_HEIGHT - 10);
        
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, spikeAreaTop + SPIKE_AREA_HEIGHT);
        ctx.lineTo(x, spikeAreaTop + SPIKE_AREA_HEIGHT - spikeHeight);
        ctx.stroke();
      }

      // Draw horizontal grid lines between rows
      ctx.strokeStyle = "#eee";
      ctx.lineWidth = 1;
      for (let depth = 0; depth <= data.maxDepth; depth++) {
        const y = flameGraphTop + depth * ROW_HEIGHT;
        ctx.beginPath();
        ctx.moveTo(THREAD_HEADER_WIDTH, y);
        ctx.lineTo(canvasSize.width, y);
        ctx.stroke();
      }

      // Draw bottom border of spike area
      ctx.strokeStyle = "#ddd";
      ctx.beginPath();
      ctx.moveTo(0, spikeAreaTop + SPIKE_AREA_HEIGHT);
      ctx.lineTo(canvasSize.width, spikeAreaTop + SPIKE_AREA_HEIGHT);
      ctx.stroke();

      currentY += flameGraphHeight + SPIKE_AREA_HEIGHT + 4;
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
    processes,
    processedData,
    viewState,
    timeToPixel,
    selectedEvent,
    hoveredEvent,
    searchQuery,
    scrollY,
    isPanning,
    mousePos,
    collapsedProcesses,
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
      let currentY = TIME_RULER_HEIGHT - scrollY;
      for (const [pid] of processes) {
        if (y >= currentY && y < currentY + PROCESS_HEADER_HEIGHT) {
          if (x < 20) {
            // Clicked collapse arrow
            handleProcessHeaderClick(pid);
            return;
          }
        }
        currentY += PROCESS_HEADER_HEIGHT;
        if (!collapsedProcesses.has(pid)) {
          const data = processedData.get(pid);
          if (data) {
            currentY += data.maxDepth * ROW_HEIGHT + SPIKE_AREA_HEIGHT + 4;
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
    [tool, findEventAtPosition, onEventSelect, processes, scrollY, collapsedProcesses, processedData, handleProcessHeaderClick]
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
        const pixelsPerMicrosecond = (canvasSize.width - THREAD_HEADER_WIDTH) / visibleDuration;
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
    [isPanning, panStart, viewState, onViewStateChange, canvasSize.width, findEventAtPosition, scrollY, totalHeight]
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

        const mouseRatio = (x - THREAD_HEADER_WIDTH) / (canvasSize.width - THREAD_HEADER_WIDTH);
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
      className="flex-1 overflow-hidden relative"
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
    </div>
  );
}
