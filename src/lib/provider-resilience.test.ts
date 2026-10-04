import { describe, expect, it } from "vitest";
import { EmptyProviderResponseError, StreamAbortedError, UpstreamError } from "@/lib/http";
import { isRetryableError, streamWithRetry } from "@/lib/provider-resilience";
import type { ChatProvider } from "@/lib/types";

const fast = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 };
const request = { messages: [{ role: "user" as const, content: "hi" }] };

function provider(script: Array<string[] | Error>, calls = { n: 0 }): ChatProvider {
  return {
    id: "nexus",
    label: "Nexus",
    execution: "cloud",
    isConfigured: () => true,
    async *stream() {
      const step = script[Math.min(calls.n++, script.length - 1)];
      if (step instanceof Error) throw step;
      for (const chunk of step) yield chunk;
    },
  };
}

async function drain(p: ChatProvider, signal?: AbortSignal) {
  const out: string[] = [];
  for await (const c of streamWithRetry(p, { ...request, signal }, fast)) out.push(c);
  return out;
}

describe("isRetryableError", () => {
  it.each([408, 429, 500, 502, 503, 504, 529])("retries HTTP %i", (status) => {
    expect(isRetryableError(new UpstreamError("Nexus", status, "x"))).toBe(true);
  });
  it.each([400, 401, 403, 404])("does not retry HTTP %i", (status) => {
    expect(isRetryableError(new UpstreamError("Nexus", status, "x"))).toBe(false);
  });
});

describe("streamWithRetry", () => {
  it("retries a transient failure on the same provider then succeeds", async () => {
    const calls = { n: 0 };
    const out = await drain(provider([new UpstreamError("Nexus", 503, "x"), ["ok"]], calls));
    expect(out).toEqual(["ok"]);
    expect(calls.n).toBe(2);
  });

  it("does not retry a permanent error", async () => {
    const calls = { n: 0 };
    await expect(drain(provider([new UpstreamError("Nexus", 401, "x")], calls))).rejects.toThrow();
    expect(calls.n).toBe(1);
  });

  it("retries an empty response", async () => {
    const calls = { n: 0 };
    const out = await drain(provider([[], ["now"]], calls));
    expect(out).toEqual(["now"]);
    expect(calls.n).toBe(2);
  });

  it("stops after maxAttempts and throws the last error", async () => {
    const calls = { n: 0 };
    await expect(drain(provider([new UpstreamError("Nexus", 503, "x")], calls))).rejects.toThrow(/503/);
    expect(calls.n).toBe(3);
  });

  it("never retries after text has reached the reader", async () => {
    const calls = { n: 0 };
    const p: ChatProvider = {
      ...provider([["x"]], calls),
      async *stream() {
        calls.n++;
        yield "partial";
        throw new UpstreamError("Nexus", 503, "mid-stream");
      },
    };
    const out: string[] = [];
    await expect(
      (async () => {
        for await (const c of streamWithRetry(p, request, fast)) out.push(c);
      })(),
    ).rejects.toThrow(/503/);
    expect(out).toEqual(["partial"]);
    expect(calls.n).toBe(1);
  });

  it("does not retry when the caller pressed Stop", async () => {
    const calls = { n: 0 };
    const controller = new AbortController();
    controller.abort();
    await expect(
      drain(provider([new DOMException("aborted", "AbortError")], calls), controller.signal),
    ).rejects.toThrow();
    expect(calls.n).toBe(1);
  });

  it("exports the error classes the route relies on", () => {
    expect(new EmptyProviderResponseError("Nexus")).toBeInstanceOf(Error);
    expect(new StreamAbortedError("Nexus", "x")).toBeInstanceOf(Error);
  });
});
