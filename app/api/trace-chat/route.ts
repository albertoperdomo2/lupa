import { NextRequest, NextResponse } from "next/server";
import type {
  TraceChatAttachment,
  TraceChatRequest,
  TraceChatResponse,
  TraceChatStreamEvent,
  TraceChatToolCall,
} from "@/lib/trace-chat";

export const runtime = "nodejs";

const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4";

const TRACE_CHAT_INSTRUCTIONS = `
You are Trace Agent, a trace-analysis agent embedded inside a Chrome-style flame graph viewer.

Your job:
- Explain what is happening in the current trace or flame graph.
- Compare the current trace with the previous trace when relevant.
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
- Use search_events to find candidate spans before calling focus_event or inspect_event.
- Use compare_with_previous when the user asks what changed after a new trace is loaded.
- Use inspect_current_view when you need a fresh summary of the visible window.
- In this viewer, the "spikes" are instant events and very short spans rendered in the spike strip below the main stack rows.
- When the user asks about spikes, use the spike-specific fields from inspect_current_view before answering.
- Use at most one tool call at a time.

Context rules:
- Messages that begin with APP_CONTEXT_UPDATE are authoritative app state from the latest UI render.
- Messages that begin with APP_ATTACHMENT are frozen user-selected attachments from the UI and remain valid even if the live trace later changes.
- If older app context conflicts with newer app context, trust the newest app context.
- When you refer to a specific span, include its process or thread when that helps disambiguate it.
- When comparing traces, be explicit about whether the evidence comes from the current trace, the preserved previous trace summary, or both.
`.trim();

const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "search_events",
    description:
      "Search the current trace for events by name, category, process, or thread name and return matching event ids.",
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
      },
      required: ["query", "limit"],
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
      },
      required: ["event_id"],
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
      },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "focus_event",
    description: "Select an event in the current trace and zoom the viewport around it.",
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
      },
      required: ["event_id", "padding_ratio"],
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
      },
      required: ["start_time_us", "end_time_us"],
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
      },
      required: ["include_padding"],
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
      },
      required: ["keep_view"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "compare_with_previous",
    description:
      "Return a structured comparison between the current trace and the previous preserved trace summary.",
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
] as const;

function buildContextText(body: TraceChatRequest): string {
  return [
    "APP_CONTEXT_UPDATE",
    "Use this latest app state as the source of truth for the current UI state and preserved trace history.",
    JSON.stringify(body.context, null, 2),
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
          `Image attachment "${attachment.label}" captured from the trace viewer.`,
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

function buildInput(body: TraceChatRequest) {
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
        text: buildContextText(body),
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

function buildOpenAiRequestBody(body: TraceChatRequest) {
  return {
    model: DEFAULT_OPENAI_MODEL,
    instructions: TRACE_CHAT_INSTRUCTIONS,
    input: buildInput(body),
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
  const upstreamResponse = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(buildOpenAiRequestBody({ ...body, stream: true })),
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
    body: JSON.stringify(buildOpenAiRequestBody(body)),
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
