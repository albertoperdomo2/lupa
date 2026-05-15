import { JSONParser } from "@streamparser/json";
import type { TraceData, TraceEvent } from "@/lib/trace-types";

type JsonKey = string | number | undefined;

export interface TraceParseRequest {
  kind: "parse";
  file: File;
  id: string;
}

export type TraceWorkerOutbound =
  | { kind: "progress"; id: string; bytesRead: number; totalBytes: number }
  | { kind: "result"; id: string; traceData: TraceData }
  | { kind: "error"; id: string; message: string };

const PROGRESS_INTERVAL_MS = 200;

function detectBareArray(firstChunk: string): boolean {
  for (let i = 0; i < firstChunk.length; i++) {
    const ch = firstChunk[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    return ch === "[";
  }
  return false;
}

self.onmessage = async (event: MessageEvent<TraceParseRequest>) => {
  const { file, id } = event.data;
  const totalBytes = file.size;

  const events: TraceEvent[] = [];
  let metadata: TraceData["metadata"] | undefined;
  let bytesRead = 0;
  let lastProgressTime = 0;
  let isBareArray: boolean | null = null;
  let parser: JSONParser | null = null;

  const decoder = new TextDecoder();

  function postProgress() {
    const now = performance.now();
    if (now - lastProgressTime < PROGRESS_INTERVAL_MS) return;
    lastProgressTime = now;
    self.postMessage({
      kind: "progress",
      id,
      bytesRead,
      totalBytes,
    } satisfies TraceWorkerOutbound);
  }

  function createParser(bareArray: boolean): JSONParser {
    const paths = bareArray ? ["$.*"] : ["$.traceEvents.*", "$.metadata"];

    const p = new JSONParser({ paths, keepStack: false });

    p.onValue = ({
      value,
      key,
      stack,
    }: {
      value?: unknown;
      key?: JsonKey;
      stack: unknown[];
    }) => {
      if (bareArray) {
        if (stack.length === 1 && typeof key === "number") {
          events.push(value as TraceEvent);
        }
        return;
      }

      if (stack.length === 2 && typeof key === "number") {
        events.push(value as TraceEvent);
        return;
      }
      if (stack.length === 1 && key === "metadata") {
        metadata = value as TraceData["metadata"];
      }
    };

    return p;
  }

  let lastError: string | null = null;

  try {
    const reader = file.stream().getReader();

    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;

      const text = decoder.decode(chunk, { stream: true });

      if (parser === null) {
        isBareArray = detectBareArray(text);
        parser = createParser(isBareArray);
        // Route errors to callback so write()/end() don't throw.
        // Non-fatal tokenizer warnings (e.g. trailing data after root
        // object) fire here but parsing continues.
        parser.onError = (err: Error) => {
          lastError = err.message;
        };
      }

      parser.write(text);
      bytesRead += chunk.byteLength;
      postProgress();
    }

    if (parser) {
      const trailing = decoder.decode();
      if (trailing) parser.write(trailing);
      parser.end();
    }
  } catch (err) {
    lastError =
      err instanceof Error ? err.message : "Failed to read trace file.";
  }

  if (events.length === 0) {
    self.postMessage({
      kind: "error",
      id,
      message: lastError
        ? `Invalid JSON: ${lastError}`
        : "Invalid trace format. Expected Chrome trace JSON with a traceEvents array.",
    } satisfies TraceWorkerOutbound);
    return;
  }

  const traceData: TraceData =
    isBareArray
      ? { traceEvents: events }
      : { traceEvents: events, metadata };

  self.postMessage({
    kind: "result",
    id,
    traceData,
  } satisfies TraceWorkerOutbound);
};
