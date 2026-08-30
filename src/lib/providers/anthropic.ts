import { parseSseDeltas, requestJson } from "@/lib/http";
import type { ChatProvider, ChatRequest } from "@/lib/types";

interface AnthropicEvent {
  type?: string;
  delta?: { type?: string; text?: string };
}

export function pickDelta(payload: unknown): string | undefined {
  const event = payload as AnthropicEvent;
  // Claude's stream sends several event types (message_start, content_block_start,
  // ping, message_delta, message_stop) on the same SSE channel. Only
  // content_block_delta events with a text_delta actually carry visible text.
  if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
    return event.delta.text;
  }
  return undefined;
}

export const anthropicProvider: ChatProvider = {
  id: "anthropic",
  label: "Anthropic",
  execution: "cloud",
  isConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY),
  async *stream(request: ChatRequest) {
    const key = process.env.ANTHROPIC_API_KEY;
    // Claude takes the system prompt as its own top-level field, not as a
    // message in the array, same reason Gemini needs this split.
    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const response = await requestJson("Anthropic", "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model,
        system: system || undefined,
        messages,
        max_tokens: 4096,
        temperature: request.temperature ?? 0.7,
        stream: true,
      }),
      signal: request.signal,
    });
    yield* parseSseDeltas(response, pickDelta, "Anthropic");
  },
};

