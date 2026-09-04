import { availableModels, PROVIDERS } from "@/lib/providers";
import {
  rankFailoverCandidates,
  streamWithFailover,
  streamWithRetry,
} from "@/lib/provider-resilience";
import { classify } from "@/lib/router";
import type { ChatMessage, ChatProvider, Source } from "@/lib/types";

export type StreamEvent =
  | { type: "meta"; model: string; provider: string; execution: "cloud" | "local"; capability?: string; mode: string }
  | { type: "status"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; argument: string; ok: boolean; summary: string }
  | { type: "sources"; sources: Source[] }
  | { type: "image"; dataUrl: string }
  | { type: "file"; dataUrl: string; filename: string }
  | { type: "error"; message: string }
  | { type: "done" };

export function createEventStream(
  producer: (emit: (event: StreamEvent) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: StreamEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        await producer(emit);
      } catch (error) {
        emit({ type: "error", message: (error as Error).message });
      } finally {
        emit({ type: "done" });
        closed = true;
        controller.close();
      }
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
    },
  });
}

/** Collects a full completion with the same resilience guarantees as streamed chat. */
export async function collectText(
  provider: ChatProvider,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  let text = "";

  const allModels = availableModels();
  const primaryModel = allModels.find(
    (candidate) => candidate.id === model,
  );

  if (!primaryModel || primaryModel.provider !== provider.id) {
    for await (
      const chunk of streamWithRetry(
        provider,
        {
          model,
          messages,
          signal,
        },
      )
    ) {
      text += chunk;
    }

    return text.trim();
  }

  const requiresVision = messages.some(
    (message) => Boolean(message.images?.length),
  );

  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");

  const capability =
    primaryModel.execution === "local"
      ? "private"
      : lastUserMessage?.content?.trim()
        ? classify(lastUserMessage.content)
        : undefined;

  const primary = {
    model: primaryModel,
    provider,
  };

  const alternatives = rankFailoverCandidates(
    primary,
    allModels,
    PROVIDERS,
    capability,
    requiresVision,
    false,
  );

  for await (
    const chunk of streamWithFailover(
      primary,
      {
        model,
        messages,
        signal,
      },
      alternatives,
    )
  ) {
    text += chunk.text;
  }

  return text.trim();
}
