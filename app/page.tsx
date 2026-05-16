export const dynamic = "force-dynamic";

import { LupaApp } from "@/components/tracing/tracing-viewer";

function detectProvider(): "gemini" | "openai" {
  const explicit = process.env.LLM_PROVIDER;
  if (explicit === "openai" || explicit === "gemini") return explicit;
  if (process.env.GEMINI_API_KEY) return "gemini";
  return "openai";
}

export default function Page() {
  const provider = detectProvider();
  const chatEnabled =
    provider === "gemini"
      ? Boolean(process.env.GEMINI_API_KEY)
      : Boolean(process.env.OPENAI_API_KEY);
  const chatModel =
    provider === "gemini"
      ? process.env.GEMINI_MODEL || "gemini-2.5-flash"
      : process.env.OPENAI_MODEL || "gpt-5.4";

  return <LupaApp chatEnabled={chatEnabled} chatModel={chatModel} chatProvider={provider} />;
}
