"use client";

import {
  Camera,
  DatabaseZap,
  FileJson,
  GitCompareArrows,
  Hand,
  History,
  Maximize2,
  MousePointer,
  PanelLeftOpen,
  PanelRightOpen,
  Trash2,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";

type CommandPaletteMode = "single" | "deep";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: CommandPaletteMode;
  hasTrace: boolean;
  canExport: boolean;
  onLoadSingle: () => void;
  onLoadBaseline: () => void;
  onLoadCandidate: () => void;
  onSetMode: (mode: CommandPaletteMode) => void;
  onExportReport: () => void;
  onCaptureArea: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onPanLeft: () => void;
  onPanRight: () => void;
  onFitToWindow: () => void;
  onSelectTool: () => void;
  onPanTool: () => void;
  onClearSelection: () => void;
  onClearHistory: () => void;
  hasSavedTraces: boolean;
  onClearSavedTraces: () => void;
}

function runAndClose(action: () => void, onOpenChange: (open: boolean) => void) {
  action();
  onOpenChange(false);
}

export function CommandPalette({
  open,
  onOpenChange,
  mode,
  hasTrace,
  canExport,
  onLoadSingle,
  onLoadBaseline,
  onLoadCandidate,
  onSetMode,
  onExportReport,
  onCaptureArea,
  onZoomIn,
  onZoomOut,
  onPanLeft,
  onPanRight,
  onFitToWindow,
  onSelectTool,
  onPanTool,
  onClearSelection,
  onClearHistory,
  hasSavedTraces,
  onClearSavedTraces,
}: CommandPaletteProps) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Commands"
      description="Run viewer actions and discover shortcuts."
      className="max-w-[680px]"
    >
      <CommandInput placeholder="Search commands and shortcuts..." />
      <CommandList className="max-h-[70vh]">
        <CommandEmpty>No matching commands.</CommandEmpty>

        <CommandGroup heading="Open">
          <CommandItem onSelect={() => runAndClose(onLoadSingle, onOpenChange)}>
            <Upload />
            <span>Load run</span>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(() => onSetMode("single"), onOpenChange)}>
            <FileJson />
            <span>Switch to single run mode</span>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(() => onSetMode("deep"), onOpenChange)}>
            <GitCompareArrows />
            <span>Switch to deep mode</span>
          </CommandItem>
          {mode === "deep" && (
            <>
              <CommandItem onSelect={() => runAndClose(onLoadBaseline, onOpenChange)}>
                <Upload />
                <span>Load baseline run</span>
              </CommandItem>
              <CommandItem onSelect={() => runAndClose(onLoadCandidate, onOpenChange)}>
                <Upload />
                <span>Load candidate run</span>
              </CommandItem>
            </>
          )}
          {canExport && (
            <CommandItem onSelect={() => runAndClose(onExportReport, onOpenChange)}>
              <History />
              <span>Export deep compare report</span>
            </CommandItem>
          )}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Viewer">
          <CommandItem disabled={!hasTrace} onSelect={() => runAndClose(onCaptureArea, onOpenChange)}>
            <Camera />
            <span>Capture screenshot area</span>
          </CommandItem>
          <CommandItem disabled={!hasTrace} onSelect={() => runAndClose(onZoomIn, onOpenChange)}>
            <ZoomIn />
            <span>Zoom in</span>
            <CommandShortcut>W</CommandShortcut>
          </CommandItem>
          <CommandItem disabled={!hasTrace} onSelect={() => runAndClose(onZoomOut, onOpenChange)}>
            <ZoomOut />
            <span>Zoom out</span>
            <CommandShortcut>S</CommandShortcut>
          </CommandItem>
          <CommandItem disabled={!hasTrace} onSelect={() => runAndClose(onPanLeft, onOpenChange)}>
            <PanelLeftOpen />
            <span>Pan left</span>
            <CommandShortcut>A</CommandShortcut>
          </CommandItem>
          <CommandItem disabled={!hasTrace} onSelect={() => runAndClose(onPanRight, onOpenChange)}>
            <PanelRightOpen />
            <span>Pan right</span>
            <CommandShortcut>D</CommandShortcut>
          </CommandItem>
          <CommandItem disabled={!hasTrace} onSelect={() => runAndClose(onFitToWindow, onOpenChange)}>
            <Maximize2 />
            <span>Fit to window</span>
            <CommandShortcut>0</CommandShortcut>
          </CommandItem>
          <CommandItem disabled={!hasTrace} onSelect={() => runAndClose(onSelectTool, onOpenChange)}>
            <MousePointer />
            <span>Select tool</span>
            <CommandShortcut>1</CommandShortcut>
          </CommandItem>
          <CommandItem disabled={!hasTrace} onSelect={() => runAndClose(onPanTool, onOpenChange)}>
            <Hand />
            <span>Pan tool</span>
            <CommandShortcut>2</CommandShortcut>
          </CommandItem>
          <CommandItem disabled={!hasTrace} onSelect={() => runAndClose(onClearSelection, onOpenChange)}>
            <Trash2 />
            <span>Clear selection</span>
            <CommandShortcut>Esc</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Session">
          <CommandItem
            disabled={!hasSavedTraces}
            onSelect={() => runAndClose(onClearSavedTraces, onOpenChange)}
          >
            <DatabaseZap />
            <span>Clear saved traces</span>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(onClearHistory, onOpenChange)}>
            <Trash2 />
            <span>Clear chat history</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
