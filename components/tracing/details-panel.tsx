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
              <div className="text-xs font-medium text-[#666] mb-2">Arguments</div>
              <div className="bg-[#f8f8f8] rounded p-2 font-mono text-xs text-[#333] overflow-x-auto border border-[#e0e0e0]">
                <pre className="whitespace-pre-wrap break-all">
                  {JSON.stringify(event.args, null, 2)}
                </pre>
              </div>
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
