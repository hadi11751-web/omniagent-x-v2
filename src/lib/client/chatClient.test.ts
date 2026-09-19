import { describe, expect, it } from "vitest";
import { sendChat } from "@/lib/client/chatClient";
import type { StreamEvent } from "@/lib/stream";

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200 });
}

describe("sendChat NDJSON parsing", () => {
  it("delivers a final event even when the stream ends without a trailing newline", async () => {
    const events: StreamEvent[] = [];
    const originalFetch = globalThis.fetch;
    // The last chunk deliberately has NO trailing "\n" — this is exactly
    // the shape that used to be silently dropped.
    globalThis.fetch = (async () =>
      streamResponse([
        '{"type":"meta","model":"m","provider":"p","execution":"cloud","mode":"chat"}\n',
        '{"type":"delta","text":"hi"}',
      ])) as typeof fetch;

    try {
      await sendChat({
        messages: [],
        model: "m",
        mode: "chat",
        autoRoute: false,
        toolsEnabled: false,
        signal: new AbortController().signal,
        onEvent: (event) => events.push(event),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ type: "delta", text: "hi" });
  });

  it("still works normally when every line does have a trailing newline", async () => {
    const events: StreamEvent[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      streamResponse(['{"type":"delta","text":"a"}\n', '{"type":"delta","text":"b"}\n'])) as typeof fetch;

    try {
      await sendChat({
        messages: [],
        model: "m",
        mode: "chat",
        autoRoute: false,
        toolsEnabled: false,
        signal: new AbortController().signal,
        onEvent: (event) => events.push(event),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(events).toHaveLength(2);
  });
});
