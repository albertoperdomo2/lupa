"use client";

import { Paperclip, X } from "lucide-react";
import type { TraceEvent, Process } from "@/lib/trace-types";
import { formatTime, getEventColor } from "@/lib/trace-types";
import { Button } from "@/components/ui/button";

interface DetailsPanelProps {
  event: TraceEvent | null;
  processes: Map<number, Process>;
  onClose: () => void;
  onAttachToChat: () => void;
}

export function DetailsPanel({
  event,
  processes,
  onClose,
  onAttachToChat,
}: DetailsPanelProps) {
  if (!event) return null;

  const process = processes.get(event.pid);
  const thread = process?.threads.get(event.tid);

  return (
    <div className="h-[220px] min-h-0 shrink-0 bg-white border-t border-[#ccc] flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#ddd] bg-[#f0f0f0] px-3 py-1.5">
        <span className="min-w-0 flex-1 text-xs font-medium text-[#333]">Selection Details</span>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={onAttachToChat}
            className="h-6 whitespace-nowrap rounded-sm border-[#ccc] bg-white px-2 text-[11px] text-[#444] hover:bg-[#f8f8f8]"
          >
            <Paperclip className="h-3 w-3" />
            Attach to Chat
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-5 w-5 p-0 text-[#666] hover:text-[#333] hover:bg-[#ddd]"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-3">
          {/* Event Name with Color Indicator */}
          <div className="flex items-center gap-2 mb-3">
            <div
              className="w-3 h-3 rounded-sm flex-shrink-0"
              style={{ backgroundColor: getEventColor(event, 0) }}
            />
            <span className="text-sm font-semibold text-[#333] break-all">{event.name}</span>
          </div>

          {/* Details Grid */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-xs">
            <DetailRow label="Category" value={event.cat || "N/A"} />
            <DetailRow label="Start" value={formatTime(event.ts)} />
            {event.dur !== undefined && (
              <DetailRow label="Duration" value={formatTime(event.dur)} />
            )}
            <DetailRow label="Phase" value={getPhaseDescription(event.ph)} />
            <DetailRow label="Process" value={process?.name || `PID ${event.pid}`} />
            <DetailRow label="Thread" value={thread?.name || `TID ${event.tid}`} />
            <DetailRow label="PID" value={String(event.pid)} />
            <DetailRow label="TID" value={String(event.tid)} />
          </div>

          {/* Arguments */}
          {event.args && Object.keys(event.args).length > 0 && (
            <div className="mt-3 pt-3 border-t border-[#ddd]">
              <StructuredArgs args={event.args} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[#666] w-16">{label}:</span>
      <span className="text-[#333] font-mono truncate">{value}</span>
    </div>
  );
}

function getPhaseDescription(phase: string): string {
  const phases: Record<string, string> = {
    B: "Begin",
    E: "End",
    X: "Complete",
    i: "Instant",
    I: "Instant (deprecated)",
    C: "Counter",
    M: "Metadata",
    s: "Async Begin",
    t: "Async Step",
    f: "Async End",
  };
  return phases[phase] || phase;
}

function formatDims(dims: unknown): string {
  if (!Array.isArray(dims)) return String(dims);
  return dims.map((d) => (Array.isArray(d) ? `[${d.join(", ")}]` : String(d))).join(", ");
}

function truncatePath(path: string, maxLen = 60): string {
  if (path.length <= maxLen) return path;
  return "..." + path.slice(-(maxLen - 3));
}

const STRUCTURED_KEYS = new Set([
  "Input Dims", "Input type", "Input Strides",
  "kernel_file", "kernel_backend", "kernel_hash", "num_warps", "num_stages", "stream",
  "Collective name", "Process Group Name", "Process Group Ranks", "Group size",
  "In msg nelems", "Out msg nelems",
  "External id",
]);

function StructuredArgs({ args }: { args: Record<string, unknown> }) {
  const hasTensor = "Input Dims" in args || "Input type" in args;
  const hasKernel = "kernel_file" in args || "kernel_backend" in args;
  const hasCollective = "Collective name" in args || "Process Group Name" in args;
  const externalId = args["External id"];

  const remainingArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!STRUCTURED_KEYS.has(k)) remainingArgs[k] = v;
  }
  const hasRemaining = Object.keys(remainingArgs).length > 0;

  return (
    <>
      {externalId != null && (
        <div className="mb-2">
          <ArgRow label="External ID" value={String(externalId)} />
        </div>
      )}

      {hasTensor && (
        <div className="mb-2">
          <div className="text-xs font-medium text-[#666] mb-1">Tensor Info</div>
          <div className="bg-[#f0f5ff] rounded p-1.5 text-xs font-mono text-[#333] border border-[#d0ddf0]">
            {"Input type" in args && <ArgRow label="Type" value={formatDims(args["Input type"])} />}
            {"Input Dims" in args && <ArgRow label="Dims" value={formatDims(args["Input Dims"])} />}
            {"Input Strides" in args && <ArgRow label="Strides" value={formatDims(args["Input Strides"])} />}
          </div>
        </div>
      )}

      {hasKernel && (
        <div className="mb-2">
          <div className="text-xs font-medium text-[#666] mb-1">Kernel Info</div>
          <div className="bg-[#f5f0ff] rounded p-1.5 text-xs font-mono text-[#333] border border-[#ddd0f0]">
            {"kernel_backend" in args && <ArgRow label="Backend" value={String(args["kernel_backend"])} />}
            {"num_warps" in args && <ArgRow label="Warps" value={String(args["num_warps"])} />}
            {"num_stages" in args && <ArgRow label="Stages" value={String(args["num_stages"])} />}
            {"stream" in args && <ArgRow label="Stream" value={String(args["stream"])} />}
            {"kernel_file" in args && <ArgRow label="File" value={truncatePath(String(args["kernel_file"]))} />}
          </div>
        </div>
      )}

      {hasCollective && (
        <div className="mb-2">
          <div className="text-xs font-medium text-[#666] mb-1">Collective Info</div>
          <div className="bg-[#f0fff5] rounded p-1.5 text-xs font-mono text-[#333] border border-[#d0f0dd]">
            {"Collective name" in args && <ArgRow label="Op" value={String(args["Collective name"])} />}
            {"Process Group Name" in args && <ArgRow label="Group" value={String(args["Process Group Name"])} />}
            {"Group size" in args && <ArgRow label="Size" value={String(args["Group size"])} />}
            {"In msg nelems" in args && <ArgRow label="In elems" value={String(args["In msg nelems"])} />}
            {"Out msg nelems" in args && <ArgRow label="Out elems" value={String(args["Out msg nelems"])} />}
          </div>
        </div>
      )}

      {hasRemaining && (
        <details className="mt-1">
          <summary className="text-xs font-medium text-[#666] cursor-pointer select-none">
            Raw Arguments
          </summary>
          <div className="mt-1 bg-[#f8f8f8] rounded p-2 font-mono text-xs text-[#333] overflow-x-auto border border-[#e0e0e0]">
            <pre className="whitespace-pre-wrap break-all">
              {JSON.stringify(remainingArgs, null, 2)}
            </pre>
          </div>
        </details>
      )}

      {!hasRemaining && !hasTensor && !hasKernel && !hasCollective && externalId == null && (
        <div className="bg-[#f8f8f8] rounded p-2 font-mono text-xs text-[#333] overflow-x-auto border border-[#e0e0e0]">
          <pre className="whitespace-pre-wrap break-all">
            {JSON.stringify(args, null, 2)}
          </pre>
        </div>
      )}
    </>
  );
}

function ArgRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5 leading-[18px]">
      <span className="text-[#888] shrink-0">{label}:</span>
      <span className="text-[#333] break-all">{value}</span>
    </div>
  );
}
