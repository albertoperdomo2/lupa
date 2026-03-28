"use client";

import {
  DatabaseZap,
  GitCompareArrows,
  Search,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface CompareControlsProps {
  mode: "single" | "deep";
  onModeChange: (mode: "single" | "deep") => void;
  baselineFilename?: string;
  candidateFilename?: string;
  singleFilename?: string;
  onLoadSingle: () => void;
  onLoadBaseline: () => void;
  onLoadCandidate: () => void;
  onExportReport?: () => void;
  canExport: boolean;
  onOpenCommandPalette: () => void;
  hasSavedTraces: boolean;
  onClearSavedTraces: () => void;
}

function FilenameChip({
  label,
  value,
}: {
  label: string;
  value?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-sm border border-[#dddddd] bg-white px-2 py-1">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[#777]">
        {label}
      </span>
      <span className="truncate text-[11px] text-[#444]" title={value}>
        {value ?? "Not loaded"}
      </span>
    </div>
  );
}

export function CompareControls({
  mode,
  onModeChange,
  baselineFilename,
  candidateFilename,
  singleFilename,
  onLoadSingle,
  onLoadBaseline,
  onLoadCandidate,
  onExportReport,
  canExport,
  onOpenCommandPalette,
  hasSavedTraces,
  onClearSavedTraces,
}: CompareControlsProps) {
  return (
    <div className="border-b border-[#d4d4d4] bg-[#f8f8f8] px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={mode}
          onValueChange={(value) => onModeChange(value as "single" | "deep")}
          className="gap-0"
        >
          <TabsList className="h-10 rounded-sm border border-[#d2d2d2] bg-[#ececec] p-[3px]">
            <TabsTrigger
              value="single"
              className="h-8 rounded-sm px-4 text-xs font-semibold text-[#565656] data-[state=active]:border-[#1f1f1f] data-[state=active]:bg-[#1f1f1f] data-[state=active]:text-white data-[state=active]:shadow-sm"
            >
              Single Trace
            </TabsTrigger>
            <TabsTrigger
              value="deep"
              className="h-8 rounded-sm px-4 text-xs font-semibold text-[#565656] data-[state=active]:border-[#1f1f1f] data-[state=active]:bg-[#1f1f1f] data-[state=active]:text-white data-[state=active]:shadow-sm"
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              Deep Mode
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onOpenCommandPalette}
            className="h-8 rounded-sm border-[#ccc] bg-white text-xs text-[#333] hover:bg-[#f4f4f4]"
          >
            <Search className="h-3.5 w-3.5" />
            Commands
            <KbdGroup className="ml-2">
              <Kbd className="h-4 min-w-4 px-1 text-[10px]">⌘</Kbd>
              <Kbd className="h-4 min-w-4 px-1 text-[10px]">K</Kbd>
            </KbdGroup>
          </Button>
          {mode === "single" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onLoadSingle}
                className="h-8 rounded-sm border-[#ccc] bg-white text-xs text-[#333] hover:bg-[#f4f4f4]"
              >
                <Upload className="h-3.5 w-3.5" />
                Load Trace
              </Button>
              {singleFilename && (
                <span className="max-w-[320px] truncate text-xs text-[#666]" title={singleFilename}>
                  {singleFilename}
                </span>
              )}
            </>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={onLoadBaseline}
                className="h-8 rounded-sm border-[#ccc] bg-white text-xs text-[#333] hover:bg-[#f4f4f4]"
              >
                <Upload className="h-3.5 w-3.5" />
                Load Baseline
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onLoadCandidate}
                className="h-8 rounded-sm border-[#ccc] bg-white text-xs text-[#333] hover:bg-[#f4f4f4]"
              >
                <Upload className="h-3.5 w-3.5" />
                Load Candidate
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!canExport}
                onClick={onExportReport}
                className="h-8 rounded-sm border-[#ccc] bg-white text-xs text-[#333] hover:bg-[#f4f4f4]"
              >
                Export Markdown
              </Button>
            </>
          )}
          {hasSavedTraces && (
            <Button
              variant="outline"
              size="sm"
              onClick={onClearSavedTraces}
              className="h-8 rounded-sm border-[#d9d0d0] bg-white text-xs text-[#7a3a3a] hover:bg-[#fff4f4]"
            >
              <DatabaseZap className="h-3.5 w-3.5" />
              Clear Saved Traces
            </Button>
          )}
        </div>
      </div>

      {(mode === "deep" || hasSavedTraces) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {mode === "deep" && (
            <>
              <FilenameChip label="Baseline" value={baselineFilename} />
              <FilenameChip label="Candidate" value={candidateFilename} />
              <div className="text-[11px] text-[#666]">
                Assuming same model, hardware, and workload family. Deep Mode compares raw runtime structure and timing deltas.
              </div>
            </>
          )}
          {hasSavedTraces && (
            <div className="text-[11px] text-[#666]">
              Loaded traces persist on this device and are restored after reload until you clear them.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
