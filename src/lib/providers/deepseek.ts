import { parseSseDeltas, requestJson } from "@/lib/http";
import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
} from "@/lib/types";

interface DeepSeekChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  error?: {
    message?: string;
    code?: string;
  };
}

function toWireMessage(message: ChatMessage) {
  return {
    role: message.role,
    content: message.content,
  };
}

function pickDelta(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const chunk = payload as DeepSeekChunk;

  if (chunk.error) {
    throw new Error(
      chunk.error.message ??
        "DeepSeek streaming request failed",
    );
  }

  /*
   * DeepSeek emits reasoning_content separately.
   * OmniAgent's current ChatProvider contract exposes
   * only assistant text, so only final content is emitted.
   */
  return (
    chunk.choices?.[0]?.delta?.content ??
    undefined
  );
}

export const deepseekProvider: ChatProvider = {
  id: "deepseek",
  label: "DeepSeek",
  execution: "cloud",

  isConfigured: () =>
    Boolean(process.env.DEEPSEEK_API_KEY),

  async *stream(request: ChatRequest) {
    const key = process.env.DEEPSEEK_API_KEY;

    if (!key) {
      throw new Error(
        "DEEPSEEK_API_KEY is not configured",
      );
    }

    const messages = request.messages.map(
      toWireMessage,
    );

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
    };

    if (
      request.model === "deepseek-v4-pro"
    ) {
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
        timeoutMs: 120_000,
      },
    );

    yield* parseSseDeltas(
      response,
      pickDelta,
      "DeepSeek",
    );
  },
};
