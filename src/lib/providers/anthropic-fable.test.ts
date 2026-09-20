import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODELS } from "@/lib/models";
import { anthropicProvider } from "@/lib/providers/anthropic";

const SSE_BODY = [
  'data: {"type":"message_start","message":{"id":"msg_test"}}',
  "",
  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"FABLE_OK"}}',
  "",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

describe("Claude Fable 5.1 integration", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("exists in the catalogue with the official API ID", () => {
    const model = MODELS.find(
      (entry) => entry.id === "claude-fable-5-1",
    );

    expect(model).toBeDefined();
    expect(model?.provider).toBe("anthropic");
    expect(model?.execution).toBe("cloud");
    expect(model?.vision).toBe(true);
  });

  it("sends Fable 5.1 with adaptive thinking and the correct output budget", async () => {
    const chunks: string[] = [];

    for await (const chunk of anthropicProvider.stream({
      model: "claude-fable-5-1",
      messages: [{ role: "user", content: "hello" }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toBe("FABLE_OK");

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(body.model).toBe("claude-fable-5-1");
    expect(body.max_tokens).toBe(128_000);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.stream).toBe(true);
  });
});
