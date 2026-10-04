import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Every case here is a body that is legal JSON and illegal as a conversation,
 * which used to be the difference between a 400 and a 500: `StoredConversation`
 * is only a compile-time claim about what arrived, so a number in the `title`
 * slot passed the truthiness check and then threw `title.slice is not a
 * function` inside the normaliser.
 */
const { auth, redis } = vi.hoisted(() => ({
  auth: vi.fn(),
  redis: {
    del: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    zadd: vi.fn(),
    zrange: vi.fn(),
  },
}));

vi.mock("@clerk/nextjs/server", () => ({ auth }));

vi.mock("@upstash/redis", () => ({
  // A `function`, not an arrow: the module calls `new Redis({...})`.
  Redis: vi.fn(function () {
    return redis;
  }),
}));

import { POST } from "@/app/api/conversations/route";
import { MAX_CONVERSATION_BODY_BYTES } from "@/lib/limits";

const CONVERSATION = {
  id: "chat-1",
  title: "Refactor the auth middleware",
  projectId: "coding",
  createdAt: 100,
  updatedAt: 200,
  messages: [
    { id: "m-1", role: "user", content: "hi", createdAt: 100 },
  ],
};

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://app.test/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function chunkedRequest(chunkBytes: number, chunkCount: number) {
  const encoder = new TextEncoder();
  const chunk = "y".repeat(chunkBytes);
  let sent = 0;

  return new Request("https://app.test/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      pull(controller) {
        if (sent++ < chunkCount) controller.enqueue(encoder.encode(chunk));
        else controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
}

describe("POST /api/conversations", () => {
  beforeEach(() => {
    auth.mockResolvedValue({ userId: "user-1" });

    for (const fn of Object.values(redis)) {
      fn.mockReset();
    }

    redis.set.mockResolvedValue("OK");
    redis.zadd.mockResolvedValue(1);
    redis.zrange.mockResolvedValue([]);

    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stores a conversation the client actually sent", async () => {
    const response = await POST(request(CONVERSATION));

    expect(response.status).toBe(200);
    expect((await response.json()).conversation).toMatchObject({
      id: "chat-1",
      title: CONVERSATION.title,
    });
    expect(redis.set).toHaveBeenCalled();
  });

  it("refuses a body that is not JSON at all", async () => {
    const response = await POST(request("<html>not json</html>"));

    expect(response.status).toBe(400);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("refuses a JSON null instead of throwing on it", async () => {
    const response = await POST(request("null"));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Request body must be a JSON object",
    });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("refuses an array instead of throwing on it", async () => {
    const response = await POST(request([CONVERSATION]));

    expect(response.status).toBe(400);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("refuses a number in the title slot", async () => {
    const response = await POST(
      request({ ...CONVERSATION, title: 123 }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid conversation",
    });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("refuses a number in the id slot", async () => {
    const response = await POST(request({ ...CONVERSATION, id: 987 }));

    expect(response.status).toBe(400);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("refuses a message that is not an object", async () => {
    const response = await POST(
      request({ ...CONVERSATION, messages: [null] }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid conversation message",
    });
  });

  it("refuses a conversation id that is not a key this server can write", async () => {
    const response = await POST(
      request({ ...CONVERSATION, id: "../../etc/passwd" }),
    );

    expect(response.status).toBe(400);
    expect(redis.set).not.toHaveBeenCalled();
  });

  /*
   * The ceiling is applied to the bytes that arrive, not to the `content-length`
   * the client claims, so a streamed body cannot walk past it. The chunks here
   * only have to add up to more than MAX_BODY_BYTES, so they are sized from the
   * same constant the route reads.
   */
  it("refuses a chunked body over the ceiling", async () => {
    const chunkBytes = 256 * 1024;
    const chunkCount = Math.ceil(MAX_CONVERSATION_BODY_BYTES / chunkBytes) + 1;
    const request = chunkedRequest(chunkBytes, chunkCount);

    expect(request.headers.get("content-length")).toBeNull();

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
