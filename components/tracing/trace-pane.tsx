"use client";
import { ChevronLeft, ChevronRight, Info } from "lucide-react";
import type { Process, TraceData, TraceEvent, ViewState } from "@/lib/trace-types";
import { DetailsPanel } from "@/components/tracing/details-panel";
import { Minimap } from "@/components/tracing/minimap";
import { SideToolbar } from "@/components/tracing/side-toolbar";
import { StatusBar } from "@/components/tracing/status-bar";
import { Timeline, type TimelineEvidenceHighlight } from "@/components/tracing/timeline";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

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
      <div className="flex h-full items-center justify-center overflow-hidden bg-[#f7f7f7] border-r border-[#ddd]">
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
        <TraceInfoBadge traceData={traceData} />
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
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function formatCudaVersion(v: number): string {
  const major = Math.floor(v / 1000);
  const minor = Math.floor((v % 1000) / 10);
  return minor === 0 ? `${major}.0` : `${major}.${minor}`;
}

function shortenGpuName(name: string): string {
  return name.replace(/NVIDIA\s*/i, "").replace(/GeForce\s*/i, "");
}

export function TraceInfoBadge({ traceData }: { traceData: TraceData | null }) {
  if (!traceData) return null;

  const gpus = traceData.deviceProperties ?? [];
  const dist = traceData.distributedInfo;
  const meta = traceData.metadata;
  const hasGpu = gpus.length > 0 && Boolean(gpus[0]?.name);
  const hasCuda = traceData.cudaDriverVersion != null || traceData.cudaRuntimeVersion != null;
  const hasDist = dist != null && dist.rank != null;
  const hasMeta = Boolean(meta?.["cpu-brand"] || meta?.["os-name"]);
  const hasFlags = Boolean(traceData.withStack || traceData.recordShapes);

  const uniqueGpuNames = [...new Set(gpus.map((g) => g.name).filter(Boolean))];
  const chipLabel = uniqueGpuNames.length > 0
    ? `${gpus.length}× ${shortenGpuName(uniqueGpuNames[0]!)}`
    : hasDist
      ? `Rank ${dist!.rank}/${dist!.world_size}`
      : "Trace info";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="mt-0.5 flex items-center gap-1 rounded-sm border border-[#ddd] bg-white px-1.5 py-0.5 text-[10px] text-[#666] hover:border-[#bbb] hover:text-[#444] transition-colors cursor-pointer"
        >
          <Info className="h-2.5 w-2.5" />
          <span className="truncate max-w-[180px]">{chipLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-h-[70vh] overflow-y-auto bg-white p-0 text-[11px]">
        {hasGpu && (
          <div className="border-b border-[#eee] px-3 py-2">
            <div className="font-semibold text-[10px] uppercase tracking-wide text-[#999] mb-1">
              GPU{gpus.length > 1 ? `s (${gpus.length})` : ""}
            </div>
            {uniqueGpuNames.length === 1 ? (
              <>
                <InfoRow label="Device" value={`${gpus.length}× ${gpus[0]!.name!}`} />
                {gpus[0]!.totalGlobalMem != null && <InfoRow label="VRAM" value={`${formatBytes(gpus[0]!.totalGlobalMem!)} each`} />}
                {gpus[0]!.computeMajor != null && (
                  <InfoRow label="Compute" value={`sm_${gpus[0]!.computeMajor}${gpus[0]!.computeMinor ?? 0}`} />
                )}
                {gpus[0]!.numSms != null && <InfoRow label="SMs" value={String(gpus[0]!.numSms)} />}
                {gpus[0]!.sharedMemPerMultiprocessor != null && (
                  <InfoRow label="SMEM/SM" value={formatBytes(gpus[0]!.sharedMemPerMultiprocessor!)} />
                )}
                {gpus[0]!.warpSize != null && <InfoRow label="Warp" value={String(gpus[0]!.warpSize)} />}
              </>
            ) : (
              gpus.map((gpu) => (
                <div key={gpu.id ?? gpu.name} className="mb-1.5 last:mb-0">
                  <InfoRow label={`GPU ${gpu.id ?? ""}`} value={gpu.name ?? "Unknown"} />
                  {gpu.totalGlobalMem != null && <InfoRow label="VRAM" value={formatBytes(gpu.totalGlobalMem)} />}
                  {gpu.computeMajor != null && (
                    <InfoRow label="Compute" value={`sm_${gpu.computeMajor}${gpu.computeMinor ?? 0}`} />
                  )}
                </div>
              ))
            )}
          </div>
        )}
        {hasCuda && (
          <div className="border-b border-[#eee] px-3 py-2">
            <div className="font-semibold text-[10px] uppercase tracking-wide text-[#999] mb-1">CUDA</div>
            {traceData.cudaDriverVersion != null && (
              <InfoRow label="Driver" value={formatCudaVersion(traceData.cudaDriverVersion)} />
            )}
            {traceData.cudaRuntimeVersion != null && (
              <InfoRow label="Runtime" value={formatCudaVersion(traceData.cudaRuntimeVersion)} />
            )}
            {traceData.cuptiVersion != null && (
              <InfoRow label="CUPTI" value={formatCudaVersion(traceData.cuptiVersion)} />
            )}
          </div>
        )}
        {hasMeta && meta && (
          <div className="border-b border-[#eee] px-3 py-2">
            <div className="font-semibold text-[10px] uppercase tracking-wide text-[#999] mb-1">Host</div>
            {meta["cpu-brand"] && <InfoRow label="CPU" value={meta["cpu-brand"]} />}
            {meta["os-name"] && (
              <InfoRow label="OS" value={`${meta["os-name"]} ${meta["os-version"] ?? ""} ${meta["os-arch"] ?? ""}`.trim()} />
            )}
            {meta["physical-memory"] != null && (
              <InfoRow label="RAM" value={formatBytes(meta["physical-memory"])} />
            )}
            {meta["num-cpus"] != null && <InfoRow label="CPUs" value={String(meta["num-cpus"])} />}
          </div>
        )}
        {hasDist && dist && (
          <div className="border-b border-[#eee] px-3 py-2">
            <div className="font-semibold text-[10px] uppercase tracking-wide text-[#999] mb-1">Distributed</div>
            <InfoRow label="Rank" value={`${dist.rank} / ${dist.world_size}`} />
            {dist.backend && <InfoRow label="Backend" value={dist.backend.toUpperCase()} />}
            {dist.nccl_version && <InfoRow label="NCCL" value={dist.nccl_version} />}
            {dist.pg_count != null && <InfoRow label="Groups" value={String(dist.pg_count)} />}
            {dist.pg_config && dist.pg_config.length > 0 && (
              <div className="mt-1.5">
                <div className="text-[10px] text-[#999] mb-0.5">Process Groups</div>
                {dist.pg_config.slice(0, 8).map((pg) => (
                  <div key={pg.pg_name} className="flex items-baseline gap-1 py-0.5 text-[10px]">
                    <span className="font-mono text-[#555]">{pg.pg_desc || pg.pg_name}</span>
                    <span className="text-[#999]">·</span>
                    <span className="text-[#888]">{pg.backend_config}</span>
                    <span className="text-[#999]">·</span>
                    <span className="text-[#888]">{pg.pg_size} ranks</span>
                  </div>
                ))}
                {dist.pg_config.length > 8 && (
                  <div className="text-[10px] text-[#999]">+{dist.pg_config.length - 8} more</div>
                )}
              </div>
            )}
          </div>
        )}
        <div className="px-3 py-2">
          <div className="font-semibold text-[10px] uppercase tracking-wide text-[#999] mb-1">Trace</div>
          <InfoRow label="Events" value={traceData.traceEvents.length.toLocaleString()} />
          {traceData.schemaVersion != null && (
            <InfoRow label="Schema" value={`v${traceData.schemaVersion}`} />
          )}
          <InfoRow
            label="Features"
            value={[
              traceData.withStack && "stacks",
              traceData.recordShapes && "shapes",
            ].filter(Boolean).join(", ") || "none"}
          />
          {meta?.["trace-capture-datetime"] && (
            <InfoRow label="Captured" value={meta["trace-capture-datetime"]} />
          )}
          {traceData.traceName && (
            <InfoRow label="File" value={traceData.traceName.split("/").pop() ?? traceData.traceName} />
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="text-[#888] w-14 shrink-0">{label}</span>
      <span className="text-[#333] font-mono truncate">{value}</span>
    </div>
  );
}
