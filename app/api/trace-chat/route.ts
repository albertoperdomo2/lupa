import { NextRequest, NextResponse } from "next/server";
import type {
  TraceChatAttachment,
  TraceChatRequest,
  TraceChatResponse,
  TraceChatStreamEvent,
  TraceChatToolCall,
} from "@/lib/trace-chat";
import { buildGitHubRepoSnapshot } from "@/lib/github-repo";

export const runtime = "nodejs";

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";

const TRACE_CHAT_INSTRUCTIONS = `
You are Trace Agent, a trace-analysis agent embedded inside a Chrome-style flame graph viewer.

Your job:
- Explain what is happening in the current run or flame graph.
- Compare the current run with the previous run when relevant.
- Use the actual viewport screenshot, any manually attached screenshots, and structured app context together.
- If the current view is too broad, use tools to focus or inspect before answering.
- Never invent trace details that are not supported by the screenshot, the context JSON, or tool outputs.

Style:
- Be precise, concise, technical, and direct.
- Start with the answer, then give the minimum supporting evidence.
- Default to short paragraphs or short bullet lists.
- Keep default answers compact unless the user explicitly asks for detail.
- Do not use filler, conversational padding, or motivational language.
- Format answers in clean markdown with a blank line between paragraphs.
- Use bullets only when they materially improve clarity.
- When you mention a span or hotspot, name it exactly.

Tool behavior:
- Prefer inspecting with tools over guessing when a question is specific.
- Use list_hotspots when the user asks broad questions about what is hot, dominant, or expensive.
- Use list_anomalies when the user asks about weird, suspicious, imbalanced, bursty, serialized, or non-obvious bottlenecks.
- Use search_events to find candidate spans before calling focus_event or inspect_event.
- inspect_event returns parent-chain, child, self-time, and call-path context for one event.
- inspect_anomaly returns the exact anomaly window, linked events, and any correlated counters for one anomaly.
- Use compare_with_previous when the user asks what changed after a new trace is loaded.
- If Deep Mode is enabled, use run_deep_compare first for pairwise analysis, then inspect_compare_finding or focus_compare_region for evidence.
- Use compare_anomalies when the user asks what suspicious patterns were introduced, resolved, or became stranger between baseline and candidate.
- Use search_compare_findings if the relevant Deep Mode finding is not already in the top returned list.
- In Deep Mode, search_events, list_hotspots, list_anomalies, inspect_event, inspect_anomaly, inspect_current_view, focus_event, set_view_range, fit_to_trace, and clear_selection may target either the baseline or candidate run via trace_role.
- When a tool accepts trace_role, always provide it explicitly.
- If one or more GitHub repos are attached, you may inspect them with repo tools before answering.
- Use search_repo_paths or list_repo_directory to find candidate files, then use read_repo_file for exact code inspection.
- Use inspect_current_view when you need a fresh summary of the visible window.
- In this viewer, the "spikes" are instant events and very short spans rendered in the spike strip below the main stack rows.
- When the user asks about spikes, use the spike-specific fields from inspect_current_view before answering.
- Use at most one tool call at a time.

Context rules:
- Messages that begin with APP_CONTEXT_UPDATE are authoritative app state from the latest UI render.
- Messages that begin with APP_ATTACHMENT are frozen user-selected attachments from the UI and remain valid even if the live trace later changes.
- Messages that begin with APP_REPO_ATTACHMENT are authoritative GitHub repo snapshots currently attached to the conversation.
- If older app context conflicts with newer app context, trust the newest app context.
- If Deep Mode is enabled, the deepCompare report is the authoritative deterministic diff between baseline and candidate runs.
- A loaded run may contain multiple trace files merged into one run-level view; use source counts and source labels from app context when they matter.
- When you refer to a specific span, include its process or thread when that helps disambiguate it.
- When comparing runs, be explicit about whether the evidence comes from the current run, the preserved previous run summary, or both.
`.trim();

