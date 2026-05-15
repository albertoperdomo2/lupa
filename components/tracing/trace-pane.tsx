"use client";
import type { Process, TraceData, TraceEvent, ViewState } from "@/lib/trace-types";
import { DetailsPanel } from "@/components/tracing/details-panel";
import { Minimap } from "@/components/tracing/minimap";
import { SideToolbar } from "@/components/tracing/side-toolbar";
import { StatusBar } from "@/components/tracing/status-bar";
import { Timeline, type TimelineEvidenceHighlight } from "@/components/tracing/timeline";

interface TracePaneProps {
  label: string;
  traceData: TraceData | null;
  processes: Map<number, Process>;
  viewState: ViewState;
  onViewStateChange: (state: ViewState) => void;
  timeBounds: { min: number; max: number };
  selectedEvent: TraceEvent | null;
  onEventSelect: (event: TraceEvent | null) => void;
  tool: "select" | "pan";
  onToolChange: (tool: "select" | "pan") => void;
  searchQuery: string;
  onRegisterApi?: ((api: { captureImage: () => string | null } | null) => void) | undefined;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToWindow: () => void;
  onResetView: () => void;
  onAttachSelection?: () => void;
  evidenceHighlight?: TimelineEvidenceHighlight | null;
}

export function TracePane({
  label,
  traceData,
  processes,
  viewState,
  onViewStateChange,
  timeBounds,
  selectedEvent,
  onEventSelect,
  tool,
  onToolChange,
  searchQuery,
  onRegisterApi,
  onZoomIn,
  onZoomOut,
  onFitToWindow,
  onResetView,
  onAttachSelection,
  evidenceHighlight,
}: TracePaneProps) {
  let normalizedEventCount = 0;
  for (const process of processes.values()) {
    for (const thread of process.threads.values()) {
      for (const event of thread.events) {
        if (event.__lupa?.kind !== "marker") normalizedEventCount++;
      }
    }
  }

  if (!traceData) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-xs text-[#666]">
        Load {label.toLowerCase()} run.
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 min-h-0 flex-col overflow-hidden bg-white">
      <div className="border-b border-[#ddd] bg-[#f7f7f7] px-3 py-1.5">
        <div className="text-[11px] font-medium uppercase tracking-wide text-[#555]">{label}</div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <Minimap
            traceData={traceData}
            viewState={viewState}
            onViewStateChange={onViewStateChange}
            timeBounds={timeBounds}
          />

          <Timeline
            processes={processes}
            viewState={viewState}
            onViewStateChange={onViewStateChange}
            onEventSelect={onEventSelect}
            selectedEvent={selectedEvent}
            tool={tool}
            searchQuery={searchQuery}
            onRegisterApi={onRegisterApi}
            evidenceHighlight={evidenceHighlight}
          />

          {selectedEvent && onAttachSelection && (
            <DetailsPanel
              event={selectedEvent}
              processes={processes}
              onClose={() => onEventSelect(null)}
              onAttachToChat={onAttachSelection}
            />
          )}
        </div>

        <SideToolbar
          tool={tool}
          onToolChange={onToolChange}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
          onFitToWindow={onFitToWindow}
          onResetView={onResetView}
          hasData={traceData !== null}
        />
      </div>

      <StatusBar
        viewState={viewState}
        processes={processes}
        eventCount={normalizedEventCount}
        selectedEvent={selectedEvent}
      />
    </div>
  );
}
