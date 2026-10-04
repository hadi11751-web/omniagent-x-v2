import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  nexusConfig,
  nexusConfigured,
  nexusModel,
  nexusProvider,
  NEXUS_NOT_CONFIGURED_MESSAGE,
} from "@/lib/nexus";
import { streamWithRetry } from "@/lib/provider-resilience";
import {
  startMockNexusUpstream,
  type MockNexusUpstream,
} from "../../test/helpers/mockNexusUpstream";

const ENV = [
  "NEXUS_MODEL",
  "NEXUS_BASE_URL",
  "NEXUS_API_KEY",
  "NEXUS_VISION",
  "NEXUS_EXECUTION",
  "NEXUS_NATIVE_TOOLS",
];

function clearNexusEnv() {
  for (const key of ENV) vi.stubEnv(key, "");
}

async function collect(iterable: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of iterable) text += chunk;
  return text;
}

describe("Nexus configuration", () => {
  beforeEach(clearNexusEnv);
  afterEach(() => vi.unstubAllEnvs());

  it("is unavailable until a model id is configured", () => {
    vi.stubEnv("NEXUS_API_KEY", "k");
    expect(nexusConfig()).toBeUndefined();
    expect(nexusConfigured()).toBe(false);
    expect(nexusModel()).toBeUndefined();
  });

  it("is unavailable on a hosted endpoint without a key", () => {
    vi.stubEnv("NEXUS_MODEL", "some-model");
    expect(nexusConfigured()).toBe(false);
  });

  it("works on a local endpoint with no key, and calls it local", () => {
    vi.stubEnv("NEXUS_MODEL", "some-model");
    vi.stubEnv("NEXUS_BASE_URL", "http://127.0.0.1:11434/v1/");

    expect(nexusConfig()).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      execution: "local",
      apiKey: undefined,
    });
  });

  it.each(["http://localhost:8000/v1", "http://[::1]:8000/v1", "http://127.9.9.9/v1"])(
    "treats %s as a local endpoint",
    (url) => {
      vi.stubEnv("NEXUS_MODEL", "m");
      vi.stubEnv("NEXUS_BASE_URL", url);
      expect(nexusConfig()?.execution).toBe("local");
    },
  );

  it("treats a hosted endpoint as cloud and defaults to the OpenAI-compatible root", () => {
    vi.stubEnv("NEXUS_MODEL", "m");
    vi.stubEnv("NEXUS_API_KEY", "k");

    expect(nexusConfig()).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      execution: "cloud",
      vision: false,
      nativeTools: false,
    });
  });

  it("defaults vision to false until the operator explicitly enables it", () => {
    vi.stubEnv("NEXUS_MODEL", "m");
    vi.stubEnv("NEXUS_API_KEY", "k");

    expect(nexusConfig()?.vision).toBe(false);

    vi.stubEnv("NEXUS_VISION", "true");
    expect(nexusConfig()?.vision).toBe(true);
  });

  it("lets the operator declare where it runs", () => {
    vi.stubEnv("NEXUS_MODEL", "m");
    vi.stubEnv("NEXUS_API_KEY", "k");
    vi.stubEnv("NEXUS_BASE_URL", "https://llm.internal.example/v1");
    vi.stubEnv("NEXUS_EXECUTION", "local");

    expect(nexusConfig()?.execution).toBe("local");
  });

  it.each(["not a url", "ftp://example.com/v1", "javascript:alert(1)"])(
    "refuses a base URL that is not http(s): %s",
    (url) => {
      vi.stubEnv("NEXUS_MODEL", "m");
      vi.stubEnv("NEXUS_API_KEY", "k");
      vi.stubEnv("NEXUS_BASE_URL", url);
      expect(nexusConfigured()).toBe(false);
    },
  );

  it("reads the vision and native-tools switches", () => {
    vi.stubEnv("NEXUS_MODEL", "m");
    vi.stubEnv("NEXUS_API_KEY", "k");
    vi.stubEnv("NEXUS_VISION", "false");
    vi.stubEnv("NEXUS_NATIVE_TOOLS", "true");

    expect(nexusConfig()).toMatchObject({ vision: false, nativeTools: true });
  });

  it("tells the rest of the app only id, label, execution and vision - never the engine", () => {
    vi.stubEnv("NEXUS_MODEL", "super-secret-engine-9000");
    vi.stubEnv("NEXUS_API_KEY", "sk-secret");
    vi.stubEnv("NEXUS_BASE_URL", "https://engine-vendor.example/v1");
    vi.stubEnv("NEXUS_VISION", "true");

    const model = nexusModel();

    expect(model).toEqual({ id: "nexus", label: "Nexus", execution: "cloud", vision: true });
    expect(JSON.stringify(model)).not.toMatch(/secret|engine-vendor|9000/);
  });
});