const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "search_events",
    description:
      "Search the current run for events by name, category, process, or thread name and return matching event ids.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search string to match against event names and labels.",
        },
        limit: {
          type: "number",
          description: "Maximum number of matches to return.",
        },
        trace_role: {
          type: "string",
          enum: ["baseline", "candidate"],
          description: "Target trace. Use candidate when Deep Mode is active and you do not need the baseline.",
        },
      },
      required: ["query", "limit", "trace_role"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_hotspots",
    description:
      "List the strongest hotspots, self-time hotspots, call paths, or hot threads from the current run or viewport.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["trace", "view"],
          description: "Whether to inspect the whole loaded run summary or only the current viewport.",
        },
        metric: {
          type: "string",
          enum: ["inclusive_time", "self_time", "call_path", "thread", "spike"],
          description: "The kind of hotspot summary to return.",
        },
        limit: {
          type: "number",
          description: "Maximum number of rows to return.",
        },
        trace_role: {
          type: "string",
          enum: ["baseline", "candidate"],
          description: "Target trace. Use candidate when Deep Mode is active and you do not need the baseline.",
        },
      },
      required: ["scope", "metric", "limit", "trace_role"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_anomalies",
    description:
      "List the strongest deterministic anomalies in the whole trace or current viewport, optionally filtered by anomaly kind.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["trace", "view"],
          description: "Whether to inspect the whole loaded run or only the current viewport window.",
        },
        kind: {
          type: "string",
          description: 'Optional anomaly kind filter such as "duration_outlier" or "serialization". Use "all" for no filter.',
        },
        limit: {
          type: "number",
          description: "Maximum number of anomalies to return.",
        },
        trace_role: {
          type: "string",
          enum: ["baseline", "candidate"],
          description: "Target trace. Use candidate when Deep Mode is active and you do not need the baseline.",
        },
      },
      required: ["scope", "kind", "limit", "trace_role"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "inspect_event",
    description:
      "Inspect one current-trace event in detail, including nearby events on the same thread.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description: "Opaque event id returned by the app context or search_events.",
        },
        trace_role: {
          type: "string",
          enum: ["baseline", "candidate"],
          description: "Target trace. Use candidate when Deep Mode is active and you do not need the baseline.",
        },
      },
      required: ["event_id", "trace_role"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "inspect_anomaly",
    description:
      "Inspect one anomaly in detail, including the anomaly window, related trace events, and nearby evidence.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        anomaly_id: {
          type: "string",
          description: "Opaque anomaly id returned by list_anomalies or present in app context.",
        },
        trace_role: {
          type: "string",
          enum: ["baseline", "candidate"],
          description: "Target trace. Use candidate when Deep Mode is active and you do not need the baseline.",
        },
      },
      required: ["anomaly_id", "trace_role"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "inspect_current_view",
    description:
      "Return a structured summary of the current visible time range without changing the UI.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of top visible hotspots to emphasize.",
        },
        trace_role: {
          type: "string",
          enum: ["baseline", "candidate"],
          description: "Target trace. Use candidate when Deep Mode is active and you do not need the baseline.",
        },
      },
      required: ["limit", "trace_role"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "focus_event",
    description: "Select an event in the current run and zoom the viewport around it.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description: "Opaque event id returned by the app context or search_events.",
        },
        padding_ratio: {
          type: "number",
          description: "Extra context to keep around the event as a fraction of its duration.",
        },
        trace_role: {
          type: "string",
          enum: ["baseline", "candidate"],
          description: "Target trace. Use candidate when Deep Mode is active and you do not need the baseline.",
        },
      },
      required: ["event_id", "padding_ratio", "trace_role"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "set_view_range",
    description: "Set the current flame graph viewport to an explicit time range in microseconds.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        start_time_us: {
          type: "number",
          description: "New viewport start time in microseconds.",
        },
        end_time_us: {
          type: "number",
          description: "New viewport end time in microseconds.",
        },
        trace_role: {
          type: "string",
          enum: ["baseline", "candidate"],
          description: "Target trace. Use candidate when Deep Mode is active and you do not need the baseline.",
        },
      },
      required: ["start_time_us", "end_time_us", "trace_role"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "fit_to_trace",
    description: "Reset the current viewport so the full trace fits in the flame graph window.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        include_padding: {
          type: "boolean",
          description: "Whether to keep a small amount of edge padding around the full trace.",
        },
        trace_role: {
          type: "string",
          enum: ["baseline", "candidate"],
          description: "Target trace. Use candidate when Deep Mode is active and you do not need the baseline.",
        },
      },
      required: ["include_padding", "trace_role"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "clear_selection",
    description: "Clear the currently selected event.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        keep_view: {
          type: "boolean",
          description: "Whether the viewport should remain unchanged.",
        },
        trace_role: {
          type: "string",
          enum: ["baseline", "candidate"],
          description: "Target trace. Use candidate when Deep Mode is active and you do not need the baseline.",
        },
      },
      required: ["keep_view", "trace_role"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "compare_with_previous",
    description:
      "Return a structured comparison between the current run and the previous preserved run summary.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of changed hotspots or processes to emphasize.",
        },
      },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_deep_compare",
    description:
      "Return the deterministic Deep Mode compare report between the loaded baseline and candidate runs.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of compare findings to emphasize.",
        },
      },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "inspect_compare_finding",
    description:
      "Inspect one finding from the deterministic Deep Mode compare report, including its evidence regions.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        finding_id: {
          type: "string",
          description: "Opaque finding id returned by run_deep_compare or present in app context.",
        },
      },
      required: ["finding_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "focus_compare_region",
    description:
      "Focus evidence regions from a Deep Mode compare finding or region id in the baseline and candidate runs.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        finding_id: {
          type: "string",
          description: "Finding id to focus, or an empty string when region_id is used instead.",
        },
        region_id: {
          type: "string",
          description: "Specific region id to focus, or an empty string when finding_id is used instead.",
        },
        trace_role: {
          type: "string",
          description: 'Trace role filter: "baseline", "candidate", or an empty string to focus both traces.',
        },
        padding_ratio: {
          type: "number",
          description: "Extra context to keep around the focused evidence region.",
        },
      },
      required: ["finding_id", "region_id", "trace_role", "padding_ratio"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "compare_spikes",
    description:
      "Return the top Deep Mode findings about spike density, short events, and host gaps.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of spike findings to emphasize.",
        },
      },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "compare_hotspots",
    description:
      "Return the top Deep Mode findings about hotspots, signatures, and self-time changes.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of hotspot findings to emphasize.",
        },
      },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "compare_call_paths",
    description:
      "Return the top Deep Mode findings about changed call paths, threads, and repeated loops.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of call-path findings to emphasize.",
        },
      },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_compare_findings",
    description:
      "Search the full Deep Mode findings set by title, label, or explanation text.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Case-insensitive search string for finding title, labels, or explanation.",
        },
        limit: {
          type: "number",
          description: "Maximum number of findings to return.",
        },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "compare_anomalies",
    description:
      "Compare anomaly fingerprints between the baseline and candidate runs to find suspicious patterns that appeared, disappeared, or changed severity.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: 'Optional anomaly kind filter such as "serialization" or "gap_cluster". Use "all" for no filter.',
        },
        limit: {
          type: "number",
          description: "Maximum number of anomaly comparisons to return.",
        },
      },
      required: ["kind", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "search_repo_paths",
    description:
      "Search attached GitHub repo file paths by substring so you can find candidate files to read.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        repo_id: {
          type: "string",
          description: "Opaque attached-repo id from APP_REPO_ATTACHMENT.",
        },
        query: {
          type: "string",
          description: "Case-insensitive substring to match against repo file paths.",
        },
        limit: {
          type: "number",
          description: "Maximum number of file path matches to return.",
        },
      },
      required: ["repo_id", "query", "limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_repo_directory",
    description:
      "List the immediate children of a directory inside an attached GitHub repo.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        repo_id: {
          type: "string",
          description: "Opaque attached-repo id from APP_REPO_ATTACHMENT.",
        },
        path: {
          type: "string",
          description: 'Directory path to inspect, or an empty string for the repo root.',
        },
      },
      required: ["repo_id", "path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_repo_file",
    description:
      "Read the exact contents of a file inside an attached GitHub repo.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        repo_id: {
          type: "string",
          description: "Opaque attached-repo id from APP_REPO_ATTACHMENT.",
        },
        path: {
          type: "string",
          description: "Exact repo-relative file path to read.",
        },
      },
      required: ["repo_id", "path"],
      additionalProperties: false,
    },
  },
] as const;

