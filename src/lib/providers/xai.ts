import { parseSseDeltas, requestJson } from "@/lib/http";
import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
} from "@/lib/types";

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

function toWireMessage(message: ChatMessage) {
  if (
    message.role === "user" &&
    message.images?.length
  ) {
    return {
      role: message.role,
      content: [
        {
          type: "text",
          text: message.content,
        },
        ...message.images.map((image) => ({
          type: "image_url",
          image_url: {
            url: image,
          },
        })),
      ],
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

function pickDelta(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const chunk = payload as XaiChunk;

  if (chunk.error) {
    throw new Error(
      chunk.error.message ??
        "xAI streaming request failed",
    );
  }

  return (
    chunk.choices?.[0]?.delta?.content ??
    undefined
  );
}

export const xaiProvider: ChatProvider = {
  id: "xai",
  label: "xAI",
  execution: "cloud",

  isConfigured: () =>
    Boolean(process.env.XAI_API_KEY),

  async *stream(request: ChatRequest) {
    const key = process.env.XAI_API_KEY;

    if (!key) {
      throw new Error(
        "XAI_API_KEY is not configured",
      );
    }

    const messages = request.messages.map(
      toWireMessage,
    );

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
      reasoning_effort: "high",
    };

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
        timeoutMs: 120_000,
      },
    );

    yield* parseSseDeltas(
      response,
      pickDelta,
      "xAI",
    );
  },
};
