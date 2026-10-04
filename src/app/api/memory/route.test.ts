import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  auth,
  collectText,
  nexusModel,
  listMemories,
  deleteMemory,
  clearMemories,
  saveMemories,
  acquire,
  getPlan,
  checkQuota,
  checkCap,
  refundCap,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  collectText: vi.fn(),
  nexusModel: vi.fn(),
  listMemories: vi.fn(async () => [] as unknown[]),
  deleteMemory: vi.fn(async () => true),
  clearMemories: vi.fn(async () => 0),
  saveMemories: vi.fn(),
  acquire: vi.fn(),
  getPlan: vi.fn(async () => "free" as const),
  checkQuota: vi.fn(),
  checkCap: vi.fn(),
  refundCap: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/lib/stream", () => ({ collectText }));
vi.mock("@/lib/nexus", () => ({
  nexusModel,
  NEXUS_NOT_CONFIGURED_MESSAGE: "Nexus is not configured on this server.",
}));
vi.mock("@/lib/server/memory", () => ({
  listMemories,
  saveMemories,
  deleteMemory,
  clearMemories,
}));
vi.mock("@/lib/concurrency", () => ({ acquireConcurrency: acquire }));
vi.mock("@/lib/quota", () => ({
  getPlan,
  checkAndConsumeQuota: checkQuota,
  refundQuota: vi.fn(),
  checkDailyCap: checkCap,
  refundDailyCap: refundCap,
}));

import { DELETE, GET, POST } from "@/app/api/memory/route";
import { MAX_CONTEXT_FIELD_CHARS, MAX_MEMORY_ID_CHARS } from "@/lib/limits";

function request(
  messages: unknown[],
  contentLength?: string,
  extra?: Record<string, unknown>,
) {
  const headers = new Headers({ "content-type": "application/json" });

  if (contentLength !== undefined) {
    headers.set("content-length", contentLength);
  }

  return new Request("https://app.test/api/memory", {
    method: "POST",
    headers,
    body: JSON.stringify({ conversationId: "c-1", messages, ...extra }),
  });
}

function turn(role: "user" | "assistant", content: string) {
  return { role, content };
}

const cloudNexus = { id: "nexus", label: "Nexus", execution: "cloud", vision: true };
const localNexus = { ...cloudNexus, execution: "local" };

