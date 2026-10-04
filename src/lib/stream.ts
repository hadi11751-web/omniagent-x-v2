import { streamWithRetry } from "@/lib/provider-resilience";
import { nexusProvider } from "@/lib/nexus";
import type { ChatMessage, Source } from "@/lib/types";

export type StreamEvent =
  | { type: "meta"; model: "Nexus"; execution: "cloud" | "local"; mode: string }
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
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          /*
           * The browser can cancel the response mid-stream (Stop button, tab
           * close). Enqueueing after that throws, so stop emitting instead of
           * failing the producer, whose finally block still releases the
           * concurrency lease.
           */
          closed = true;
        }
      };
      try {
        await producer(emit);
      } catch (error) {
        emit({ type: "error", message: (error as Error).message });
      } finally {
        emit({ type: "done" });
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed or errored by the consumer */
        }
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

/**
 * Collects a full Nexus completion, with the same retry behaviour as streamed
 * chat. Used where a whole answer is needed before anything is shown: the
 * agent planner/verifier and memory extraction.
 */
export async function collectText(
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  let text = "";

  for await (const chunk of streamWithRetry(nexusProvider, { messages, signal })) {
    text += chunk;
  }

  return text.trim();
}
