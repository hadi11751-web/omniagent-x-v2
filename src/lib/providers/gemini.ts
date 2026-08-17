import { parseSseDeltas, requestJson } from "@/lib/http";
import type { ChatProvider, ChatRequest } from "@/lib/types";

interface GeminiChunk {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

function pickDelta(payload: unknown): string | undefined {
  const chunk = payload as GeminiChunk;
  return chunk.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") || undefined;
}

export const geminiProvider: ChatProvider = {
  id: "gemini",
  label: "Gemini",
  execution: "cloud",
  isConfigured: () => Boolean(process.env.GEMINI_API_KEY),
  async *stream(request: ChatRequest) {
    const key = process.env.GEMINI_API_KEY;
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));
    const response = await requestJson(
      "Gemini",
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        request.model,
      )}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key ?? "" },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: { temperature: request.temperature ?? 0.7 },
        }),
        signal: request.signal,
      },
    );
    yield* parseSseDeltas(response, pickDelta, "Gemini");
  },
};