describe("POST /api/memory", () => {
  let release: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    auth.mockReset().mockResolvedValue({ userId: "user-1" });
    collectText.mockReset();
    nexusModel.mockReset().mockReturnValue(cloudNexus);
    saveMemories.mockReset().mockResolvedValue([]);
    acquire.mockReset();
    checkQuota.mockReset();
    checkCap.mockReset().mockResolvedValue({ allowed: true, remaining: 59, limit: 60 });
    refundCap.mockReset().mockResolvedValue(undefined);

    release = vi.fn(async () => {});
    acquire.mockResolvedValue({ acquired: true, limit: 3, release });
  });

  it("refuses an anonymous caller", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await POST(request([turn("user", "I prefer TypeScript")]));

    expect(response.status).toBe(401);
    expect(collectText).not.toHaveBeenCalled();
  });

  it("refuses an oversized body before parsing it", async () => {
    const response = await POST(
      request([turn("user", "hi")], String(64 * 1024 * 1024)),
    );

    expect(response.status).toBe(413);
    expect(collectText).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  /*
   * That answer came from a header the client wrote. Streamed past it, the same
   * ceiling is applied to the bytes instead.
   */
  it("refuses a chunked body over the ceiling", async () => {
    const encoder = new TextEncoder();
    const chunk = "y".repeat(1024 * 1024);
    let sent = 0;

    const streamed = new Request("https://app.test/api/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        pull(controller) {
          if (sent++ < 12) controller.enqueue(encoder.encode(chunk));
          else controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);

    expect(streamed.headers.get("content-length")).toBeNull();

    const response = await POST(streamed);

    expect(response.status).toBe(413);
    expect(collectText).not.toHaveBeenCalled();
  });

  /*
   * `null` is a legal JSON body and so is an array of non-messages, and both
   * used to reach `message.role` and answer a malformed request with a 500.
   */
  it("refuses a body that is valid JSON but not an object", async () => {
    const response = await POST(
      new Request("https://app.test/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Request body must be a JSON object",
    });
    expect(collectText).not.toHaveBeenCalled();
  });

  it("keeps only the entries that really are messages", async () => {
    collectText.mockResolvedValue("[]");

    const response = await POST(
      request([null, 7, "a string", turn("user", "I prefer TypeScript")]),
    );

    expect(response.status).toBe(200);

    const [sent] = collectText.mock.calls[0] as [
      Array<{ role: string; content: string }>,
      unknown,
    ];

    expect(sent[1].content).toBe("USER: I prefer TypeScript");
  });

  it("drops a conversation id that is not a string", async () => {
    collectText.mockResolvedValue('["Stores facts about TypeScript"]');

    const response = await POST(
      request([turn("user", "I prefer TypeScript")], undefined, {
        conversationId: 42,
      }),
    );

    expect(response.status).toBe(200);
    expect(saveMemories).toHaveBeenCalledWith(
      "user-1",
      ["Stores facts about TypeScript"],
      undefined,
    );
  });

  it("refuses when every concurrent slot is busy", async () => {    acquire.mockResolvedValue({
      acquired: false,
      limit: 3,
      release: async () => {},
    });

    const response = await POST(request([turn("user", "hi")]));

    expect(response.status).toBe(429);
    expect(collectText).not.toHaveBeenCalled();
  });

  it("does not charge the chat allowance the turn already paid for", async () => {
    collectText.mockResolvedValue("[]");

    const response = await POST(request([turn("user", "I prefer TypeScript")]));

    expect(response.status).toBe(200);
    expect(checkQuota).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds the transcript it sends to the model and keeps the recent end", async () => {
    const huge = Array.from({ length: 200 }, (_, index) =>
      turn("user", `${index}-${"x".repeat(4000)}`),
    );
    collectText.mockResolvedValue("[]");

    await POST(request(huge));

    const [messages] = collectText.mock.calls[0] as [Array<{ role: string; content: string }>, unknown];
    const transcript = messages[1].content;

    expect(transcript.length).toBeLessThanOrEqual(MAX_CONTEXT_FIELD_CHARS);
    // Only the newest MAX_MEMORY_TRANSCRIPT_MESSAGES turns are sent at all.
    expect(transcript).toContain("USER: 199-");
    expect(transcript).not.toContain("USER: 159-");
  });

  it("drops the oldest turns once the character budget is spent", async () => {
    // 40 turns is inside the message ceiling, but far past the character one.
    const wide = Array.from({ length: 40 }, (_, index) =>
      turn("user", `${String(index).padStart(3, "0")}-${"y".repeat(9000)}`),
    );
    collectText.mockResolvedValue("[]");

    await POST(request(wide));

    const [messages] = collectText.mock.calls[0] as [Array<{ role: string; content: string }>, unknown];
    const transcript = messages[1].content;

    expect(transcript.length).toBeLessThanOrEqual(MAX_CONTEXT_FIELD_CHARS);
    expect(transcript).toContain("USER: 039-");
    expect(transcript).not.toContain("USER: 010-");
  });

  it("only hands the extractor's facts to storage", async () => {
    collectText.mockResolvedValue('```json\n["User prefers TypeScript"]\n```');

    const response = await POST(request([turn("user", "I prefer TypeScript")]));

    expect(response.status).toBe(200);
    expect(saveMemories).toHaveBeenCalledWith(
      "user-1",
      ["User prefers TypeScript"],
      "c-1",
    );
  });

  it("releases the slot when extraction blows up", async () => {
    collectText.mockRejectedValue(new Error("timeout"));

    const response = await POST(request([turn("user", "hi")]));

    expect(response.status).toBe(500);
    expect(release).toHaveBeenCalledTimes(1);
    expect(saveMemories).not.toHaveBeenCalled();
  });

  it("refunds today's ceiling for a run that produced nothing", async () => {
    collectText.mockRejectedValue(new Error("timeout"));

    await POST(request([turn("user", "hi")]));

    expect(checkCap).toHaveBeenCalledWith("user-1", "memory", "free");
    expect(refundCap).toHaveBeenCalledWith("user-1", "memory", "free");
  });

  it("stops at today's memory ceiling before reaching a model", async () => {
    checkCap.mockResolvedValue({ allowed: false, remaining: 0, limit: 60 });

    const response = await POST(request([turn("user", "hi")]));

    expect(response.status).toBe(429);
    expect(collectText).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("extracts through a local Nexus when the turn stayed local", async () => {
    nexusModel.mockReturnValue(localNexus);
    collectText.mockResolvedValue("[]");

    const response = await POST(request([turn("user", "hi")], undefined, { localOnly: true }));

    expect(response.status).toBe(200);
    expect(collectText).toHaveBeenCalledTimes(1);
  });

  it("goes unremembered rather than sending a local transcript to a cloud Nexus", async () => {
    const response = await POST(request([turn("user", "hi")], undefined, { localOnly: true }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ memories: [] });
    expect(collectText).not.toHaveBeenCalled();
    expect(checkCap).not.toHaveBeenCalled();
  });

  it("classifies the transcript itself, not just the caller's flag (cloud Nexus skips)", async () => {
    const response = await POST(
      request([turn("user", "Keep this private, my salary is confidential")], undefined, { localOnly: false }),
    );

    expect(await response.json()).toMatchObject({ memories: [] });
    expect(collectText).not.toHaveBeenCalled();
  });

  it("extracts a privately-reading transcript when Nexus itself is local", async () => {
    nexusModel.mockReturnValue(localNexus);
    collectText.mockResolvedValue("[]");

    await POST(request([turn("user", "Keep this private, my salary is confidential")], undefined, { localOnly: false }));

    expect(collectText).toHaveBeenCalledTimes(1);
  });

  it("answers 503 when Nexus is not configured, without touching quota", async () => {
    nexusModel.mockReturnValue(undefined);

    const response = await POST(request([turn("user", "hi")]));

    expect(response.status).toBe(503);
    expect(collectText).not.toHaveBeenCalled();
  });
});

/*
 * Listing and forgetting are the controls the settings panel now shows, and the
 * pricing page had long claimed them. A reader who was told they could "delete
 * any stored memory" needed a route that would do it, and one that only ever
 * reached their own rows.
 */
describe("GET and DELETE /api/memory", () => {
  beforeEach(() => {
    auth.mockReset().mockResolvedValue({ userId: "user-1" });
    listMemories.mockReset().mockResolvedValue([]);
    deleteMemory.mockReset().mockResolvedValue(true);
    clearMemories.mockReset().mockResolvedValue(2);
  });

  function url(query: string) {
    return new Request(`https://app.test/api/memory${query}`, {
      method: "DELETE",
    });
  }

  it("lists what the account has remembered", async () => {
    listMemories.mockResolvedValue([
      { id: "m-1", fact: "User ships on Fridays", createdAt: 1, updatedAt: 1 },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      memories: [{ id: "m-1", fact: "User ships on Fridays" }],
    });
  });

  it("refuses an anonymous caller on both halves", async () => {
    auth.mockResolvedValue({ userId: null });

    expect((await GET()).status).toBe(401);
    expect((await DELETE(url("?id=m-1"))).status).toBe(401);
    expect(deleteMemory).not.toHaveBeenCalled();
  });

  it("refuses a request that names nothing to forget", async () => {
    const response = await DELETE(url(""));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("name the memory"),
    });
    expect(deleteMemory).not.toHaveBeenCalled();
    expect(clearMemories).not.toHaveBeenCalled();
  });

  it("forgets the one fact named and answers with the rest", async () => {
    listMemories.mockResolvedValue([
      { id: "m-2", fact: "Uses Vitest", createdAt: 2, updatedAt: 2 },
    ]);

    const response = await DELETE(url("?id=m-1"));

    expect(deleteMemory).toHaveBeenCalledWith("user-1", "m-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deleted: 1,
      memories: [{ id: "m-2" }],
    });
  });

  it("reports an id this account does not have as nothing deleted", async () => {
    deleteMemory.mockResolvedValue(false);

    const response = await DELETE(url("?id=never-existed"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deleted: 0 });
  });

  /*
   * An id is a Redis key component here, and the ones this app writes are
   * UUIDs. A request carrying something longer is not naming a memory, and
   * saying so costs the caller nothing.
   */
  it("refuses an id too long to be one", async () => {
    const response = await DELETE(
      url(`?id=${"x".repeat(MAX_MEMORY_ID_CHARS + 1)}`),
    );

    expect(response.status).toBe(400);
    expect(deleteMemory).not.toHaveBeenCalled();
  });

  it("clears the whole list when asked for all of it", async () => {
    const response = await DELETE(url("?all=1"));

    expect(clearMemories).toHaveBeenCalledWith("user-1");
    expect(deleteMemory).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deleted: 2,
      memories: [],
    });
  });

  it("refuses an all parameter that does not mean yes", async () => {
    const response = await DELETE(url("?all=0"));

    expect(response.status).toBe(400);
    expect(clearMemories).not.toHaveBeenCalled();
  });

  it("says when storage refused rather than answering a bare failure", async () => {
    clearMemories.mockRejectedValue(new Error("redis is unreachable"));

    const response = await DELETE(url("?all=1"));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Failed to delete memory",
    });
  });
});
