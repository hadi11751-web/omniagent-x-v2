```ts
import { requestJson } from "@/lib/http";
import type { ChatMessage, ChatProvider, ChatRequest } from "@/lib/types";

interface OpenAIStreamEvent {
  type?: string;
  delta?: unknown;
  error?: {
    message?: string;
    code?: string;
  };
}

function getSystemInstructions(
  messages: ChatMessage[],
): string | undefined {
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");

  return instructions || undefined;
}

function toInputMessage(message: ChatMessage) {
  if (!message.images?.length) {
    return {
      role: message.role,
      content: [
        {
          type: "input_text",
          text: message.content,
        },
      ],
    };
  }

  return {
    role: message.role,
    content: [
      ...(message.content.trim()
        ? [
            {
              type: "input_text",
              text: message.content,
            },
          ]
        : []),
      ...message.images.map((imageUrl) => ({
        type: "input_image",
        image_url: imageUrl,
      })),
    ],
  };
}

function parseFrame(frame: string): OpenAIStreamEvent | undefined {
  for (const line of frame.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const data = trimmed.slice(5).trim();

    if (!data || data === "[DONE]") {
      return undefined;
    }

    try {
      return JSON.parse(data) as OpenAIStreamEvent;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function extractTextDelta(
  event: OpenAIStreamEvent,
): string | undefined {
  if (event.type !== "response.output_text.delta") {
    return undefined;
  }

  return typeof event.delta === "string"
    ? event.delta
    : undefined;
}

export const openaiProvider: ChatProvider = {
  id: "openai",
  label: "OpenAI",
  execution: "cloud",

  isConfigured: () => Boolean(process.env.OPENAI_API_KEY),

  async *stream(request: ChatRequest) {
    const key = process.env.OPENAI_API_KEY;

    if (!key) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const input = request.messages
      .filter((message) => message.role !== "system")
      .map(toInputMessage);

    if (!input.length) {
      throw new Error(
        "OpenAI request contains no user or assistant messages",
      );
    }

    const instructions = getSystemInstructions(request.messages);

    const body: Record<string, unknown> = {
      model: request.model,
      input,
      stream: true,
    };

    if (instructions) {
      body.instructions = instructions;
    }

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
      },
    );

    if (!response.body) {
      throw new Error(
        "OpenAI returned an empty streaming response",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const normalized = buffer.replace(/\r\n/g, "\n");
        const frames = normalized.split("\n\n");

        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const event = parseFrame(frame);

          if (!event) {
            continue;
          }

          if (event.type === "error") {
            throw new Error(
              event.error?.message ??
                "OpenAI streaming request failed",
            );
          }

          const text = extractTextDelta(event);

          if (text) {
            yield text;
          }
        }
      }

      buffer += decoder.decode();

      const event = parseFrame(buffer);

      if (event?.type === "error") {
        throw new Error(
          event.error?.message ??
            "OpenAI streaming request failed",
        );
      }

      const text = event
        ? extractTextDelta(event)
        : undefined;

      if (text) {
        yield text;
      }
    } finally {
      reader.releaseLock();
    }
  },
};
```
