import { parseSseDeltas, requestJson } from "@/lib/http";
import type { ChatMessage, ChatProvider, ChatRequest } from "@/lib/types";

interface AnthropicEvent {
  type?: string;
  delta?: {
    type?: string;
    text?: string;
  };
}

interface AnthropicContentBlock {
  type: "text" | "image";
  text?: string;
  source?: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export function pickDelta(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const event = payload as AnthropicEvent;

  if (
    event.type === "content_block_delta" &&
    event.delta?.type === "text_delta"
  ) {
    return event.delta.text;
  }

  return undefined;
}

function imageDataUrlToAnthropicContent(
  message: ChatMessage,
): AnthropicContentBlock[] {
  const content: AnthropicContentBlock[] = [];

  if (message.content.trim()) {
    content.push({
      type: "text",
      text: message.content,
    });
  }

  for (const image of message.images ?? []) {
    const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/i.exec(
      image,
    );

    if (!match) {
      throw new Error(
        "Anthropic vision input requires image data URLs using PNG, JPEG, WebP, or GIF.",
      );
    }

    const mediaType =
      match[1].toLowerCase() === "image/jpg"
        ? "image/jpeg"
        : match[1].toLowerCase();

    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: match[2],
      },
    });
  }

  return content;
}

function toAnthropicMessage(message: ChatMessage) {
  const hasImages = Boolean(message.images?.length);

  if (!hasImages) {
    return {
      role: message.role,
      content: message.content,
    };
  }

  return {
    role: message.role,
    content: imageDataUrlToAnthropicContent(message),
  };
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
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join("\n\n");

    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map(toAnthropicMessage);

    if (!messages.length) {
      throw new Error("Anthropic request contains no user/assistant messages");
    }

    const ADAPTIVE_THINKING_MODELS = new Set([
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5-1",
    ]);

    const isAdaptiveThinking =
      ADAPTIVE_THINKING_MODELS.has(request.model);

    const maxTokens =
      request.model === "claude-fable-5-1"
        ? 128_000
        : isAdaptiveThinking
          ? 16_384
          : 8_192;

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: maxTokens,
      messages,
      stream: true,
    };

    if (system) {
      body.system = system;
    }

    if (isAdaptiveThinking) {
      /*
       * Claude 5 uses adaptive thinking. Do not send legacy temperature,
       * top_p, or top_k parameters to these current models.
       */
      body.thinking = {
        type: "adaptive",
      };

      body.output_config = {
        effort: "high",
      };
    }

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

