import { parseSseDeltas, requestJson } from "@/lib/http";
import type {
  ChatMessage,
  ChatRequest,
  Execution,
  ProviderId,
} from "@/lib/types";

interface OpenAiChunk {
  choices?: { delta?: { content?: string | null } }[];
}

function pickDelta(payload: unknown): string | undefined {
  const chunk = payload as OpenAiChunk;
  return chunk.choices?.[0]?.delta?.content ?? undefined;
}

function toWireMessage(message: ChatMessage) {
  if (!message.images?.length) {
    return { role: message.role, content: message.content };
  }

  return {
    role: message.role,
    content: [
      { type: "text", text: message.content },
      ...message.images.map((url) => ({
        type: "image_url",
        image_url: { url },
      })),
    ],
  };
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

    const response = await requestJson(
      "OpenAI",
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key ?? ""}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(toWireMessage),
          stream: true,
        }),
        signal: request.signal,
      },
    );

    yield* parseSseDeltas(response, pickDelta, "OpenAI");
  },
};
