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

interface OpenAiInputContentItem {
  type: "input_text" | "output_text" | "input_image";
  text?: string;
  image_url?: string;
}

interface OpenAiInputItem {
  role: "system" | "user" | "assistant";
  content: OpenAiInputContentItem[];
}

/**
 * Builds OpenAI's Responses API structured input. Previously this
 * collapsed everything into one flat string and only appended a text
 * marker like "[Attached images: 1]" for image messages — the model
 * never actually received the image. This sends real input_image items
 * per OpenAI's documented multimodal input format instead.
 */
function buildInput(messages: ChatMessage[]): OpenAiInputItem[] {
  return messages.map((message) => {
    const content: OpenAiInputContentItem[] = [];
    if (message.content.trim()) {
      content.push({
        type: message.role === "assistant" ? "output_text" : "input_text",
        text: message.content,
      });
    }
    for (const image of message.images ?? []) {
      content.push({ type: "input_image", image_url: image });
    }
    return { role: message.role, content };
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
