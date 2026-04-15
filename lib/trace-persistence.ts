import type { TraceEvent, TraceData, ViewState } from "@/lib/trace-types";
import type { TraceNormalizationMode } from "@/lib/trace-chat";
import type { TraceRunSourceSummary } from "@/lib/trace-run";

const DB_NAME = "lupa-traces";
const DB_VERSION = 1;
const VIEWER_STATE_STORE = "viewer-state";
const TRACE_PAYLOAD_STORE = "trace-payloads";
const VIEWER_STATE_KEY = "session";

export type PersistedTraceSlot = "single" | "baseline" | "candidate";
export type PersistedViewerMode = "single" | "deep";

export interface PersistedTraceEventRef {
  name: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  ph: TraceEvent["ph"];
}

export interface PersistedTracePanePayload {
  traceData: TraceData;
  traceLoadedAt: string | null;
  filename?: string;
  sources?: TraceRunSourceSummary[];
}

export interface PersistedTracePaneUiState {
  hasTrace: boolean;
  tool: "select" | "pan";
  viewState: ViewState;
  selectedEvent: PersistedTraceEventRef | null;
}

interface PersistedViewerStateRecord {
  key: string;
  mode: PersistedViewerMode;
  normalizationMode: TraceNormalizationMode;
  single: PersistedTracePaneUiState;
  baseline: PersistedTracePaneUiState;
  candidate: PersistedTracePaneUiState;
}

interface PersistedTracePayloadRecord extends PersistedTracePanePayload {
  key: PersistedTraceSlot;
}

export interface RestoredTracePaneRecord {
  payload: PersistedTracePanePayload;
  state: PersistedTracePaneUiState;
}

export interface RestoredTraceSession {
  mode: PersistedViewerMode;
  normalizationMode: TraceNormalizationMode;
  single: RestoredTracePaneRecord | null;
  baseline: RestoredTracePaneRecord | null;
  candidate: RestoredTracePaneRecord | null;
}

function openTracePersistenceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(VIEWER_STATE_STORE)) {
        db.createObjectStore(VIEWER_STATE_STORE, {
          keyPath: "key",
        });
      }

      if (!db.objectStoreNames.contains(TRACE_PAYLOAD_STORE)) {
        db.createObjectStore(TRACE_PAYLOAD_STORE, {
          keyPath: "key",
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB."));
  });
}

function awaitRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function awaitTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

export async function loadPersistedTraceSession(): Promise<RestoredTraceSession | null> {
  const db = await openTracePersistenceDb();

  try {
    const transaction = db.transaction([VIEWER_STATE_STORE, TRACE_PAYLOAD_STORE], "readonly");
    const viewerStore = transaction.objectStore(VIEWER_STATE_STORE);
    const payloadStore = transaction.objectStore(TRACE_PAYLOAD_STORE);

    const viewerState = (await awaitRequest(
      viewerStore.get(VIEWER_STATE_KEY)
    )) as PersistedViewerStateRecord | undefined;

    if (!viewerState) {
      return null;
    }

    const restoreSlot = async (
      slot: PersistedTraceSlot
    ): Promise<RestoredTracePaneRecord | null> => {
      const state = viewerState[slot];
      if (!state?.hasTrace) return null;

      const payload = (await awaitRequest(
        payloadStore.get(slot)
      )) as PersistedTracePayloadRecord | undefined;

      if (!payload) return null;

      return {
        payload: {
          traceData: payload.traceData,
          traceLoadedAt: payload.traceLoadedAt,
          filename: payload.filename,
          sources: payload.sources,
        },
        state,
      };
    };

    const [single, baseline, candidate] = await Promise.all([
      restoreSlot("single"),
      restoreSlot("baseline"),
      restoreSlot("candidate"),
    ]);

    return {
      mode: viewerState.mode,
      normalizationMode: viewerState.normalizationMode,
      single,
      baseline,
      candidate,
    };
  } finally {
    db.close();
  }
}

export async function savePersistedTracePayload(
  slot: PersistedTraceSlot,
  payload: PersistedTracePanePayload | null
): Promise<void> {
  const db = await openTracePersistenceDb();

  try {
    const transaction = db.transaction(TRACE_PAYLOAD_STORE, "readwrite");
    const store = transaction.objectStore(TRACE_PAYLOAD_STORE);

    if (payload) {
      store.put({
        key: slot,
        ...payload,
      } satisfies PersistedTracePayloadRecord);
    } else {
      store.delete(slot);
    }

    await awaitTransaction(transaction);
  } finally {
    db.close();
  }
}

export async function savePersistedViewerState(
  state: {
    mode: PersistedViewerMode;
    normalizationMode: TraceNormalizationMode;
    single: PersistedTracePaneUiState;
    baseline: PersistedTracePaneUiState;
    candidate: PersistedTracePaneUiState;
  } | null
): Promise<void> {
  const db = await openTracePersistenceDb();

  try {
    const transaction = db.transaction(VIEWER_STATE_STORE, "readwrite");
    const store = transaction.objectStore(VIEWER_STATE_STORE);

    if (state) {
      store.put({
        key: VIEWER_STATE_KEY,
        ...state,
      } satisfies PersistedViewerStateRecord);
    } else {
      store.delete(VIEWER_STATE_KEY);
    }

    await awaitTransaction(transaction);
  } finally {
    db.close();
  }
}

export async function clearPersistedTraceSession(): Promise<void> {
  const db = await openTracePersistenceDb();

  try {
    const transaction = db.transaction([VIEWER_STATE_STORE, TRACE_PAYLOAD_STORE], "readwrite");
    transaction.objectStore(VIEWER_STATE_STORE).clear();
    transaction.objectStore(TRACE_PAYLOAD_STORE).clear();
    await awaitTransaction(transaction);
  } finally {
    db.close();
  }
}
