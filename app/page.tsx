import { LupaApp } from "@/components/tracing/tracing-viewer";

export default function Page() {
  return (
    <LupaApp
      chatEnabled={Boolean(process.env.OPENAI_API_KEY)}
      chatModel={process.env.OPENAI_MODEL || "gpt-5.4"}
    />
  );
}
