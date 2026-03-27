"use client";

import type { TraceEvent, ViewState, Process } from "@/lib/trace-types";
import { formatTimeShort } from "@/lib/trace-types";

interface StatusBarProps {
  viewState: ViewState;
  processes: Map<number, Process>;
  eventCount: number;
  selectedEvent: TraceEvent | null;
}

export function StatusBar({ selectedEvent }: StatusBarProps) {
  if (selectedEvent) {
    const duration = selectedEvent.dur ? formatTimeShort(selectedEvent.dur) : "N/A";
    const category = selectedEvent.cat || "N/A";
    
    return (
      <div className="flex items-center gap-4 px-2 py-1 bg-[#f0f0f0] border-t border-[#ccc] text-xs text-[#333]">
        <span className="font-medium truncate max-w-md">{selectedEvent.name}</span>
        <span className="text-[#666]">Duration: {duration}</span>
        <span className="text-[#666]">Category: {category}</span>
        <span className="text-[#666]">Start: {formatTimeShort(selectedEvent.ts)}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4 px-2 py-1 bg-[#f0f0f0] border-t border-[#ccc] text-xs text-[#666]">
      <span>Nothing selected. Tap stuff.</span>
    </div>
  );
}
