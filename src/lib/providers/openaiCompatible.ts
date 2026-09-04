import { parseSseDeltas, requestJson } from "@/lib/http";
import type {
  ChatMessage,
  ChatRequest,
  Execution,
  ProviderId,
} from "@/lib/types";

interface OpenAiChunk {
  choices?: { delta?: { content?: string | null } }[];
}

function pickDelta(payload: unknown): string | undefined {
  const chunk = payload as OpenAiChunk;
  return chunk.choices?.[0]?.delta?.content ?? undefined;
}

/**
 * Most models only accept a plain string for `content`. Vision-capable
 * requests need `content` to be an array of text/image parts instead, per
 * the OpenAI-compatible schema Groq (and others) implement.
 */
function toWireMessage(message: ChatMessage) {
  if (!message.images?.length) {
    return { role: message.role, content: message.content };
  }

  return {
    role: message.role,
    content: [
      { type: "text", text: message.content },
      ...message.images.map((url) => ({
        type: "image_url",
        image_url: { url },
      })),
    ],
  };
}

/**
 * Groq, OpenRouter, Hugging Face and Ollama all speak the OpenAI
 * chat-completions dialect, so they share one streaming implementation.
 *
 * We intentionally do not force `temperature` into every request.
 * Model/provider defaults are used unless a provider explicitly requires
 * a sampling parameter.
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

      const response = await requestJson(
        config.label,
        `${config.baseUrl()}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(key ? { authorization: `Bearer ${key}` } : {}),
            ...config.extraHeaders,
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages.map(toWireMessage),
            stream: true,
          }),
          signal: request.signal,
        },
      );

      yield* parseSseDeltas(response, pickDelta, config.label);
    },
  };
}