function buildFullContextText(body: TraceChatRequest): string {
  return [
    "APP_CONTEXT_UPDATE",
    "Use this latest app state as the source of truth for the current UI state and preserved trace history.",
    JSON.stringify(body.context, null, 2),
    body.screenshotDataUrl
      ? "A screenshot of the current visible flame graph viewport is attached in this same message."
      : "No automatic flame graph viewport screenshot is attached in this turn.",
  ].join("\n\n");
}

function buildDeltaContextText(body: TraceChatRequest): string {
  const context = body.context;
  const currentTrace = context.currentTrace;
  const currentView = context.currentView;
  const deepCompare = context.deepCompare;

  return [
    "APP_CONTEXT_UPDATE",
    "Use this latest compact app-state update as the source of truth for the current UI state.",
    JSON.stringify(
      {
        currentTrace: currentTrace
          ? {
              id: currentTrace.id,
              label: currentTrace.label,
              sourceCount: currentTrace.sourceCount,
              sources: currentTrace.sources.slice(0, 4),
              eventCount: currentTrace.eventCount,
              bounds: currentTrace.bounds,
              countsByKind: currentTrace.countsByKind,
              topAnomalies: currentTrace.topAnomalies.slice(0, 3),
              anomalyKindSummary: currentTrace.anomalyKindSummary.slice(0, 4),
            }
          : null,
        currentView: currentView
          ? {
              startTime: currentView.startTime,
              endTime: currentView.endTime,
              duration: currentView.duration,
              visibleEventCount: currentView.visibleEventCount,
              visibleSpanCount: currentView.visibleSpanCount,
              visibleSpikeCount: currentView.visibleSpikeCount,
              selectedEvent: currentView.selectedEvent,
              visibleAnomalies: currentView.visibleAnomalies.slice(0, 3),
            }
          : null,
        comparisonToPrevious: context.comparisonToPrevious
          ? {
              available: context.comparisonToPrevious.available,
              previousLabel: context.comparisonToPrevious.previousLabel,
              currentLabel: context.comparisonToPrevious.currentLabel,
              durationDelta: context.comparisonToPrevious.durationDelta,
              eventCountDelta: context.comparisonToPrevious.eventCountDelta,
            }
          : null,
        deepCompare: deepCompare
          ? {
              enabled: deepCompare.enabled,
              normalizationMode: deepCompare.normalizationMode,
              report: deepCompare.report
                ? {
                    id: deepCompare.report.id,
                    headline: deepCompare.report.headline,
                    winner: deepCompare.report.winner,
                  }
                : null,
              baselineView: deepCompare.baselineView
                ? {
                    startTime: deepCompare.baselineView.startTime,
                    endTime: deepCompare.baselineView.endTime,
                    selectedEvent: deepCompare.baselineView.selectedEvent,
                    visibleAnomalies: deepCompare.baselineView.visibleAnomalies.slice(0, 2),
                  }
                : null,
              candidateView: deepCompare.candidateView
                ? {
                    startTime: deepCompare.candidateView.startTime,
                    endTime: deepCompare.candidateView.endTime,
                    selectedEvent: deepCompare.candidateView.selectedEvent,
                    visibleAnomalies: deepCompare.candidateView.visibleAnomalies.slice(0, 2),
                  }
                : null,
            }
          : null,
      },
      null,
      2
    ),
    body.screenshotDataUrl
      ? "A screenshot of the current visible flame graph viewport is attached in this same message."
      : "No automatic flame graph viewport screenshot is attached in this turn.",
  ].join("\n\n");
}

