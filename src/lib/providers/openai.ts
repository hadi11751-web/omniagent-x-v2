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

function toInputMessage(message: ChatMessage) {
  const content: Array<Record<string, unknown>> = [
    {
      type: "input_text",
      text: message.content,
    },
  ];

  if (message.images?.length) {
    for (const url of message.images) {
      content.push({
        type: "input_image",
        image_url: url,
      });
    }
  }

  return {
    role: message.role,
    content,
  };
}

async function* parseOpenAiResponsesStream(
  response: Response,
): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed.startsWith("data:")) continue;

      const data = trimmed.slice(5).trim();

      if (!data || data === "[DONE]") continue;

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
}

export const openAiProvider = {
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
          input: request.messages.map(toInputMessage),
          stream: true,
        }),
        signal: request.signal,
      },
    );

    yield* parseOpenAiResponsesStream(response);
  },
};
