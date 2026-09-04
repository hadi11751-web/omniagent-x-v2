process.env.UPSTASH_REDIS_REST_URL = "https://test-redis.example.com";
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = vi.hoisted(() => ({
  zrange: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  zadd: vi.fn(),
  del: vi.fn(),
  zrem: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  Redis: class {
    zrange = redisMock.zrange;
    get = redisMock.get;
    set = redisMock.set;
    zadd = redisMock.zadd;
    del = redisMock.del;
    zrem = redisMock.zrem;
  },
}));

import {
  getRelevantMemories,
  listMemories,
  saveMemories,
  saveMemory,
} from "@/lib/server/memory";

describe("memory store", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    redisMock.zrange.mockResolvedValue([]);
    redisMock.get.mockResolvedValue(null);
    redisMock.set.mockResolvedValue("OK");
    redisMock.zadd.mockResolvedValue(1);
    redisMock.del.mockResolvedValue(1);
    redisMock.zrem.mockResolvedValue(1);
  });

  it("normalizes and saves a memory", async () => {
    const memory = await saveMemory(
      "user-1",
      "  User   prefers   TypeScript  ",
      "conversation-1",
    );

    expect(memory).not.toBeNull();
    expect(memory?.fact).toBe("User prefers TypeScript");
    expect(memory?.sourceConversationId).toBe("conversation-1");
    expect(redisMock.set).toHaveBeenCalledTimes(1);
    expect(redisMock.zadd).toHaveBeenCalledTimes(1);
  });

  it("passes sourceConversationId through saveMemories", async () => {
    const saved = await saveMemories(
      "user-1",
      ["Prefers TypeScript", "Uses Next.js"],
      "conversation-42",
    );

    expect(saved).toHaveLength(2);
    expect(saved.every(
      (memory) =>
        memory.sourceConversationId === "conversation-42",
    )).toBe(true);
  });

  it("does not create an exact duplicate", async () => {
    const existing = {
      id: "memory-1",
      fact: "User prefers TypeScript",
      createdAt: 100,
      updatedAt: 100,
      sourceConversationId: "conversation-1",
    };

    redisMock.zrange.mockResolvedValue(["memory-1"]);
    redisMock.get.mockResolvedValue(existing);

    const result = await saveMemory(
      "user-1",
      " User prefers TypeScript ",
      "conversation-2",
    );

    expect(result?.id).toBe("memory-1");
    expect(result?.updatedAt).toBeGreaterThan(100);
    expect(result?.sourceConversationId).toBe("conversation-2");
    expect(redisMock.set).toHaveBeenCalledTimes(1);
  });

  it("retrieves only relevant memories", async () => {
    const memories = [
      {
        id: "1",
        fact: "User prefers TypeScript for projects",
        createdAt: 1,
        updatedAt: 30,
      },
      {
        id: "2",
        fact: "User likes dark themes",
        createdAt: 2,
        updatedAt: 20,
      },
      {
        id: "3",
        fact: "User works on OmniAgent",
        createdAt: 3,
        updatedAt: 10,
      },
    ];

    redisMock.zrange.mockResolvedValue(["1", "2", "3"]);

    redisMock.get
      .mockResolvedValueOnce(memories[0])
      .mockResolvedValueOnce(memories[1])
      .mockResolvedValueOnce(memories[2]);

    const result = await getRelevantMemories(
      "user-1",
      "TypeScript project",
    );

    expect(result.map((memory) => memory.id)).toContain("1");
    expect(result.map((memory) => memory.id)).not.toContain("2");
    expect(result.map((memory) => memory.id)).not.toContain("3");
  });

  it("returns no memories when nothing matches", async () => {
    const memories = [
      {
        id: "1",
        fact: "User prefers TypeScript",
        createdAt: 1,
        updatedAt: 10,
      },
    ];

    redisMock.zrange.mockResolvedValue(["1"]);
    redisMock.get.mockResolvedValue(memories[0]);

    const result = await getRelevantMemories(
      "user-1",
      "favorite breakfast food",
    );

    expect(result).toEqual([]);
  });

  it("returns no memories for an empty query", async () => {
    const result = await getRelevantMemories(
      "user-1",
      "   ",
    );

    expect(result).toEqual([]);
    expect(redisMock.zrange).toHaveBeenCalledTimes(1);
  });

  it("lists memories newest first", async () => {
    const memories = [
      {
        id: "old",
        fact: "Old fact",
        createdAt: 1,
        updatedAt: 10,
      },
      {
        id: "new",
        fact: "New fact",
        createdAt: 2,
        updatedAt: 20,
      },
    ];

    redisMock.zrange.mockResolvedValue(["old", "new"]);
    redisMock.get
      .mockResolvedValueOnce(memories[0])
      .mockResolvedValueOnce(memories[1]);

    const result = await listMemories("user-1");

    expect(result.map((memory) => memory.id)).toEqual([
      "new",
      "old",
    ]);
  });
});
