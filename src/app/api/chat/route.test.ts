import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({ auth }));

import { POST } from "@/app/api/chat/route";
import { MAX_CONTEXT_FIELD_CHARS } from "@/lib/limits";

function request(body: unknown) {
  return new Request("https://app.test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Everything `availableModels()` reads a provider key from. */
const PROVIDER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "HUGGINGFACE_API_KEY",
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "PERPLEXITY_API_KEY",
  "XAI_API_KEY",
  "OLLAMA_BASE_URL",
];

/**
 * These two fields are appended verbatim to the system prompt, so they are
 * billed as prompt tokens on every message. The checks run before the request
 * reaches a provider, a quota counter or a concurrency slot.
 */
describe("POST /api/chat prompt-injection caps", () => {
  beforeEach(() => {
    auth.mockReset().mockResolvedValue({ userId: "user-1" });
  });

  it("refuses a project context past the ceiling", async () => {
    const response = await POST(
      request({
        messages: [{ role: "user", content: "hello" }],
        projectContext: "p".repeat(MAX_CONTEXT_FIELD_CHARS + 1),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "project context is too large",
    });
  });

  it("refuses a saved-memory block past the ceiling", async () => {
    const response = await POST(
      request({
        messages: [{ role: "user", content: "hello" }],
        memory: "m".repeat(MAX_CONTEXT_FIELD_CHARS + 1),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "memory is too large" });
  });
});

/*
 * Every one of these bodies is valid JSON, and every one of them used to reach
 * a `.trim()`, a `.role` or a `.length` on something that had neither, which
 * answered a malformed request with a 500.
 */
describe("POST /api/chat malformed bodies", () => {
  beforeEach(() => {
    auth.mockReset().mockResolvedValue({ userId: "user-1" });

    /*
     * With no provider keys the deployment has no models, which is the last
     * answer the route gives before it would call anyone. It keeps these cases
     * about the body rather than about the machine running them.
     */
    for (const key of PROVIDER_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses a body that is valid JSON but not an object", async () => {
    for (const body of [null, [], "hello", 12]) {
      const response = await POST(request(body));

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "request body must be a JSON object",
      });
    }
  });

  it("drops a model id that is not a string instead of throwing on it", async () => {
    const response = await POST(
      request({ messages: [{ role: "user", content: "hello" }], model: 42 }),
    );

    // Nothing was pinned and no provider is configured, so the route answered
    // about the deployment instead of dying on `42.trim()`.
    expect(response.status).toBe(503);
  });

  it("drops prompt fields that are not strings instead of trimming them", async () => {
    const response = await POST(
      request({
        messages: [{ role: "user", content: "hello" }],
        projectContext: 9,
        memory: { note: "injected" },
      }),
    );

    expect(response.status).toBe(503);
  });

  it("refuses a transcript whose entries are not messages", async () => {
    const response = await POST(
      request({ messages: [null, 7, "a".repeat(MAX_CONTEXT_FIELD_CHARS + 1)] }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "messages must contain at least one entry",
    });
  });

  /*
   * `/api/chat` also checked `content-length`, which is a claim: a body sent
   * with `Transfer-Encoding: chunked` carries none, and used to be parsed in
   * full before any size rule ran.
   */
  it("refuses a chunked body over the ceiling", async () => {
    const encoder = new TextEncoder();
    const chunk = "y".repeat(1024 * 1024);
    let sent = 0;

    const streamed = new Request("https://app.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // A body that is legal JSON and far too large: the ceiling has to stop the
      // bytes, not the shape.
      body: new ReadableStream({
        pull(controller) {
          if (sent++ < 8) {
            controller.enqueue(
              encoder.encode(sent === 1 ? '{"messages":[' : chunk),
            );
          } else {
            controller.close();
          }
        },
      }),
      duplex: "half",
    } as RequestInit);

    expect(streamed.headers.get("content-length")).toBeNull();

    const response = await POST(streamed);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: "request body is too large",
    });
  });
});
