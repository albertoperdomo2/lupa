"use client";

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { TraceData, TraceEvent, Process, ViewState } from "@/lib/trace-types";
import { sampleTraceData } from "@/lib/sample-trace";
import { Toolbar } from "./toolbar";
import { Timeline } from "./timeline";
import { DetailsPanel } from "./details-panel";
import { EmptyState } from "./empty-state";
import { StatusBar } from "./status-bar";
import { Minimap } from "./minimap";
import { SideToolbar } from "./side-toolbar";

export function TracingViewer() {
  const [traceData, setTraceData] = useState<TraceData | null>(null);
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
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Parse trace data into processes and threads
  const processes = useMemo(() => {
    if (!traceData) return new Map<number, Process>();

    const processMap = new Map<number, Process>();

    // First pass: collect metadata
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

    // Second pass: assign events to threads
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

    // Sort events by timestamp
    for (const process of processMap.values()) {
      for (const thread of process.threads.values()) {
        thread.events.sort((a, b) => a.ts - b.ts);
      }
    }

    return processMap;
  }, [traceData]);

  // Calculate time bounds
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

  // Load trace data
  const loadTraceData = useCallback((data: TraceData, name?: string) => {
    setTraceData(data);
    setSelectedEvent(null);
    setFilename(name);

    // Calculate initial view
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
  }, []);

  // Handle file load
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

          // Handle both array and object formats
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

      // Reset input
      e.target.value = "";
    },
    [loadTraceData]
  );

  const handleLoadSample = useCallback(() => {
    loadTraceData(sampleTraceData, "sample_trace.json");
  }, [loadTraceData]);

  // Zoom controls
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

  // Pan controls
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

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
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
  }, [handleZoomIn, handleZoomOut, handlePanLeft, handlePanRight, handleFitToWindow]);

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

      {!traceData ? (
        <EmptyState onLoadFile={handleLoadFile} onLoadSample={handleLoadSample} />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <div className="flex flex-col flex-1">
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
            />

            {selectedEvent && (
              <DetailsPanel
                event={selectedEvent}
                processes={processes}
                onClose={() => setSelectedEvent(null)}
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

      {traceData && (
        <StatusBar
          viewState={viewState}
          processes={processes}
          eventCount={traceData.traceEvents.filter(e => e.ph !== "M").length}
          selectedEvent={selectedEvent}
        />
      )}
    </div>
  );
}