function buildAttachmentInputs(attachments: TraceChatAttachment[] | undefined) {
  const content: Array<Record<string, unknown>> = [];

  for (const attachment of attachments ?? []) {
    if (attachment.kind === "image") {
      content.push({
        type: "input_text",
        text: [
          "APP_ATTACHMENT",
          `Image attachment "${attachment.label}" captured from lupa.`,
          JSON.stringify(
            {
              id: attachment.id,
              source: attachment.source,
              traceId: attachment.traceId,
              traceLabel: attachment.traceLabel,
              createdAt: attachment.createdAt,
              width: attachment.width,
              height: attachment.height,
            },
            null,
            2
          ),
        ].join("\n\n"),
      });
      content.push({
        type: "input_image",
        image_url: attachment.imageDataUrl,
        detail: "high",
      });
      continue;
    }

    content.push({
      type: "input_text",
      text: [
        "APP_ATTACHMENT",
        "Frozen selected-span payload from the UI. Treat this as the exact user-selected span and details, even if the live view later changes.",
        JSON.stringify(
          {
            id: attachment.id,
            source: attachment.source,
            label: attachment.label,
            createdAt: attachment.createdAt,
            traceId: attachment.traceId,
            traceLabel: attachment.traceLabel,
            fingerprint: attachment.fingerprint,
            trace: attachment.trace,
            event: attachment.event,
            inspection: attachment.inspection,
            rawEvent: attachment.rawEvent,
          },
          null,
          2
        ),
      ].join("\n\n"),
    });
  }

  return content;
}

