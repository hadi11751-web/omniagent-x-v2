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

function toResponsesInput(messages: ChatMessage[]) {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
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
          ...(message.content
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
    });
}

function getSystemInstructions(messages: ChatMessage[]): string | undefined {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");

  return system || undefined;
}

function extractSseFrames(buffer: string): {
  frames: string[];
  remainder: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");

  return {
    frames: parts.slice(0, -1),
    remainder: parts.at(-1) ?? "",
  };
}

function parseDataFrame(frame: string): OpenAIStreamEvent | undefined {
  const lines = frame.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const raw = trimmed.slice("data:".length).trim();

    if (!raw || raw === "[DONE]") {
      return undefined;
    }

    try {
      return JSON.parse(raw) as OpenAIStreamEvent;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function getTextDelta(event: OpenAIStreamEvent): string | undefined {
  if (event.type !== "response.output_text.delta") {
    return undefined;
  }

  return typeof event.delta === "string" ? event.delta : undefined;
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

    const instructions = getSystemInstructions(request.messages);
    const input = toResponsesInput(request.messages);

    if (!input.length) {
      throw new Error("OpenAI request contains no user/assistant messages");
    }

    const body: Record<string, unknown> = {
      model: request.model,
      input,
      stream: true,

      /**
       * GPT-6 Astra supports reasoning effort. Use a strong default for
       * OmniAgent's frontier-model role without forcing an unsupported
       * legacy sampling parameter.
       */
      reasoning: {
        effort: "high",
      },
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

    const stream = response.body;

    if (!stream) {
      throw new Error("OpenAI returned an empty streaming response");
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const parsed = extractSseFrames(buffer);
        buffer = parsed.remainder;

        for (const frame of parsed.frames) {
          const event = parseDataFrame(frame);

          if (!event) {
            continue;
          }

          if (event.type === "error") {
            throw new Error(
              event.error?.message ?? "OpenAI streaming request failed",
            );
          }

          const delta = getTextDelta(event);

          if (delta) {
            yield delta;
          }
        }
      }

      buffer += decoder.decode();

      if (buffer.trim()) {
        const event = parseDataFrame(buffer);

        if (event?.type === "error") {
          throw new Error(
            event.error?.message ?? "OpenAI streaming request failed",
          );
        }

        const delta = event ? getTextDelta(event) : undefined;

        if (delta) {
          yield delta;
        }
      }
    } finally {
      reader.releaseLock();
    }
  },
};
