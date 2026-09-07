import { parseSseDeltas, requestJson } from "@/lib/http";
import type {
  ChatMessage,
  ChatProvider,
  ChatRequest,
} from "@/lib/types";

interface ResponsesEvent {
  type?: string;
  delta?: string;
  error?: {
    message?: string;
  };
}

function toResponsesInput(message: ChatMessage) {
  if (
    message.role === "user" &&
    message.images?.length
  ) {
    return {
      role: message.role,
      content: [
        {
          type: "input_text",
          text: message.content,
        },
        ...message.images.map((image) => ({
          type: "input_image",
          image_url: image,
          detail: "high",
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

  const event = payload as ResponsesEvent;

  if (event.type === "response.output_text.delta") {
    return event.delta ?? undefined;
  }

  if (event.type === "error") {
    throw new Error(
      event.error?.message ??
        "OpenAI streaming request failed",
    );
  }

  return undefined;
}

export const openaiProvider: ChatProvider = {
  id: "openai",
  label: "OpenAI",
  execution: "cloud",

  isConfigured: () =>
    Boolean(process.env.OPENAI_API_KEY),

  async *stream(request: ChatRequest) {
    const key = process.env.OPENAI_API_KEY;

    if (!key) {
      throw new Error(
        "OPENAI_API_KEY is not configured",
      );
    }

    const input = request.messages.map(
      toResponsesInput,
    );

    const body: Record<string, unknown> = {
      model: request.model,
      input,
      stream: true,
    };

    const response = await requestJson(
      "OpenAI",
      "https://api.openai.com/v1/responses",
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
      "OpenAI",
    );
  },
};
