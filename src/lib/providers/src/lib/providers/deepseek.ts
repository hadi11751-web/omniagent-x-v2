```ts
import { parseSseDeltas, requestJson } from "@/lib/http";
import type { ChatProvider, ChatRequest } from "@/lib/types";

interface DeepSeekChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
    };
  }>;
}

function pickDelta(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const chunk = payload as DeepSeekChunk;

  return chunk.choices?.[0]?.delta?.content ?? undefined;
}

export const deepseekProvider: ChatProvider = {
  id: "deepseek",
  label: "DeepSeek",
  execution: "cloud",

  isConfigured: () => Boolean(process.env.DEEPSEEK_API_KEY),

  async *stream(request: ChatRequest) {
    const key = process.env.DEEPSEEK_API_KEY;

    if (!key) {
      throw new Error("DEEPSEEK_API_KEY is not configured");
    }

    const messages = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    if (!messages.length) {
      throw new Error("DeepSeek request contains no messages");
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
    };

    /*
     * DeepSeek V4 Pro supports explicit thinking mode and reasoning effort.
     * These parameters are part of the current DeepSeek Chat Completions API.
     */
    if (request.model === "deepseek-v4-pro") {
      body.thinking = {
        type: "enabled",
      };

      body.reasoning_effort = "high";
    }

    const response = await requestJson(
      "DeepSeek",
      "https://api.deepseek.com/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      },
    );

    yield* parseSseDeltas(response, pickDelta, "DeepSeek");
  },
};
```
