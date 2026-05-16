import { GoogleGenAI, createPartFromFunctionResponse } from "@google/genai";
import type {
  Content,
  FunctionDeclaration,
  GenerateContentResponse,
  Part,
  Tool,
} from "@google/genai";
import type { ConversationHistoryTurn, TraceChatResponse, TraceChatStreamEvent, TraceChatToolCall } from "./trace-chat";

const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

function createClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured.");
  return new GoogleGenAI({ apiKey });
}

export function getGeminiModel(): string {
  return DEFAULT_GEMINI_MODEL;
}

export async function createGeminiStream(
  systemInstructions: string,
  contents: Content[],
  tools: Tool[],
): Promise<ReadableStream<Uint8Array>> {
  const ai = createClient();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: TraceChatStreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const chunks = await ai.models.generateContentStream({
          model: DEFAULT_GEMINI_MODEL,
          contents,
          config: {
            systemInstruction: systemInstructions,
            tools,
          },
        });

        let assistantText = "";
        let responseId = `gemini-${Date.now()}`;
        const collectedFunctionCalls: TraceChatToolCall[] = [];

        for await (const chunk of chunks) {
          if (chunk.responseId) responseId = chunk.responseId;

          const text = safeText(chunk);
          if (text) {
            assistantText += text;
            emit({ type: "assistant_delta", delta: text });
          }

          const fcs = chunk.functionCalls;
          if (fcs) {
            for (const fc of fcs) {
              if (fc.name) {
                collectedFunctionCalls.push({
                  callId: fc.id || `fc-${Date.now()}-${collectedFunctionCalls.length}`,
                  name: fc.name as TraceChatToolCall["name"],
                  arguments: fc.args ?? {},
                });
              }
            }
          }
        }

        const response: TraceChatResponse = {
          responseId,
          assistantText: assistantText.trim(),
          toolCalls: collectedFunctionCalls,
          model: DEFAULT_GEMINI_MODEL,
        };

        emit({ type: "assistant_done", response });
      } catch (error) {
        emit({
          type: "error",
          error: error instanceof Error ? error.message : "Gemini request failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return stream;
}

function safeText(chunk: GenerateContentResponse): string {
  try {
    return chunk.text ?? "";
  } catch {
    return "";
  }
}

export function buildGeminiContents(
  contextText: string,
  screenshotDataUrl: string | null,
  attachmentParts: Part[],
  userMessage: string | null,
  toolOutputs: Array<{ callId: string; name: string; output: unknown }>,
  previousToolCalls?: Array<{ callId: string; name: string; arguments: Record<string, unknown> }>,
  conversationHistory?: ConversationHistoryTurn[],
): Content[] {
  const contents: Content[] = [];

  const buildUserParts = (): Part[] => {
    const parts: Part[] = [];
    parts.push({ text: contextText });
    if (screenshotDataUrl) {
      const base64 = screenshotDataUrl.replace(/^data:[^;]+;base64,/, "");
      parts.push({ inlineData: { mimeType: "image/png", data: base64 } });
    }
    parts.push(...attachmentParts);
    if (userMessage) {
      parts.push({ text: userMessage });
    }
    return parts;
  };

  if (conversationHistory?.length) {
    contents.push({ role: "user", parts: buildUserParts() });

    for (const turn of conversationHistory) {
      const modelParts: Part[] = [];
      if (turn.assistantText) {
        modelParts.push({ text: turn.assistantText });
      }
      for (const tc of turn.toolCalls) {
        modelParts.push({ functionCall: { name: tc.name, args: tc.arguments } });
      }
      if (modelParts.length > 0) {
        contents.push({ role: "model", parts: modelParts });
      }

      const responseParts: Part[] = turn.toolOutputs.map((to) =>
        createPartFromFunctionResponse(to.callId, to.name, { output: to.output }),
      );
      if (responseParts.length > 0) {
        contents.push({ role: "user", parts: responseParts });
      }
    }

    return contents;
  }

  if (previousToolCalls?.length && toolOutputs.length > 0) {
    contents.push({ role: "user", parts: [{ text: "Continue." }] });
    contents.push({
      role: "model",
      parts: previousToolCalls.map((tc) => ({
        functionCall: { name: tc.name, args: tc.arguments },
      })),
    });
    const responseParts: Part[] = toolOutputs.map((to) =>
      createPartFromFunctionResponse(to.callId, to.name, { output: to.output }),
    );
    responseParts.push(...buildUserParts());
    contents.push({ role: "user", parts: responseParts });
  } else {
    const userParts = buildUserParts();
    if (userParts.length > 0) {
      contents.push({ role: "user", parts: userParts });
    }
  }

  return contents;
}

export function buildGeminiAttachmentParts(
  attachments: Array<{ kind: string; [key: string]: unknown }> | undefined,
): Part[] {
  const parts: Part[] = [];

  for (const attachment of attachments ?? []) {
    if (attachment.kind === "text") {
      const a = attachment as unknown as { filename: string; content: string };
      parts.push({
        text: `[Attached file: ${a.filename}]\n\n${a.content}`,
      });
      continue;
    }

    if (attachment.kind === "image") {
      const a = attachment as unknown as { imageDataUrl: string; label: string };
      parts.push({ text: `[Image attachment: ${a.label}]` });
      const base64 = a.imageDataUrl.replace(/^data:[^;]+;base64,/, "");
      parts.push({
        inlineData: { mimeType: "image/png", data: base64 },
      });
      continue;
    }

    if (attachment.kind === "selection") {
      parts.push({
        text: `[Selected span attachment]\n\n${JSON.stringify(attachment, null, 2)}`,
      });
    }
  }

  return parts;
}

export function convertToolsForGemini(
  openaiTools: ReadonlyArray<{
    type: string;
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>,
): Tool[] {
  return [
    {
      functionDeclarations: openaiTools.map(
        (t): FunctionDeclaration => ({
          name: t.name,
          description: t.description,
          parameters: stripSchemaFields(t.parameters) as FunctionDeclaration["parameters"],
        }),
      ),
    },
  ];
}

function stripSchemaFields(schema: unknown): unknown {
  if (schema === null || schema === undefined || typeof schema !== "object") {
    return schema;
  }

  if (Array.isArray(schema)) {
    return schema.map(stripSchemaFields);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "additionalProperties" || key === "strict") continue;
    result[key] = stripSchemaFields(value);
  }
  return result;
}
