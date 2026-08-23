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

/** Collects a full completion, used by blend/agent planning where streaming is not needed. */
export async function collectText(
  provider: ChatProvider,
  model: string,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  let text = "";
  for await (const chunk of provider.stream({ model, messages, signal })) text += chunk;
  return text.trim();
}

