"use client";

import { Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { TraceData } from "@/lib/trace-types";

interface MetadataPanelProps {
  traceData: TraceData;
  onClose: () => void;
}

export function MetadataPanel({ traceData, onClose }: MetadataPanelProps) {
  const metadata = traceData.metadata || {};
  const eventCount = traceData.traceEvents.length;
  
  // Calculate time range
  let minTime = Infinity;
  let maxTime = -Infinity;
  let categorySet = new Set<string>();
  
  for (const event of traceData.traceEvents) {
    if (event.ph !== "M") {
      minTime = Math.min(minTime, event.ts);
      maxTime = Math.max(maxTime, event.ts + (event.dur || 0));
    }
    if (event.cat) {
      event.cat.split(",").forEach(c => categorySet.add(c.trim()));
    }
  }
  
  const duration = maxTime - minTime;
  const categories = Array.from(categorySet).sort();

  return (
    <div className="w-72 bg-card border-l border-border flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Trace Info</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="p-3">
          <Section title="Overview">
            <InfoRow label="Events" value={eventCount.toLocaleString()} />
            <InfoRow label="Duration" value={formatDuration(duration)} />
            <InfoRow label="Categories" value={String(categories.length)} />
          </Section>

          {Object.keys(metadata).length > 0 && (
            <Section title="System Info">
              {metadata["cpu-brand"] && (
                <InfoRow label="CPU" value={metadata["cpu-brand"]} />
              )}
              {metadata["num-cpus"] && (
                <InfoRow label="CPU Cores" value={String(metadata["num-cpus"])} />
              )}
              {metadata["physical-memory"] && (
                <InfoRow label="Memory" value={`${metadata["physical-memory"]} MB`} />
              )}
              {metadata["os-name"] && (
                <InfoRow
                  label="OS"
                  value={`${metadata["os-name"]} ${metadata["os-version"] || ""}`}
                />
              )}
              {metadata["os-arch"] && (
                <InfoRow label="Arch" value={metadata["os-arch"]} />
              )}
              {metadata["network-type"] && (
                <InfoRow label="Network" value={metadata["network-type"]} />
              )}
            </Section>
          )}

          {categories.length > 0 && (
            <Section title="Categories">
              <div className="flex flex-wrap gap-1">
                {categories.slice(0, 20).map((cat) => (
                  <span
                    key={cat}
                    className="px-1.5 py-0.5 bg-muted text-muted-foreground rounded text-xs font-mono"
                  >
                    {cat}
                  </span>
                ))}
                {categories.length > 20 && (
                  <span className="px-1.5 py-0.5 text-muted-foreground text-xs">
                    +{categories.length - 20} more
                  </span>
                )}
              </div>
            </Section>
          )}

          {metadata["command_line"] && (
            <Section title="Command Line">
              <div className="bg-muted rounded p-2 font-mono text-xs text-foreground overflow-x-auto">
                <pre className="whitespace-pre-wrap break-all">
                  {metadata["command_line"]}
                </pre>
              </div>
            </Section>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
        {title}
      </h3>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground font-mono">{value}</span>
    </div>
  );
}

function formatDuration(microseconds: number): string {
  if (!isFinite(microseconds) || microseconds <= 0) return "N/A";
  if (microseconds < 1000) return `${microseconds.toFixed(0)} µs`;
  if (microseconds < 1000000) return `${(microseconds / 1000).toFixed(1)} ms`;
  return `${(microseconds / 1000000).toFixed(2)} s`;
}
