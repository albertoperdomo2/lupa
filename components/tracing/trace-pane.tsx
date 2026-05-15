"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";
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
  collapsed?: boolean;
  onToggleCollapse?: () => void;
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
  collapsed,
  onToggleCollapse,
}: TracePaneProps) {
  let normalizedEventCount = 0;
  for (const process of processes.values()) {
    for (const thread of process.threads.values()) {
      for (const event of thread.events) {
        if (event.__lupa?.kind !== "marker") normalizedEventCount++;
      }
    }
  }

  if (collapsed) {
    return (
      <div className="flex h-full items-center justify-center bg-[#f7f7f7] border-r border-[#ddd]">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex flex-col items-center gap-1.5 py-3 px-1 hover:bg-[#eee] rounded-sm transition-colors cursor-pointer"
          title={`Expand ${label}`}
        >
          <ChevronRight className="h-3 w-3 text-[#888]" />
          <span className="text-[11px] font-medium uppercase tracking-wide text-[#555] [writing-mode:vertical-lr]">
            {label}
          </span>
        </button>
      </div>
    );
  }

  if (!traceData) {
    return (
      <div className="flex h-full flex-col bg-white">
        {onToggleCollapse && (
          <div className="border-b border-[#ddd] bg-[#f7f7f7] px-3 py-1.5">
            <button
              type="button"
              onClick={onToggleCollapse}
              className="flex items-center gap-1 hover:text-[#333] transition-colors cursor-pointer"
            >
              <ChevronLeft className="h-3 w-3 text-[#888]" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#555]">{label}</span>
            </button>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center text-xs text-[#666]">
          Load {label.toLowerCase()} run.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-w-0 min-h-0 flex-col overflow-hidden bg-white">
      <div className="border-b border-[#ddd] bg-[#f7f7f7] px-3 py-1.5">
        {onToggleCollapse ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="flex items-center gap-1 hover:text-[#333] transition-colors cursor-pointer"
          >
            <ChevronLeft className="h-3 w-3 text-[#888]" />
            <span className="text-[11px] font-medium uppercase tracking-wide text-[#555]">{label}</span>
          </button>
        ) : (
          <div className="text-[11px] font-medium uppercase tracking-wide text-[#555]">{label}</div>
        )}
        <TraceInfoRow traceData={traceData} />
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

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(0)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(0)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function TraceInfoRow({ traceData }: { traceData: TraceData | null }) {
  if (!traceData) return null;

  const parts: string[] = [];

  const gpu = traceData.deviceProperties?.[0];
  if (gpu?.name) {
    const mem = gpu.totalGlobalMem ? ` · ${formatBytes(gpu.totalGlobalMem)}` : "";
    parts.push(`${gpu.name}${mem}`);
  }

  const dist = traceData.distributedInfo;
  if (dist && dist.rank != null && dist.world_size != null) {
    const backend = dist.backend ? ` · ${dist.backend.toUpperCase()}` : "";
    parts.push(`Rank ${dist.rank}/${dist.world_size}${backend}`);
  }

  if (traceData.withStack) parts.push("stacks");
  if (traceData.recordShapes) parts.push("shapes");

  if (parts.length === 0) return null;

  return (
    <div className="mt-0.5 text-[10px] text-[#888] truncate">
      {parts.join(" · ")}
    </div>
  );
}
