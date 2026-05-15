import type { TraceRunInput } from "@/lib/trace-run";
import type { TraceWorkerOutbound } from "@/lib/workers/trace-parser.worker";

let idCounter = 0;

export function parseTraceFile(
  file: File,
  onProgress?: (bytesRead: number) => void
): Promise<TraceRunInput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./workers/trace-parser.worker.ts", import.meta.url)
    );
    const id = `parse-${++idCounter}`;

    const cleanup = () => worker.terminate();

    worker.onmessage = (event: MessageEvent<TraceWorkerOutbound>) => {
      const msg = event.data;
      if (msg.id !== id) return;

      switch (msg.kind) {
        case "progress":
          onProgress?.(msg.bytesRead);
          break;
        case "result":
          cleanup();
          resolve({ traceData: msg.traceData, filename: file.name });
          break;
        case "error":
          cleanup();
          reject(new Error(msg.message));
          break;
      }
    };

    worker.onerror = (event) => {
      cleanup();
      reject(
        new Error(
          `Trace parser worker crashed: ${event.message || "unknown error"}`
        )
      );
    };

    worker.postMessage({ kind: "parse", file, id });
  });
}
