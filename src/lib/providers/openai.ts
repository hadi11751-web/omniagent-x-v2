import type {
  ChatMessage,
  ChatRequest,
  Execution,
  ProviderId,
} from "@/lib/types";
import { requestJson, StreamAbortedError } from "@/lib/http";

interface OpenAiResponseEvent {
  type?: string;
  delta?: string;
  error?: {
    message?: string;
    code?: string;
  };
}

type OpenAiInputContent =
  | {
      type: "input_text";
      text: string;
    }
  | {
      type: "input_image";
      image_url: string;
    };

interface OpenAiInputMessage {
  role: "system" | "user" | "assistant";
  content: OpenAiInputContent[];
}

function buildInput(messages: ChatMessage[]): OpenAiInputMessage[] {
  return messages.map((message) => {
    const role =
      message.role === "system"
        ? "system"
        : message.role === "assistant"
          ? "assistant"
          : "user";

    const content: OpenAiInputContent[] = [
      {
        type: "input_text",
        text: message.content,
      },
    ];

    if (message.role === "user") {
      for (const image of message.images ?? []) {
        if (image.startsWith("data:image/")) {
          content.push({
            type: "input_image",
            image_url: image,
          });
        }
      }
    }

    return {
      role,
      content,
    };
  });
}

async function* parseOpenAiResponsesStream(
  response: Response,
): AsyncGenerator<string> {
  const body = response.body;

  if (!body) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();

        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const data = trimmed.slice(5).trim();

        if (!data || data === "[DONE]") {
          continue;
        }

        let payload: OpenAiResponseEvent;

        try {
          payload = JSON.parse(data) as OpenAiResponseEvent;
        } catch {
          continue;
        }

        if (payload.type === "error") {
          throw new StreamAbortedError(
            "OpenAI",
            payload.error?.message ?? "OpenAI stream failed",
            payload.error?.code,
          );
        }

        if (
          payload.type === "response.output_text.delta" &&
          typeof payload.delta === "string"
        ) {
          yield payload.delta;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const openaiProvider = {
  id: "openai" as ProviderId,
  label: "OpenAI",
  execution: "cloud" as Execution,

  isConfigured() {
    return Boolean(process.env.OPENAI_API_KEY?.trim());
  },

  async *stream(request: ChatRequest) {
    const key = process.env.OPENAI_API_KEY?.trim();

    if (!key) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const input = buildInput(request.messages);

    const response = await requestJson(
      "OpenAI",
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: request.model,
          input,
          stream: true,
        }),
        signal: request.signal,
      },
    );

    yield* parseOpenAiResponsesStream(response);
  },
};
