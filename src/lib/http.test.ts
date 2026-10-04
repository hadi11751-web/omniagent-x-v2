import { describe, expect, it, vi } from "vitest";
import { requestJson } from "./http";

describe("requestJson", () => {
  it("keeps the timeout attached after headers arrive", async () => {
    let seenSignal: AbortSignal | undefined;

    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start() {
            // Deliberately never close the stream.
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));

    await requestJson("test", "https://example.com", { timeoutMs: 5 });
    expect(seenSignal?.aborted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seenSignal?.aborted).toBe(true);

    vi.unstubAllGlobals();
  });

  it("propagates caller cancellation to the transport", async () => {
    let seenSignal: AbortSignal | undefined;
    const caller = new AbortController();

    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return new Response("ok", { status: 200 });
    }));

    await requestJson("test", "https://example.com", {
      signal: caller.signal,
      timeoutMs: 1000,
    });

    caller.abort();
    await Promise.resolve();
    expect(seenSignal?.aborted).toBe(true);

    vi.unstubAllGlobals();
  });
});
