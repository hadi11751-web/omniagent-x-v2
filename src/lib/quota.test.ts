import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  get: vi.fn(),
  currentUser: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  Redis: class {
    eval = mocks.eval;
    get = mocks.get;
  },
}));

vi.mock("@clerk/nextjs/server", () => ({
  currentUser: mocks.currentUser,
}));

import {
  checkAndConsumeQuota,
  peekQuota,
  refundQuota,
} from "./quota";

describe("quota protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

    mocks.currentUser.mockResolvedValue({
      publicMetadata: { plan: "free" },
    });
  });

  it("allows the 20th request and creates a reservation", async () => {
    mocks.eval.mockResolvedValueOnce(20);

    const result = await checkAndConsumeQuota("user-1");

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.limit).toBe(20);
    expect(result.reservationId).toEqual(expect.any(String));

    expect(mocks.eval).toHaveBeenCalledTimes(1);

    const [script, keys, args] = mocks.eval.mock.calls[0];

    expect(script).toContain("if current >= limit then");
    expect(script).toContain("redis.call('INCR', KEYS[1])");
    expect(script).toContain("redis.call('SET', KEYS[2], KEYS[1]");
    expect(script).toContain("redis.call('EXPIRE', KEYS[1], ttl)");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(
      "usage:user-1:" + new Date().toISOString().slice(0, 10),
    );
    expect(keys[1]).toContain("quota-reservation:user-1:");
    expect(args).toEqual([20, 60 * 60 * 26]);
  });

  it("rejects the 21st request without incrementing past the limit", async () => {
    mocks.eval.mockResolvedValueOnce(0);

    const result = await checkAndConsumeQuota("user-2");

    expect(result).toEqual({
      allowed: false,
      remaining: 0,
      limit: 20,
    });

    expect(mocks.eval).toHaveBeenCalledTimes(1);
  });

  it("refunds only the exact reservation supplied", async () => {
    mocks.eval.mockResolvedValueOnce(19);

    await refundQuota("user-3", "reservation-123");

    expect(mocks.eval).toHaveBeenCalledTimes(1);

    const [script, keys, args] = mocks.eval.mock.calls[0];

    expect(script).toContain("local usageKey = redis.call('GET', KEYS[1])");
    expect(script).toContain("redis.call('DEL', KEYS[1])");
    expect(script).toContain("redis.call('DECR', usageKey)");
    expect(keys).toEqual([
      "quota-reservation:user-3:reservation-123",
      "usage:user-3:" + new Date().toISOString().slice(0, 10),
    ]);
    expect(args).toEqual([]);
  });

  it("does not attempt a refund without a reservation", async () => {
    await refundQuota("user-4");

    expect(mocks.eval).not.toHaveBeenCalled();
  });

  it("does not hit Redis for paid users", async () => {
    mocks.currentUser.mockResolvedValue({
      publicMetadata: { plan: "paid" },
    });

    await expect(
      checkAndConsumeQuota("paid-user"),
    ).resolves.toEqual({
      allowed: true,
      remaining: Infinity,
      limit: null,
    });

    expect(mocks.eval).not.toHaveBeenCalled();
  });

  it("fails open when Redis is not configured", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    await expect(
      checkAndConsumeQuota("user-5"),
    ).resolves.toEqual({
      allowed: true,
      remaining: 20,
      limit: 20,
    });

    expect(mocks.eval).not.toHaveBeenCalled();
  });

  it("peekQuota remains read-only", async () => {
    mocks.get.mockResolvedValueOnce(7);

    const result = await peekQuota("user-6");

    expect(result).toEqual({
      allowed: true,
      remaining: 13,
      limit: 20,
    });

    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.eval).not.toHaveBeenCalled();
  });
});
