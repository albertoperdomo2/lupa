"use client";

import { Circle, Save, Upload, Search, ChevronDown, Minus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ToolbarProps {
  onLoadFile: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  hasData: boolean;
  filename?: string;
  showFlowEvents: boolean;
  onToggleFlowEvents: () => void;
  showProcesses: boolean;
  onToggleProcesses: () => void;
}

export function Toolbar({
  onLoadFile,
  onZoomIn,
  onZoomOut,
  searchQuery,
  onSearchChange,
  hasData,
  filename,
  showFlowEvents,
  onToggleFlowEvents,
  showProcesses,
  onToggleProcesses,
}: ToolbarProps) {
  return (
    <div className="flex items-center gap-0.5 px-1 py-0.5 bg-[#f0f0f0] border-b border-[#ccc] text-[#333] text-xs">
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs font-normal text-[#333] hover:bg-[#ddd] rounded-none"
        disabled
        title="Record trace (disabled in viewer)"
      >
        <Circle className="h-3 w-3 mr-1 text-[#999]" />
        Record
      </Button>

      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs font-normal text-[#333] hover:bg-[#ddd] rounded-none"
        disabled={!hasData}
        title="Save trace"
      >
        <Save className="h-3 w-3 mr-1" />
        Save
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={onLoadFile}
        className="h-6 px-2 text-xs font-normal text-[#333] hover:bg-[#ddd] rounded-none"
        title="Load trace file"
      >
        <Upload className="h-3 w-3 mr-1" />
        Load
      </Button>

      {filename && (
        <span className="px-2 text-xs text-[#666] truncate max-w-[200px]" title={filename}>
          {filename}
        </span>
      )}

      <div className="flex-1" />

      {hasData && (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleFlowEvents}
            className={`h-6 px-2 text-xs font-normal rounded-none ${
              showFlowEvents ? "bg-[#ddd] text-[#333]" : "text-[#666] hover:bg-[#ddd]"
            }`}
          >
            Flow events
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleProcesses}
            className={`h-6 px-2 text-xs font-normal rounded-none ${
              showProcesses ? "bg-[#ddd] text-[#333]" : "text-[#666] hover:bg-[#ddd]"
            }`}
          >
            Processes
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs font-normal text-[#666] hover:bg-[#ddd] rounded-none"
              >
                M
                <ChevronDown className="h-3 w-3 ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              <DropdownMenuCheckboxItem checked>
                Metadata
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs font-normal text-[#666] hover:bg-[#ddd] rounded-none"
              >
                View Options
                <ChevronDown className="h-3 w-3 ml-0.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              <DropdownMenuCheckboxItem checked>
                Show timeline
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked>
                Show flow arrows
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem checked>
                Highlight VSync
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Separator orientation="vertical" className="h-4 mx-1 bg-[#ccc]" />

          <div className="flex items-center bg-white border border-[#ccc] rounded-sm">
            <Button
              variant="ghost"
              size="sm"
              onClick={onZoomOut}
              className="h-5 w-5 p-0 rounded-none hover:bg-[#eee]"
              title="Zoom out"
            >
              <Minus className="h-3 w-3" />
            </Button>
            <Separator orientation="vertical" className="h-4 bg-[#ccc]" />
            <Button
              variant="ghost"
              size="sm"
              onClick={onZoomIn}
              className="h-5 w-5 p-0 rounded-none hover:bg-[#eee]"
              title="Zoom in"
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>

          <X className="h-3 w-3 ml-1 text-[#999]" />
        </>
      )}
    </div>
  );
}