async function buildRepoInputs(body: TraceChatRequest) {
  const content: Array<Record<string, unknown>> = [];

  for (const mention of body.repoMentions ?? []) {
    try {
      const snapshot = await buildGitHubRepoSnapshot(mention);
      content.push({
        type: "input_text",
        text: [
          "APP_REPO_ATTACHMENT",
          "GitHub repo currently attached to the conversation. Use this summary as authoritative high-level repo context, and use repo tools for exact file inspection.",
          JSON.stringify(snapshot, null, 2),
        ].join("\n\n"),
      });
    } catch (error) {
      content.push({
        type: "input_text",
        text: [
          "APP_REPO_ATTACHMENT",
          "A GitHub repo was attached, but the app could not fetch its snapshot.",
          JSON.stringify(
            {
              id: mention.id,
              url: mention.url,
              error: error instanceof Error ? error.message : "Unknown GitHub fetch error.",
            },
            null,
            2
          ),
        ].join("\n\n"),
      });
    }
  }

  return content;
}

async function buildInput(body: TraceChatRequest) {
  const input: Array<Record<string, unknown>> = [];

  for (const toolOutput of body.toolOutputs ?? []) {
    input.push({
      type: "function_call_output",
      call_id: toolOutput.callId,
      output: JSON.stringify(toolOutput.output),
    });
  }

  input.push({
    role: "user",
    content: [
      {
        type: "input_text",
        text:
          body.contextMode === "delta"
            ? buildDeltaContextText(body)
            : buildFullContextText(body),
      },
      ...(body.screenshotDataUrl
        ? [
            {
              type: "input_image",
              image_url: body.screenshotDataUrl,
              detail: "high",
            },
          ]
        : []),
      ...buildAttachmentInputs(body.attachments),
      ...(await buildRepoInputs(body)),
    ],
  });

  if (body.userMessage?.trim()) {
    input.push({
      role: "user",
      content: [
        {
          type: "input_text",
          text: body.userMessage.trim(),
        },
      ],
    });
  }

  return input;
}

async function buildOpenAiRequestBody(body: TraceChatRequest) {
  return {
    model: DEFAULT_OPENAI_MODEL,
    instructions: TRACE_CHAT_INSTRUCTIONS,
    input: await buildInput(body),
    tools: TOOL_DEFINITIONS,
    parallel_tool_calls: false,
    store: true,
    ...(body.previousResponseId ? { previous_response_id: body.previousResponseId } : {}),
    ...(body.stream ? { stream: true } : {}),
  };
}

function extractAssistantText(responseJson: Record<string, unknown>): string {
  const directText = responseJson.output_text;
  if (typeof directText === "string" && directText.trim()) {
    return directText.trim();
  }

  const output = Array.isArray(responseJson.output) ? responseJson.output : [];
  const textParts: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if ((item as { type?: string }).type !== "message") continue;

    const content = Array.isArray((item as { content?: unknown[] }).content)
      ? (item as { content: unknown[] }).content
      : [];

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if ((part as { type?: string }).type !== "output_text") continue;
      const text = (part as { text?: string }).text;
      if (typeof text === "string" && text.trim()) {
        textParts.push(text.trim());
      }
    }
  }

  return textParts.join("\n\n").trim();
}

