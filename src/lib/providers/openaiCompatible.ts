import { parseSseDeltas, requestJson } from "@/lib/http";
import type { ChatRequest, Execution, ProviderId } from "@/lib/types";

interface OpenAiChunk {
  choices?: { delta?: { content?: string | null } }[];
}

function pickDelta(payload: unknown): string | undefined {
  const chunk = payload as OpenAiChunk;
  return chunk.choices?.[0]?.delta?.content ?? undefined;
}

/**
 * Groq, OpenRouter and Ollama all speak the OpenAI chat-completions dialect,
 * so they share one streaming implementation.
 */
export function createOpenAiCompatibleProvider(config: {
  id: ProviderId;
  label: string;
  execution: Execution;
  baseUrl: () => string | undefined;
  apiKey: () => string | undefined;
  requiresKey: boolean;
  extraHeaders?: Record<string, string>;
}) {
  return {
    id: config.id,
    label: config.label,
    execution: config.execution,
    isConfigured() {
      if (!config.baseUrl()) return false;
      return config.requiresKey ? Boolean(config.apiKey()) : true;
    },
    async *stream(request: ChatRequest) {
      const key = config.apiKey();
      const response = await requestJson(config.label, `${config.baseUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...config.extraHeaders,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          stream: true,
        }),
        signal: request.signal,
      });
      yield* parseSseDeltas(response, pickDelta, config.label);
    },
  };
}
