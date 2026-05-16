"use client";

import { MousePointer, Hand, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

interface SideToolbarProps {
  tool: "select" | "pan";
  onToolChange: (tool: "select" | "pan") => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitToWindow: () => void;
  onResetView: () => void;
  hasData: boolean;
}

export function SideToolbar({
  tool,
  onToolChange,
  onZoomIn,
  onZoomOut,
  onFitToWindow,
  hasData,
}: SideToolbarProps) {
  return (
    <div className="flex flex-col items-center gap-0.5 py-1 px-0.5 bg-[#f0f0f0] border-l border-[#ccc] w-7 shrink-0 overflow-hidden">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onToolChange("select")}
        className={`h-5 w-5 p-0 rounded-sm ${
          tool === "select" 
            ? "bg-[#ddd] text-[#333]" 
            : "text-[#666] hover:bg-[#e0e0e0] hover:text-[#333]"
        }`}
        disabled={!hasData}
        title="Selection tool (1)"
      >
        <MousePointer className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onToolChange("pan")}
        className={`h-5 w-5 p-0 rounded-sm ${
          tool === "pan" 
            ? "bg-[#ddd] text-[#333]" 
            : "text-[#666] hover:bg-[#e0e0e0] hover:text-[#333]"
        }`}
        disabled={!hasData}
        title="Pan tool (2)"
      >
        <Hand className="h-3 w-3" />
      </Button>

      <Separator className="w-4 my-0.5 bg-[#ccc]" />

      <Button
        variant="ghost"
        size="sm"
        onClick={onZoomIn}
        className="h-5 w-5 p-0 rounded-sm text-[#666] hover:bg-[#e0e0e0] hover:text-[#333]"
        disabled={!hasData}
        title="Zoom in (W)"
      >
        <ZoomIn className="h-3 w-3" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onZoomOut}
        className="h-5 w-5 p-0 rounded-sm text-[#666] hover:bg-[#e0e0e0] hover:text-[#333]"
        disabled={!hasData}
        title="Zoom out (S)"
      >
        <ZoomOut className="h-3 w-3" />
      </Button>

      <Separator className="w-4 my-0.5 bg-[#ccc]" />

      <Button
        variant="ghost"
        size="sm"
        onClick={onFitToWindow}
        className="h-5 w-5 p-0 rounded-sm text-[#666] hover:bg-[#e0e0e0] hover:text-[#333]"
        disabled={!hasData}
        title="Fit to window (0)"
      >
        <Maximize2 className="h-3 w-3" />
      </Button>
    </div>
  );
}