function parseToolCalls(responseJson: Record<string, unknown>): TraceChatToolCall[] {
  const output = Array.isArray(responseJson.output) ? responseJson.output : [];
  const toolCalls: TraceChatToolCall[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if ((item as { type?: string }).type !== "function_call") continue;

    const name =
      typeof (item as { name?: unknown }).name === "string"
        ? ((item as { name: string }).name as TraceChatToolCall["name"])
        : null;
    const callId =
      typeof (item as { call_id?: unknown }).call_id === "string"
        ? (item as { call_id: string }).call_id
        : null;
    const rawArguments =
      typeof (item as { arguments?: unknown }).arguments === "string"
        ? (item as { arguments: string }).arguments
        : "{}";

    if (!name || !callId) continue;

    let parsedArguments: Record<string, unknown> = {};
    try {
      parsedArguments = JSON.parse(rawArguments) as Record<string, unknown>;
    } catch {
      parsedArguments = {};
    }

    toolCalls.push({
      callId,
      name,
      arguments: parsedArguments,
    });
  }

  return toolCalls;
}

async function parseUpstreamErrorMessage(response: Response): Promise<string> {
  const responseText = await response.text();

  try {
    const responseJson = JSON.parse(responseText) as Record<string, unknown>;
    if (
      typeof responseJson.error === "object" &&
      responseJson.error &&
      typeof (responseJson.error as { message?: unknown }).message === "string"
    ) {
      return (responseJson.error as { message: string }).message;
    }
  } catch {
    // Fall back to raw text.
  }

  return responseText || "OpenAI request failed.";
}

function createTraceChatPayload(
  responseJson: Record<string, unknown>,
  fallback: {
    responseId: string;
    assistantText: string;
    toolCalls: TraceChatToolCall[];
    model: string;
  }
): TraceChatResponse {
  return {
    responseId:
      typeof responseJson.id === "string" ? responseJson.id : fallback.responseId,
    assistantText: extractAssistantText(responseJson) || fallback.assistantText.trim(),
    toolCalls: parseToolCalls(responseJson).length
      ? parseToolCalls(responseJson)
      : fallback.toolCalls,
    model:
      typeof responseJson.model === "string"
        ? responseJson.model
        : fallback.model,
  };
}

