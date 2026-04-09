export type TraceEventKind = "span" | "spike" | "counter" | "flow" | "marker";

export interface TraceEvent {
  name: string;
  cat: string;
  ph: "B" | "E" | "X" | "i" | "I" | "C" | "M" | "R" | "s" | "t" | "f";
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: Record<string, unknown>;
  cname?: string;
  __lupa?: {
    id: string;
    kind: TraceEventKind;
    sourcePhases: TraceEvent["ph"][];
  };
}

export interface TraceData {
  traceEvents: TraceEvent[];
  metadata?: {
    "command_line"?: string;
    "cpu-brand"?: string;
    "network-type"?: string;
    "num-cpus"?: number;
    "os-arch"?: string;
    "os-name"?: string;
    "os-version"?: string;
    "physical-memory"?: number;
    "trace-capture-datetime"?: string;
  };
}

export interface ProcessThread {
  pid: number;
  tid: number;
  name: string;
  events: TraceEvent[];
}

export interface Process {
  pid: number;
  name: string;
  threads: Map<number, ProcessThread>;
}

export interface TimelineSelection {
  startTime: number;
  endTime: number;
  event?: TraceEvent;
}

export interface ViewState {
  startTime: number;
  endTime: number;
  scale: number;
}

export const SPIKE_EVENT_DURATION_THRESHOLD_US = 1000;

export const TRACE_COLORS = [
  "#4fc3f7", // blue
  "#81c784", // green
  "#ffd54f", // yellow
  "#ffb74d", // orange
  "#ef5350", // red
  "#ba68c8", // purple
  "#4dd0e1", // cyan
  "#f48fb1", // pink
  "#aed581", // lime
  "#4db6ac", // teal
  "#90a4ae", // blue-grey
  "#a1887f", // brown
];

export function getEventColor(event: TraceEvent, index: number): string {
  if (event.cname) {
    const colorMap: Record<string, string> = {
      "good": "#81c784",
      "bad": "#ef5350",
      "terrible": "#d32f2f",
      "generic_work": "#90caf9",
      "thread_state_sleeping": "#f8bbd9",
      "thread_state_runnable": "#81c784",
      "thread_state_running": "#4fc3f7",
      "thread_state_unknown": "#9e9e9e",
      "thread_state_iowait": "#ffb74d",
      "thread_state_uninterruptible": "#ef5350",
      "background_memory_dump": "#ba68c8",
      "light_memory_dump": "#ce93d8",
      "detailed_memory_dump": "#7b1fa2",
      "vsync_highlight_color": "#ffd54f",
      "heap_dump_stack_frame": "#4dd0e1",
      "heap_dump_object_type": "#26c6da",
      "heap_dump_child_node_arrow": "#80deea",
      "rail_response": "#a5d6a7",
      "rail_animation": "#90caf9",
      "rail_idle": "#fff59d",
      "rail_load": "#ce93d8",
      "cq_build_running": "#64b5f6",
      "cq_build_passed": "#a5d6a7",
      "cq_build_failed": "#ef5350",
      "cq_build_abandoned": "#9e9e9e",
      "cq_build_attempt_runnig": "#64b5f6",
      "cq_build_attempt_passed": "#a5d6a7",
      "cq_build_attempt_failed": "#ef5350",
      "olive": "#c5e1a5",
    };
    return colorMap[event.cname] || TRACE_COLORS[index % TRACE_COLORS.length];
  }
  
  // Hash the event name to get a consistent color
  let hash = 0;
  for (let i = 0; i < event.name.length; i++) {
    hash = ((hash << 5) - hash) + event.name.charCodeAt(i);
    hash = hash & hash;
  }
  return TRACE_COLORS[Math.abs(hash) % TRACE_COLORS.length];
}

export function formatTime(microseconds: number): string {
  if (microseconds < 1000) {
    return `${microseconds.toFixed(2)} µs`;
  } else if (microseconds < 1000000) {
    return `${(microseconds / 1000).toFixed(2)} ms`;
  } else {
    return `${(microseconds / 1000000).toFixed(2)} s`;
  }
}

export function formatTimeShort(microseconds: number): string {
  if (microseconds < 1000) {
    return `${Math.round(microseconds)} µs`;
  } else if (microseconds < 1000000) {
    return `${(microseconds / 1000).toFixed(1)} ms`;
  } else {
    return `${(microseconds / 1000000).toFixed(2)} s`;
  }
}

export function getTraceEventKind(event: Pick<TraceEvent, "ph" | "dur" | "__lupa">): TraceEventKind {
  if (event.__lupa?.kind) {
    return event.__lupa.kind;
  }

  if (event.ph === "i" || event.ph === "I" || event.ph === "R") {
    return "spike";
  }

  if (event.ph === "X") {
    return (event.dur ?? 0) < SPIKE_EVENT_DURATION_THRESHOLD_US ? "spike" : "span";
  }

  if (event.ph === "C") {
    return "counter";
  }

  if (event.ph === "s" || event.ph === "t" || event.ph === "f") {
    return "flow";
  }

  if (event.ph === "B") {
    return (event.dur ?? 0) > 0 ? "span" : "marker";
  }

  return "marker";
}

export function isSpikeEvent(event: Pick<TraceEvent, "ph" | "dur" | "__lupa">): boolean {
  if (event.__lupa?.kind) {
    return event.__lupa.kind === "spike";
  }

  if (event.ph === "i" || event.ph === "I" || event.ph === "R") {
    return true;
  }

  if (event.ph === "X") {
    return (event.dur ?? 0) < SPIKE_EVENT_DURATION_THRESHOLD_US;
  }

  return false;
}
