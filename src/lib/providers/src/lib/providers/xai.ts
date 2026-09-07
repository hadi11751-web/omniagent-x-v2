```ts
import { parseSseDeltas, requestJson } from "@/lib/http";
import type { ChatMessage, ChatProvider, ChatRequest } from "@/lib/types";

interface XaiChunk {
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

  const chunk = payload as XaiChunk;

  if (chunk.error) {
    throw new Error(
      chunk.error.message ?? "xAI streaming request failed",
    );
  }

  return chunk.choices?.[0]?.delta?.content ?? undefined;
}

function toWireMessage(message: ChatMessage) {
  if (!message.images?.length) {
    return {
      role: message.role,
      content: message.content,
    };
  }

  return {
    role: message.role,
    content: [
      ...(message.content
        ? [
            {
              type: "text",
              text: message.content,
            },
          ]
        : []),
      ...message.images.map((imageUrl) => ({
        type: "image_url",
        image_url: {
          url: imageUrl,
        },
      })),
    ],
  };
}

export const xaiProvider: ChatProvider = {
  id: "xai",
  label: "xAI",
  execution: "cloud",

  isConfigured: () => Boolean(process.env.XAI_API_KEY),

  async *stream(request: ChatRequest) {
    const key = process.env.XAI_API_KEY;

    if (!key) {
      throw new Error("XAI_API_KEY is not configured");
    }

    const messages = request.messages.map(toWireMessage);

    if (!messages.length) {
      throw new Error("xAI request contains no messages");
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
    };

    /*
     * Grok 4.6 supports reasoning effort.
     *
     * `high` is appropriate for OmniAgent's frontier reasoning role.
     * We intentionally do not send legacy sampling parameters here.
     */
    if (request.model === "grok-4.6") {
      body.reasoning_effort = "high";
    }

    const response = await requestJson(
      "xAI",
      "https://api.x.ai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
        /*
         * Reasoning streams can take longer than the generic 60s timeout.
         */
        timeoutMs: 120_000,
      },
    );

    yield* parseSseDeltas(response, pickDelta, "xAI");
  },
};
```
