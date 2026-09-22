import { parseSseDeltas, requestJson } from "@/lib/http";
import type { ChatProvider, ChatMessage, ChatRequest } from "@/lib/types";

interface PerplexityEvent {
  type?: string;
  delta?: string;
  error?: {
    message?: string;
    code?: string;
  };
}

function pickDelta(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const event = payload as PerplexityEvent;

  if (event.error) {
    throw new Error(
      event.error.message ?? "Perplexity streaming request failed",
    );
  }

  if (event.type !== "response.output_text.delta") {
    return undefined;
  }

  return event.delta ?? undefined;
}

function toWireMessage(message: ChatMessage) {
  return {
    type: "message",
    role: message.role,
    content: message.content,
  };
}

function presetForModel(model: string) {
  if (model === "sonar-deep-research") {
    return "high";
  }

  if (model === "sonar-reasoning-pro") {
    return "medium";
  }

  throw new Error(`Unsupported Perplexity model: ${model}`);
}

export const perplexityProvider: ChatProvider = {
  id: "perplexity",
  label: "Perplexity",
  execution: "cloud",

  isConfigured: () => Boolean(process.env.PERPLEXITY_API_KEY?.trim()),

  async *stream(request: ChatRequest) {
    const key = process.env.PERPLEXITY_API_KEY?.trim();

    if (!key) {
      throw new Error("PERPLEXITY_API_KEY is not configured");
    }

    const messages = request.messages.map(toWireMessage);

    if (!messages.length) {
      throw new Error("Perplexity request contains no messages");
    }

    const isDeepResearch = request.model === "sonar-deep-research";
    const preset = presetForModel(request.model);

    const body: Record<string, unknown> = {
      preset,
      input: messages,
      stream: true,
    };

    if (isDeepResearch) {
      body.max_output_tokens = 32768;
    } else {
      body.max_output_tokens = 16384;
    }

    const response = await requestJson(
      "Perplexity",
      "https://api.perplexity.ai/v1/agent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
        timeoutMs: isDeepResearch ? 120_000 : 60_000,
      },
    );

    yield* parseSseDeltas(
      response,
      pickDelta,
      "Perplexity",
    );
  },
};