describe("Nexus over the wire", () => {
  let upstream: MockNexusUpstream;

  beforeAll(async () => {
    upstream = await startMockNexusUpstream();
  });

  afterAll(async () => {
    await upstream.close();
  });

  beforeEach(() => {
    upstream.reset();
    clearNexusEnv();
    vi.stubEnv("NEXUS_BASE_URL", upstream.url);
    vi.stubEnv("NEXUS_MODEL", "engine-under-test");
    vi.stubEnv("NEXUS_API_KEY", "test-key");
    vi.stubEnv("NEXUS_EXECUTION", "cloud");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("streams a real SSE answer and reassembles it in order", async () => {
    upstream.enqueue({ kind: "text", chunks: ["Hel", "lo ", "from ", "Nexus"] });

    const text = await collect(
      nexusProvider.stream({ messages: [{ role: "user", content: "hi" }] }),
    );

    expect(text).toBe("Hello from Nexus");
  });

  it("always asks the configured engine, whatever model a caller tries to name", async () => {
    await collect(
      nexusProvider.stream({
        ...({ model: "gpt-5" } as object),
        messages: [{ role: "user", content: "hi" }],
      }),
    );

    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0].body.model).toBe("engine-under-test");
    expect(upstream.calls[0].path).toBe("/v1/chat/completions");
    expect(upstream.calls[0].body.stream).toBe(true);
  });

  it("authenticates with the server-side key", async () => {
    await collect(nexusProvider.stream({ messages: [{ role: "user", content: "hi" }] }));

    expect(upstream.calls[0].headers.authorization).toBe("Bearer test-key");
  });

  it("sends no Authorization header to a keyless local endpoint", async () => {
    vi.stubEnv("NEXUS_API_KEY", "");
    vi.stubEnv("NEXUS_EXECUTION", "local");

    await collect(nexusProvider.stream({ messages: [{ role: "user", content: "hi" }] }));

    expect(upstream.calls[0].headers.authorization).toBeUndefined();
  });

  it("passes image attachments to Nexus as image parts of the user turn", async () => {
    const image = "data:image/png;base64,AAAA";

    await collect(
      nexusProvider.stream({
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "what is this?", images: [image] },
        ],
      }),
    );

    const [, user] = upstream.calls[0].body.messages;

    expect(user.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: image } },
    ]);
  });

  it("gives the stream the full 120 second allowance", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");

    await collect(nexusProvider.stream({ messages: [{ role: "user", content: "hi" }] }));

    expect(timeout).toHaveBeenCalledWith(120_000);
  });

  it("refuses with a clear operator message when it is not configured", async () => {
    vi.stubEnv("NEXUS_MODEL", "");

    await expect(
      collect(nexusProvider.stream({ messages: [{ role: "user", content: "hi" }] })),
    ).rejects.toThrow(NEXUS_NOT_CONFIGURED_MESSAGE);
    expect(upstream.calls).toHaveLength(0);
  });

  describe("errors", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    it("never repeats the engine's own error text to the user", async () => {
      upstream.enqueue({
        kind: "http",
        status: 404,
        body: JSON.stringify({ error: { message: "The model `engine-under-test` does not exist" } }),
      });

      const error = await collect(
        nexusProvider.stream({ messages: [{ role: "user", content: "hi" }] }),
      ).catch((caught: Error) => caught);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/^Nexus request failed \(404\)/);
      expect((error as Error).message).not.toContain("engine-under-test");
      // ...but the operator still gets the raw detail in the server log.
      expect(console.error).toHaveBeenCalledWith(
        "nexus_upstream_error",
        404,
        expect.stringContaining("engine-under-test"),
      );
    });

    it.each([
      [401, /credentials/],
      [403, /credentials/],
      [404, /NEXUS_MODEL/],
      [429, /rate limiting/],
      [500, /internal error/],
    ])("explains HTTP %i plainly", async (status, pattern) => {
      upstream.enqueue({ kind: "http", status, body: "{}" });

      await expect(
        collect(nexusProvider.stream({ messages: [{ role: "user", content: "hi" }] })),
      ).rejects.toThrow(pattern);
    });
  });

  describe("native tool calling is opt-in", () => {
    const tools = [{ name: "calculator", description: "Calculates." }];

    it("uses the text tool protocol by default: streamed, with no tools field", async () => {
      await collect(
        nexusProvider.stream({ messages: [{ role: "user", content: "2+2" }], tools }),
      );

      expect(upstream.calls[0].body.tools).toBeUndefined();
      expect(upstream.calls[0].body.stream).toBe(true);
    });

    it("sends function definitions and turns a native call into the TOOL line when enabled", async () => {
      vi.stubEnv("NEXUS_NATIVE_TOOLS", "true");
      upstream.enqueue({ kind: "tool_call", name: "calculator", argument: "2 + 2" });

      const text = await collect(
        nexusProvider.stream({ messages: [{ role: "user", content: "2+2" }], tools }),
      );

      expect(upstream.calls[0].body.stream).toBe(false);
      expect(upstream.calls[0].body.tools).toHaveLength(1);
      expect(JSON.parse(text)).toEqual({
        name: "calculator",
        arguments: { argument: "2 + 2" },
      });
    });
  });

  describe("retry on the one backend", () => {
    beforeEach(() => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    const fast = { baseDelayMs: 1, maxDelayMs: 2 };

    it("retries a transient 503 against the same backend and then succeeds", async () => {
      upstream.enqueue(
        { kind: "http", status: 503, body: "{}" },
        { kind: "http", status: 429, body: "{}" },
        { kind: "text", chunks: ["recovered"] },
      );

      const text = await collect(
        streamWithRetry(nexusProvider, { messages: [{ role: "user", content: "hi" }] }, fast),
      );

      expect(text).toBe("recovered");
      expect(upstream.calls).toHaveLength(3);
      // Every attempt went to the single configured engine - there is nowhere else to go.
      expect(new Set(upstream.calls.map((call) => call.body.model))).toEqual(
        new Set(["engine-under-test"]),
      );
    });

    it("does not retry a credentials failure", async () => {
      upstream.enqueue({ kind: "http", status: 401, body: "{}" });

      await expect(
        collect(streamWithRetry(nexusProvider, { messages: [{ role: "user", content: "hi" }] }, fast)),
      ).rejects.toThrow(/credentials/);
      expect(upstream.calls).toHaveLength(1);
    });

    it("retries an empty answer rather than showing the user nothing", async () => {
      upstream.enqueue({ kind: "empty" }, { kind: "text", chunks: ["now there is an answer"] });

      const text = await collect(
        streamWithRetry(nexusProvider, { messages: [{ role: "user", content: "hi" }] }, fast),
      );

      expect(text).toBe("now there is an answer");
      expect(upstream.calls).toHaveLength(2);
    });

    it("gives up after three attempts with an honest error, never switching model", async () => {
      upstream.enqueue(
        { kind: "http", status: 503, body: "{}" },
        { kind: "http", status: 503, body: "{}" },
        { kind: "http", status: 503, body: "{}" },
        { kind: "text", chunks: ["must never be reached"] },
      );

      await expect(
        collect(streamWithRetry(nexusProvider, { messages: [{ role: "user", content: "hi" }] }, fast)),
      ).rejects.toThrow(/Nexus request failed \(503\)/);
      expect(upstream.calls).toHaveLength(3);
    });
  });
});
