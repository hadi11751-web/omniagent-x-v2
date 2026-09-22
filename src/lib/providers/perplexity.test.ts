import { afterEach, describe, expect, it, vi } from "vitest";
import { perplexityProvider } from "@/lib/providers/perplexity";

const SSE_BODY = [
  'data: {"type":"response.output_text.delta","delta":"PERPLEXITY_OK"}',
  "",
  'data: {"type":"response.completed"}',
  "",
].join("\n");

describe("Perplexity Agent API integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PERPLEXITY_API_KEY;
  });

  it("maps sonar-reasoning-pro to the Agent API medium preset", async () => {
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(SSE_BODY, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        }),
      ),
    );

    const chunks: string[] = [];

    for await (const chunk of perplexityProvider.stream({
      model: "sonar-reasoning-pro",
      messages: [{ role: "user", content: "hello" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("PERPLEXITY_OK");

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe("https://api.perplexity.ai/v1/agent");

    const body = JSON.parse(
      String(init?.body),
    ) as Record<string, unknown>;

    expect(body.preset).toBe("medium");
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBe(16_384);
    expect(body.model).toBeUndefined();
    expect(body.messages).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();

    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: "hello",
      },
    ]);
  });

  it("maps sonar-deep-research to the Agent API high preset", async () => {
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(SSE_BODY, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
          },
        }),
      ),
    );

    const chunks: string[] = [];

    for await (const chunk of perplexityProvider.stream({
      model: "sonar-deep-research",
      messages: [{ role: "user", content: "research this" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("PERPLEXITY_OK");

    const fetchMock = vi.mocked(fetch);
    const [, init] = fetchMock.mock.calls[0];

    const body = JSON.parse(
      String(init?.body),
    ) as Record<string, unknown>;

    expect(body.preset).toBe("high");
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBe(32_768);
  });

  it("rejects unsupported Perplexity model IDs before making a request", async () => {
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(async () => {
      for await (const _chunk of perplexityProvider.stream({
        model: "sonar-unsupported",
        messages: [{ role: "user", content: "hello" }],
      })) {
        // expected to throw before yielding
      }
    }).rejects.toThrow("Unsupported Perplexity model");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
