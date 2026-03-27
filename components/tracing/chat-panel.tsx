"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  Camera,
  CornerDownLeft,
  Paperclip,
  Sparkles,
  User,
  X,
} from "lucide-react";
import type { TraceChatAttachment } from "@/lib/trace-chat";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

export interface ChatPanelMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  attachments?: TraceChatAttachment[];
}

interface ChatPanelProps {
  enabled: boolean;
  model: string;
  hasTrace: boolean;
  currentTraceLabel?: string;
  previousTraceLabel?: string;
  messages: ChatPanelMessage[];
  attachments: TraceChatAttachment[];
  isBusy: boolean;
  isCaptureMode: boolean;
  errorMessage: string | null;
  onRemoveAttachment: (attachmentId: string) => void;
  onSendMessage: (message: string) => Promise<void>;
  onStartAreaCapture: () => void;
}

export function ChatPanel({
  enabled,
  model,
  hasTrace,
  currentTraceLabel,
  previousTraceLabel,
  messages,
  attachments,
  isBusy,
  isCaptureMode,
  errorMessage,
  onRemoveAttachment,
  onSendMessage,
  onStartAreaCapture,
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({
      block: "end",
    });
  }, [messages, isBusy]);

  const helperText = useMemo(() => {
    if (!enabled) {
      return "Set OPENAI_API_KEY in .env to enable trace chat.";
    }

    if (!hasTrace) {
      return "Load a trace and ask what the flame graph means, or ask how to use the viewer.";
    }

    if (previousTraceLabel) {
      return `Current trace: ${currentTraceLabel ?? "loaded trace"}. Previous trace kept for comparison: ${previousTraceLabel}.`;
    }

    return `Current trace: ${currentTraceLabel ?? "loaded trace"}.`;
  }, [currentTraceLabel, enabled, hasTrace, previousTraceLabel]);

  async function handleSubmit() {
    const message = draft.trim();
    if ((!message && attachments.length === 0) || isBusy || !enabled) return;
    setDraft("");
    await onSendMessage(message);
  }

  return (
    <div className="h-full flex flex-col bg-[#fafafa]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#ccc] bg-[#f0f0f0]">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-6 h-6 rounded-sm bg-white border border-[#d9d9d9] flex items-center justify-center">
            <Sparkles className="h-3.5 w-3.5 text-[#333]" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-[#333]">Trace Agent</div>
            <div className="text-[11px] text-[#666] truncate">{helperText}</div>
          </div>
        </div>
        <Badge variant="outline" className="border-[#ccc] text-[#555] bg-white shrink-0">
          {model}
        </Badge>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-3">
          {messages.length === 0 ? (
            <EmptyPrompt enabled={enabled} hasTrace={hasTrace} />
          ) : (
            messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))
          )}

          {isBusy && (
            <div className="flex items-center gap-2 text-xs text-[#666] px-1">
              <Spinner className="h-3.5 w-3.5" />
              <span>Analyzing the trace…</span>
            </div>
          )}

          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-[#ccc] bg-[#f4f4f4] px-3 py-3 space-y-2">
        {errorMessage && (
          <div className="text-xs text-[#9c2f2f] bg-[#fff1f1] border border-[#e7bcbc] rounded-sm px-2 py-1.5">
            {errorMessage}
          </div>
        )}

        {(attachments.length > 0 || isCaptureMode) && (
          <div className="space-y-2">
            {isCaptureMode && (
              <div className="text-[11px] text-[#555] bg-[#eef3ff] border border-[#c8d7ff] rounded-sm px-2 py-1.5">
                Drag over the trace viewer to capture an attached screenshot. Press
                <span className="font-medium"> Escape</span> to cancel.
              </div>
            )}

            {attachments.length > 0 && (
              <div className="flex flex-col gap-2">
                {attachments.map((attachment) => (
                  <PendingAttachmentCard
                    key={attachment.id}
                    attachment={attachment}
                    onRemove={() => onRemoveAttachment(attachment.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
          placeholder={
            enabled
              ? "Ask why a span is hot, compare traces, or attach an area of the flame graph…"
              : "Trace chat is disabled until OPENAI_API_KEY is configured."
          }
          disabled={!enabled || isBusy}
          className="min-h-[96px] resize-none rounded-sm border-[#ccc] bg-white text-sm text-[#333] placeholder:text-[#888] focus-visible:ring-[#b9d4ff]"
        />

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!enabled || !hasTrace || isBusy || isCaptureMode}
              onClick={onStartAreaCapture}
              aria-label="Capture an area of the trace viewer"
              title="Capture an area of the trace viewer"
              className="h-7 w-7 rounded-sm text-[#666] hover:bg-[#ebebeb] hover:text-[#333]"
            >
              <Camera className="h-3.5 w-3.5" />
            </Button>
            <div className="text-[11px] text-[#666] flex items-center gap-1.5">
              <CornerDownLeft className="h-3 w-3" />
              <span>`Enter` sends. `Shift+Enter` adds a line.</span>
            </div>
          </div>

          <Button
            onClick={() => void handleSubmit()}
            disabled={!enabled || isBusy || (draft.trim().length === 0 && attachments.length === 0)}
            className="h-8 px-3 rounded-sm bg-[#4285f4] hover:bg-[#3367d6] text-white"
          >
            {isBusy ? "Working…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function EmptyPrompt({
  enabled,
  hasTrace,
}: {
  enabled: boolean;
  hasTrace: boolean;
}) {
  const suggestions = enabled
    ? hasTrace
      ? [
          "Why is the widest section in the current view expensive?",
          "Find the hottest llama or torch span and zoom to it.",
          "Compare this trace with the previous one and tell me what changed.",
        ]
      : [
          "Explain what a flame graph shows.",
          "Tell me how to inspect a slow section once I load a trace.",
          "After I load a new trace, compare it with the previous one.",
        ]
    : ["Add OPENAI_API_KEY to .env and restart the app."];

  return (
      <div className="rounded-sm border border-dashed border-[#d1d1d1] bg-white px-3 py-4">
      <div className="flex items-center gap-2 text-sm font-medium text-[#333] mb-2">
        <Sparkles className="h-4 w-4 text-[#666]" />
        <span>Trace agent workflow</span>
      </div>
      <div className="text-xs text-[#666] space-y-1">
        {suggestions.map((suggestion) => (
          <div key={suggestion}>{suggestion}</div>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatPanelMessage }) {
  const isAssistant = message.role === "assistant";
  const isTool = message.role === "tool";
  const Icon = isAssistant ? Bot : isTool ? Sparkles : User;

  return (
    <div
      className={cn(
        "flex gap-2",
        message.role === "user" ? "justify-end" : "justify-start"
      )}
    >
      {message.role !== "user" && (
        <div className="mt-0.5 w-6 h-6 rounded-sm border border-[#d5d5d5] bg-white flex items-center justify-center shrink-0">
          <Icon className="h-3.5 w-3.5 text-[#555]" />
        </div>
      )}

      <div
        className={cn(
          "max-w-[92%] rounded-sm border px-3 py-2 text-sm leading-relaxed",
          message.role === "user"
            ? "bg-[#4285f4] text-white border-[#2a5fc2]"
            : isTool
              ? "bg-[#f5f5f5] text-[#666] border-[#dddddd] text-xs"
              : "bg-white text-[#333] border-[#d9d9d9]"
        )}
      >
        {message.attachments && message.attachments.length > 0 && (
          <div className="mb-2 space-y-2">
            {message.attachments.map((attachment) => (
              <AttachmentPreview
                key={attachment.id}
                attachment={attachment}
                compact={false}
                inverted={message.role === "user"}
              />
            ))}
          </div>
        )}

        {message.content ? (
          isAssistant ? (
            <MarkdownMessage content={message.content} />
          ) : (
            <div className="space-y-1">
              {renderTextWithMentions(message.content, message.role === "user")}
            </div>
          )
        ) : null}
      </div>

      {message.role === "user" && (
        <div className="mt-0.5 w-6 h-6 rounded-sm border border-[#2a5fc2] bg-[#5b95ff] flex items-center justify-center shrink-0">
          <Icon className="h-3.5 w-3.5 text-white" />
        </div>
      )}
    </div>
  );
}

function isStructuredMarkdownLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  return (
    trimmed.startsWith("#") ||
    trimmed.startsWith(">") ||
    trimmed.startsWith("|") ||
    trimmed.startsWith("- ") ||
    trimmed.startsWith("* ") ||
    trimmed.startsWith("+ ") ||
    /^\d+\.\s/.test(trimmed) ||
    /^\s{2,}/.test(line)
  );
}

function normalizeAssistantMarkdown(content: string): string {
  const withSoftParagraphs = content
    .replace(/\r/g, "")
    .replace(
      /([.!?])\s+(?=(?:Answer:|Conclusion:|Summary:|Selected event:|Process\/thread:|Duration:|Inputs:|Why |From |In other words:|So |The short answer is|The exact answer is|If you want))/g,
      "$1\n\n"
    );
  const lines = withSoftParagraphs.split("\n");
  const normalized: string[] = [];
  let inCodeFence = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence;
      normalized.push(line);
      continue;
    }

    if (inCodeFence || trimmed.length === 0) {
      normalized.push(line);
      continue;
    }

    const previousLine = normalized[normalized.length - 1] ?? "";
    const previousTrimmed = previousLine.trim();

    if (
      previousTrimmed &&
      !isStructuredMarkdownLine(previousLine) &&
      !isStructuredMarkdownLine(line)
    ) {
      normalized.push("");
    }

    normalized.push(line);
  }

  return normalized.join("\n");
}

function renderTextWithMentions(content: string, inverted: boolean) {
  return content.split("\n").map((line, lineIndex) => {
    const parts: React.ReactNode[] = [];
    const mentionRegex = /@\[([^\]]+)\]/g;
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = mentionRegex.exec(line)) !== null) {
      const fullMatch = match[0];
      const mentionValue = match[1];

      if (match.index > cursor) {
        parts.push(line.slice(cursor, match.index));
      }

      parts.push(
        <span
          key={`${mentionValue}-${match.index}`}
          className={cn(
            "inline-flex max-w-full items-center rounded-sm border px-1.5 py-0.5 align-middle font-mono text-[11px]",
            inverted
              ? "border-white/25 bg-white/12 text-white"
              : "border-[#d8d8d8] bg-[#f6f6f6] text-[#444]"
          )}
          title={mentionValue}
        >
          {fullMatch}
        </span>
      );

      cursor = match.index + fullMatch.length;
    }

    if (cursor < line.length) {
      parts.push(line.slice(cursor));
    }

    return (
      <div key={`line-${lineIndex}`} className="whitespace-pre-wrap break-words">
        {parts}
      </div>
    );
  });
}

function MarkdownMessage({ content }: { content: string }) {
  const normalizedContent = normalizeAssistantMarkdown(content);

  return (
    <div className="trace-markdown max-w-none text-[13px] leading-6 text-[#2f2f2f]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ className, node: _node, ...props }) => (
            <p className={cn("mb-4 last:mb-0", className)} {...props} />
          ),
          ul: ({ className, node: _node, ...props }) => (
            <ul className={cn("mb-4 list-disc space-y-1 pl-5", className)} {...props} />
          ),
          ol: ({ className, node: _node, ...props }) => (
            <ol className={cn("mb-4 list-decimal space-y-1 pl-5", className)} {...props} />
          ),
          li: ({ className, node: _node, ...props }) => (
            <li className={cn("pl-1", className)} {...props} />
          ),
          h1: ({ className, node: _node, ...props }) => (
            <h1 className={cn("mb-3 mt-1 text-[15px] font-semibold text-[#222]", className)} {...props} />
          ),
          h2: ({ className, node: _node, ...props }) => (
            <h2 className={cn("mb-3 mt-1 text-[14px] font-semibold text-[#222]", className)} {...props} />
          ),
          h3: ({ className, node: _node, ...props }) => (
            <h3 className={cn("mb-2 mt-1 text-[13px] font-semibold text-[#222]", className)} {...props} />
          ),
          strong: ({ className, node: _node, ...props }) => (
            <strong className={cn("font-semibold text-[#202020]", className)} {...props} />
          ),
          blockquote: ({ className, node: _node, ...props }) => (
            <blockquote
              className={cn(
                "mb-4 border-l-2 border-[#d0d0d0] pl-3 text-[#555]",
                className
              )}
              {...props}
            />
          ),
          pre: ({ className, node: _node, ...props }) => (
            <pre
              className={cn(
                "mb-4 overflow-x-auto rounded-sm border border-[#e3e3e3] bg-[#f7f7f7] px-3 py-2 text-xs text-[#333]",
                className
              )}
              {...props}
            />
          ),
          code: ({ className, children, node: _node, ...props }) => {
            const isInline = !className;
            return (
              <code
                className={cn(
                  isInline
                    ? "rounded-sm border border-[#e6e6e6] bg-[#f5f5f5] px-1 py-0.5 font-mono text-[0.92em] text-[#2a2a2a]"
                    : className
                )}
                {...props}
              >
                {children}
              </code>
            );
          },
          a: ({ className, node: _node, ...props }) => (
            <a
              className={cn("font-medium text-[#3367d6] no-underline hover:underline", className)}
              target="_blank"
              rel="noreferrer"
              {...props}
            />
          ),
          hr: ({ className, node: _node, ...props }) => (
            <hr className={cn("my-4 border-[#e3e3e3]", className)} {...props} />
          ),
        }}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
}

function PendingAttachmentCard({
  attachment,
  onRemove,
}: {
  attachment: TraceChatAttachment;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2 rounded-sm border border-[#d7d7d7] bg-white p-2">
      <AttachmentPreview attachment={attachment} compact={true} inverted={false} />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        className="h-6 w-6 rounded-sm text-[#666] hover:bg-[#f1f1f1] hover:text-[#333]"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function AttachmentPreview({
  attachment,
  compact,
  inverted,
}: {
  attachment: TraceChatAttachment;
  compact: boolean;
  inverted: boolean;
}) {
  if (attachment.kind === "image") {
    return (
      <div className="space-y-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] font-medium">
          <Camera className={cn("h-3.5 w-3.5", inverted ? "text-white" : "text-[#666]")} />
          <span className={cn(inverted ? "text-white" : "text-[#444]")}>
            {attachment.label}
          </span>
        </div>
        <div className="overflow-hidden rounded-sm border border-black/10 bg-black/5">
          <img
            src={attachment.imageDataUrl}
            alt={attachment.label}
            className={cn(
              "block w-full object-cover",
              compact ? "max-h-24" : "max-h-40"
            )}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] font-medium">
        <Paperclip className={cn("h-3.5 w-3.5", inverted ? "text-white" : "text-[#666]")} />
        <span className={cn("truncate", inverted ? "text-white" : "text-[#444]")}>
          {attachment.label}
        </span>
      </div>
      <div
        className={cn(
          "rounded-sm border px-2 py-1.5 text-[11px]",
          inverted
            ? "border-white/25 bg-white/10 text-white"
            : "border-[#ddd] bg-[#f7f7f7] text-[#555]"
        )}
      >
        <div className="font-medium">{attachment.event.processName}</div>
        <div>{attachment.event.threadName}</div>
        <div>Trace: {attachment.trace.label}</div>
      </div>
    </div>
  );
}
