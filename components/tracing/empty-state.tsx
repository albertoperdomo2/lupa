"use client";

import { FileJson, Upload, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  onLoadFile: () => void;
  onLoadSample: () => void;
}

export function EmptyState({ onLoadFile, onLoadSample }: EmptyStateProps) {
  return (
    <div className="flex-1 flex items-center justify-center bg-white">
      <div className="text-center max-w-lg px-4">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-[#f5f5f5] mb-6 border border-[#ddd]">
          <FileJson className="h-10 w-10 text-[#666]" />
        </div>
        <h2 className="text-2xl font-semibold text-[#333] mb-3">Tracing Viewer</h2>
        <p className="text-sm text-[#666] mb-8 leading-relaxed">
          Load a Chrome trace JSON file to visualize performance data. You can record traces
          using Chrome DevTools Performance panel, <code className="bg-[#f0f0f0] px-1 rounded text-xs text-[#333]">chrome://tracing</code>, or via command line.
        </p>
        <div className="flex flex-col gap-3 items-center mb-8">
          <Button 
            onClick={onLoadFile} 
            className="gap-2 h-10 px-6 bg-[#4285f4] hover:bg-[#3367d6] text-white"
          >
            <Upload className="h-4 w-4" />
            Load Trace File
          </Button>
          <Button 
            variant="outline" 
            onClick={onLoadSample} 
            className="gap-2 border-[#ddd] text-[#333] hover:bg-[#f5f5f5]"
          >
            <FileJson className="h-4 w-4" />
            Load Sample Trace
          </Button>
        </div>
        
        <div className="bg-[#f8f8f8] rounded-lg p-4 border border-[#e0e0e0]">
          <div className="flex items-center justify-center gap-2 mb-3">
            <Keyboard className="h-4 w-4 text-[#666]" />
            <span className="text-xs font-medium text-[#666] uppercase tracking-wide">Keyboard Shortcuts</span>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs max-w-xs mx-auto">
            <div className="flex items-center gap-2">
              <kbd className="font-mono bg-white px-1.5 py-0.5 rounded border border-[#ccc] text-[#333] shadow-sm">W</kbd>
              <span className="text-[#666]">Zoom in</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="font-mono bg-white px-1.5 py-0.5 rounded border border-[#ccc] text-[#333] shadow-sm">S</kbd>
              <span className="text-[#666]">Zoom out</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="font-mono bg-white px-1.5 py-0.5 rounded border border-[#ccc] text-[#333] shadow-sm">A</kbd>
              <span className="text-[#666]">Pan left</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="font-mono bg-white px-1.5 py-0.5 rounded border border-[#ccc] text-[#333] shadow-sm">D</kbd>
              <span className="text-[#666]">Pan right</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="font-mono bg-white px-1.5 py-0.5 rounded border border-[#ccc] text-[#333] shadow-sm">1</kbd>
              <span className="text-[#666]">Select tool</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="font-mono bg-white px-1.5 py-0.5 rounded border border-[#ccc] text-[#333] shadow-sm">2</kbd>
              <span className="text-[#666]">Pan tool</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="font-mono bg-white px-1.5 py-0.5 rounded border border-[#ccc] text-[#333] shadow-sm">0</kbd>
              <span className="text-[#666]">Fit to window</span>
            </div>
            <div className="flex items-center gap-2">
              <kbd className="font-mono bg-white px-1.5 py-0.5 rounded border border-[#ccc] text-[#333] shadow-sm">Esc</kbd>
              <span className="text-[#666]">Deselect</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
