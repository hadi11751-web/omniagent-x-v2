import { parseSseDeltas, requestJson } from "@/lib/http";
import type { ChatProvider, ChatRequest } from "@/lib/types";

interface AnthropicEvent {
  type?: string;
  delta?: {
    type?: string;
    text?: string;
  };
}

export function pickDelta(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;

  const event = payload as AnthropicEvent;

  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "text_delta"
  ) {
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

    if (!key) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }

    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    // Determine max tokens based on model
    const isOpus = request.model.includes("opus");
    const maxTokens = isOpus ? 4096 : 2048;

    const body: Record<string, unknown> = {
      model: request.model,
      system: system || undefined,
      messages,
      max_tokens: maxTokens,
      stream: true,
    };

    // Do not send `temperature` to current Claude models.
    // Anthropic rejects it for models using the current generation controls.

    const response = await requestJson(
      "Anthropic",
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: request.signal,
      },
    );

    yield* parseSseDeltas(response, pickDelta, "Anthropic");
  },
};
