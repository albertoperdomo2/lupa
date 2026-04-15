"use client";

import { FileJson, Upload, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  onLoadFile: () => void;
}

export function EmptyState({ onLoadFile }: EmptyStateProps) {
  return (
    <div className="flex-1 overflow-y-auto bg-white">
      <div className="flex min-h-full items-start justify-center px-4 pb-8 pt-14 sm:pt-20">
        <div className="max-w-lg text-center">
          <div className="mb-6 inline-flex h-20 w-20 items-center justify-center rounded-full border border-[#ddd] bg-[#f5f5f5]">
            <FileJson className="h-10 w-10 text-[#666]" />
          </div>
          <h2 className="mb-3 text-2xl font-semibold text-[#333]">lupa</h2>
          <p className="mb-8 text-sm leading-relaxed text-[#666]">
            Load one or more Chrome trace JSON files to inspect a full run. You can record traces
            using Chrome DevTools Performance panel,{" "}
            <code className="rounded bg-[#f0f0f0] px-1 text-xs text-[#333]">chrome://tracing</code>,
            or via command line. If a run spans multiple pods or processes, load all of its trace
            files together.
          </p>
          <div className="mb-8 flex flex-col items-center gap-3">
            <Button
              onClick={onLoadFile}
              className="h-10 gap-2 bg-[#4285f4] px-6 text-white hover:bg-[#3367d6]"
            >
              <Upload className="h-4 w-4" />
              Load Run Files
            </Button>
          </div>

          <div className="rounded-lg border border-[#e0e0e0] bg-[#f8f8f8] p-4">
            <div className="mb-3 flex items-center justify-center gap-2">
              <Keyboard className="h-4 w-4 text-[#666]" />
              <span className="text-xs font-medium uppercase tracking-wide text-[#666]">
                Keyboard Shortcuts
              </span>
            </div>
            <div className="mx-auto grid max-w-xs grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <div className="flex items-center gap-2">
                <kbd className="rounded border border-[#ccc] bg-white px-1.5 py-0.5 font-mono text-[#333] shadow-sm">
                  W
                </kbd>
                <span className="text-[#666]">Zoom in</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded border border-[#ccc] bg-white px-1.5 py-0.5 font-mono text-[#333] shadow-sm">
                  S
                </kbd>
                <span className="text-[#666]">Zoom out</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded border border-[#ccc] bg-white px-1.5 py-0.5 font-mono text-[#333] shadow-sm">
                  A
                </kbd>
                <span className="text-[#666]">Pan left</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded border border-[#ccc] bg-white px-1.5 py-0.5 font-mono text-[#333] shadow-sm">
                  D
                </kbd>
                <span className="text-[#666]">Pan right</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded border border-[#ccc] bg-white px-1.5 py-0.5 font-mono text-[#333] shadow-sm">
                  1
                </kbd>
                <span className="text-[#666]">Select tool</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded border border-[#ccc] bg-white px-1.5 py-0.5 font-mono text-[#333] shadow-sm">
                  2
                </kbd>
                <span className="text-[#666]">Pan tool</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded border border-[#ccc] bg-white px-1.5 py-0.5 font-mono text-[#333] shadow-sm">
                  0
                </kbd>
                <span className="text-[#666]">Fit to window</span>
              </div>
              <div className="flex items-center gap-2">
                <kbd className="rounded border border-[#ccc] bg-white px-1.5 py-0.5 font-mono text-[#333] shadow-sm">
                  Esc
                </kbd>
                <span className="text-[#666]">Deselect</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
