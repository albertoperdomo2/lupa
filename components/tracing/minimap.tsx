"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type { TraceData, ViewState } from "@/lib/trace-types";
import { getEventColor } from "@/lib/trace-types";

interface MinimapProps {
  traceData: TraceData;
  viewState: ViewState;
  onViewStateChange: (state: ViewState) => void;
  timeBounds: { min: number; max: number };
}

const MINIMAP_HEIGHT = 24;
const PADDING = 0;

export function Minimap({
  traceData,
  viewState,
  onViewStateChange,
  timeBounds,
}: MinimapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(0);
  const [dragType, setDragType] = useState<"pan" | "resize-left" | "resize-right" | null>(null);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setCanvasWidth(entry.contentRect.width - PADDING * 2);
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Time conversion functions
  const timeToPixel = useCallback(
    (time: number): number => {
      const totalDuration = timeBounds.max - timeBounds.min;
      return ((time - timeBounds.min) / totalDuration) * canvasWidth;
    },
    [timeBounds, canvasWidth]
  );

  const pixelToTime = useCallback(
    (pixel: number): number => {
      const totalDuration = timeBounds.max - timeBounds.min;
      return timeBounds.min + (pixel / canvasWidth) * totalDuration;
    },
    [timeBounds, canvasWidth]
  );

  // Draw minimap
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasWidth <= 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasWidth * dpr;
    canvas.height = MINIMAP_HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    // Clear canvas with light background
    ctx.fillStyle = "#f8f8f8";
    ctx.fillRect(0, 0, canvasWidth, MINIMAP_HEIGHT);

    // Draw events as density bars
    const events = traceData.traceEvents.filter(e => e.ph === "X" || e.ph === "B");
    let eventIndex = 0;
    
    for (const event of events) {
      if (event.ph !== "X" && event.ph !== "B") continue;
      
      const x1 = timeToPixel(event.ts);
      const x2 = timeToPixel(event.ts + (event.dur || 1000));
      const width = Math.max(x2 - x1, 1);
      
      const color = getEventColor(event, eventIndex++);
      ctx.fillStyle = color;
      ctx.fillRect(x1, 3, width, MINIMAP_HEIGHT - 6);
    }

    // Draw visible region
    const viewStart = timeToPixel(Math.max(viewState.startTime, timeBounds.min));
    const viewEnd = timeToPixel(Math.min(viewState.endTime, timeBounds.max));
    const viewWidth = viewEnd - viewStart;

    // Darken non-visible regions
    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.fillRect(0, 0, viewStart, MINIMAP_HEIGHT);
    ctx.fillRect(viewEnd, 0, canvasWidth - viewEnd, MINIMAP_HEIGHT);

    // Draw visible region border
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 1;
    ctx.strokeRect(viewStart + 0.5, 0.5, viewWidth - 1, MINIMAP_HEIGHT - 1);
  }, [traceData, viewState, timeBounds, canvasWidth, timeToPixel]);

  // Handle mouse events
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left;
      const viewStart = timeToPixel(Math.max(viewState.startTime, timeBounds.min));
      const viewEnd = timeToPixel(Math.min(viewState.endTime, timeBounds.max));

      // Check if clicking on resize handles
      if (Math.abs(x - viewStart) < 5) {
        setDragType("resize-left");
      } else if (Math.abs(x - viewEnd) < 5) {
        setDragType("resize-right");
      } else if (x >= viewStart && x <= viewEnd) {
        setDragType("pan");
      } else {
        // Click outside - center view at that position
        const clickTime = pixelToTime(x);
        const duration = viewState.endTime - viewState.startTime;
        onViewStateChange({
          ...viewState,
          startTime: clickTime - duration / 2,
          endTime: clickTime + duration / 2,
        });
        setDragType("pan");
      }

      setIsDragging(true);
      setDragStart(x);
    },
    [viewState, timeBounds, onViewStateChange, pixelToTime, timeToPixel]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left;
      const viewStart = timeToPixel(Math.max(viewState.startTime, timeBounds.min));
      const viewEnd = timeToPixel(Math.min(viewState.endTime, timeBounds.max));

      // Update cursor based on position
      if (!isDragging) {
        if (Math.abs(x - viewStart) < 5 || Math.abs(x - viewEnd) < 5) {
          containerRef.current!.style.cursor = "ew-resize";
        } else if (x >= viewStart && x <= viewEnd) {
          containerRef.current!.style.cursor = "grab";
        } else {
          containerRef.current!.style.cursor = "pointer";
        }
      }

      if (!isDragging || !dragType) return;

      const timeDelta = pixelToTime(x) - pixelToTime(dragStart);

      if (dragType === "pan") {
        containerRef.current!.style.cursor = "grabbing";
        onViewStateChange({
          ...viewState,
          startTime: viewState.startTime + timeDelta,
          endTime: viewState.endTime + timeDelta,
        });
      } else if (dragType === "resize-left") {
        const newStartTime = pixelToTime(x);
        if (newStartTime < viewState.endTime - 1000) {
          onViewStateChange({
            ...viewState,
            startTime: newStartTime,
          });
        }
      } else if (dragType === "resize-right") {
        const newEndTime = pixelToTime(x);
        if (newEndTime > viewState.startTime + 1000) {
          onViewStateChange({
            ...viewState,
            endTime: newEndTime,
          });
        }
      }

      setDragStart(x);
    },
    [isDragging, dragType, dragStart, viewState, onViewStateChange, pixelToTime, timeToPixel]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragType(null);
    if (containerRef.current) {
      containerRef.current.style.cursor = "default";
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (isDragging) return;
    if (containerRef.current) {
      containerRef.current.style.cursor = "default";
    }
  }, [isDragging]);

  return (
    <div
      ref={containerRef}
      className="bg-[#f0f0f0] border-b border-[#ccc]"
    >
      <canvas
        ref={canvasRef}
        style={{ width: canvasWidth, height: MINIMAP_HEIGHT }}
        className="cursor-pointer"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
    </div>
  );
}
