```ts
import { parseSseDeltas, requestJson } from "@/lib/http";
import type { ChatProvider, ChatMessage, ChatRequest } from "@/lib/types";

interface PerplexityChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
    code?: string;
  };
}

function pickDelta(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const chunk = payload as PerplexityChunk;

  if (chunk.error) {
    throw new Error(
      chunk.error.message ?? "Perplexity streaming request failed",
    );
  }

  return chunk.choices?.[0]?.delta?.content ?? undefined;
}

function toWireMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: message.content,
  };
}

export const perplexityProvider: ChatProvider = {
  id: "perplexity",
  label: "Perplexity",
  execution: "cloud",

  isConfigured: () => Boolean(process.env.PERPLEXITY_API_KEY),

  async *stream(request: ChatRequest) {
    const key = process.env.PERPLEXITY_API_KEY;

    if (!key) {
      throw new Error("PERPLEXITY_API_KEY is not configured");
    }

    const messages = request.messages.map(toWireMessage);

    if (!messages.length) {
      throw new Error(
        "Perplexity request contains no messages",
      );
    }

    const isDeepResearch =
      request.model === "sonar-deep-research";

    const isReasoning =
      request.model === "sonar-reasoning-pro";

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
      max_tokens: isDeepResearch ? 32768 : 16384,
    };

    if (isDeepResearch || isReasoning) {
      body.reasoning_effort = "high";
    }

    const response = await requestJson(
      "Perplexity",
      "https://api.perplexity.ai/v1/sonar",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,

        /*
         * Deep Research may take substantially longer than an ordinary
         * chat-completion request.
         */
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
```