async function createStreamedResponse(
  body: TraceChatRequest
): Promise<Response | NextResponse<{ error: string }>> {
  const openAiRequestBody = await buildOpenAiRequestBody({ ...body, stream: true });
  const upstreamResponse = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(openAiRequestBody),
  });

  if (!upstreamResponse.ok) {
    const errorMessage = await parseUpstreamErrorMessage(upstreamResponse);
    return NextResponse.json({ error: errorMessage }, { status: upstreamResponse.status });
  }

  if (!upstreamResponse.body) {
    return NextResponse.json(
      { error: "OpenAI returned an empty streaming response." },
      { status: 502 }
    );
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstreamResponse.body!.getReader();
      let buffer = "";
      let responseId = `trace-chat-${Date.now()}`;
      let model = DEFAULT_OPENAI_MODEL;
      let assistantText = "";
      let finalResponseJson: Record<string, unknown> | null = null;
      const toolCallMap = new Map<string, TraceChatToolCall>();
      let failed = false;

      const emit = (event: TraceChatStreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      const recordToolCall = (
        name: unknown,
        callId: unknown,
        rawArguments: unknown
      ) => {
        if (typeof name !== "string" || typeof callId !== "string") return;

        let parsedArguments: Record<string, unknown> = {};
        if (typeof rawArguments === "string" && rawArguments.trim()) {
          try {
            parsedArguments = JSON.parse(rawArguments) as Record<string, unknown>;
          } catch {
            parsedArguments = {};
          }
        }

        toolCallMap.set(callId, {
          callId,
          name: name as TraceChatToolCall["name"],
          arguments: parsedArguments,
        });
      };

      const processEvent = (eventJson: Record<string, unknown>) => {
        const eventType =
          typeof eventJson.type === "string" ? eventJson.type : "";

        if (
          (eventType === "response.created" ||
            eventType === "response.in_progress") &&
          eventJson.response &&
          typeof eventJson.response === "object"
        ) {
          const response = eventJson.response as Record<string, unknown>;
          if (typeof response.id === "string") responseId = response.id;
          if (typeof response.model === "string") model = response.model;
          return;
        }

        if (eventType === "response.output_text.delta") {
          const delta =
            typeof eventJson.delta === "string" ? eventJson.delta : "";
          if (!delta) return;
          assistantText += delta;
          emit({
            type: "assistant_delta",
            delta,
          });
          return;
        }

        if (eventType === "response.function_call_arguments.done") {
          recordToolCall(eventJson.name, eventJson.call_id, eventJson.arguments);
          return;
        }

        if (eventType === "response.completed") {
          if (eventJson.response && typeof eventJson.response === "object") {
            finalResponseJson = eventJson.response as Record<string, unknown>;
            if (typeof finalResponseJson.id === "string") {
              responseId = finalResponseJson.id;
            }
            if (typeof finalResponseJson.model === "string") {
              model = finalResponseJson.model;
            }
          }
          return;
        }

        if (eventType === "response.failed" || eventType === "error") {
          failed = true;
          const errorMessage =
            typeof eventJson.error === "object" &&
            eventJson.error &&
            typeof (eventJson.error as { message?: unknown }).message === "string"
              ? (eventJson.error as { message: string }).message
              : "OpenAI streaming request failed.";
          emit({
            type: "error",
            error: errorMessage,
          });
        }
      };

      const processBuffer = (flush: boolean) => {
        while (true) {
          const eventBoundary = buffer.indexOf("\n\n");
          if (eventBoundary === -1) break;

          const rawEvent = buffer.slice(0, eventBoundary);
          buffer = buffer.slice(eventBoundary + 2);

          const data = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");

          if (!data || data === "[DONE]") {
            continue;
          }

          try {
            processEvent(JSON.parse(data) as Record<string, unknown>);
          } catch {
            // Ignore malformed SSE chunks and continue.
          }
        }

        if (!flush) return;

        const trailingData = buffer.trim();
        if (!trailingData) return;

        const data = trailingData
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");

        if (!data || data === "[DONE]") return;

        try {
          processEvent(JSON.parse(data) as Record<string, unknown>);
        } catch {
          // Ignore malformed trailing SSE data.
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
          processBuffer(false);
        }

        buffer += decoder.decode().replace(/\r/g, "");
        processBuffer(true);

        if (finalResponseJson) {
          const responseToolCalls = parseToolCalls(finalResponseJson);
          assistantText = extractAssistantText(finalResponseJson) || assistantText;
          if (responseToolCalls.length > 0) {
            toolCallMap.clear();
            for (const toolCall of responseToolCalls) {
              toolCallMap.set(toolCall.callId, toolCall);
            }
          }
        }

        if (!failed) {
          emit({
            type: "assistant_done",
            response: createTraceChatPayload(finalResponseJson ?? {}, {
              responseId,
              assistantText,
              toolCalls: [...toolCallMap.values()],
              model,
            }),
          });
        }
      } catch (error) {
        emit({
          type: "error",
          error:
            error instanceof Error
              ? error.message
              : "Trace chat streaming failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

export async function POST(request: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured." },
      { status: 500 }
    );
  }

  const body = (await request.json()) as TraceChatRequest;
  const hasUserMessage = Boolean(body.userMessage?.trim());
  const hasToolOutputs = Boolean(body.toolOutputs?.length);
  const hasAttachments = Boolean(body.attachments?.length);

  if (!hasUserMessage && !hasToolOutputs && !hasAttachments) {
    return NextResponse.json(
      { error: "A user message, attachment, or tool outputs are required." },
      { status: 400 }
    );
  }

  if (body.stream) {
    return createStreamedResponse(body);
  }

  const upstreamResponse = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(await buildOpenAiRequestBody(body)),
  });

  if (!upstreamResponse.ok) {
    const upstreamMessage = await parseUpstreamErrorMessage(upstreamResponse);
    return NextResponse.json({ error: upstreamMessage }, { status: upstreamResponse.status });
  }

  const responseJson = (await upstreamResponse.json()) as Record<string, unknown>;

  return NextResponse.json(
    createTraceChatPayload(responseJson, {
      responseId: `trace-chat-${Date.now()}`,
      assistantText: "",
      toolCalls: [],
      model: DEFAULT_OPENAI_MODEL,
    })
  );
}
