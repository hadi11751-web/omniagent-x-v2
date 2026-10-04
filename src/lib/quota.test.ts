import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentUser, redis } = vi.hoisted(() => ({
  currentUser: vi.fn(),
  redis: {
    incr: vi.fn(),
    expire: vi.fn(),
    get: vi.fn(),
    decr: vi.fn(),
  },
}));

vi.mock("@clerk/nextjs/server", () => ({ currentUser }));

vi.mock("@upstash/redis", () => ({
  // A `function`, not an arrow: quota.ts calls `new Redis({...})`.
  Redis: vi.fn(function () {
    return redis;
  }),
}));

import {
  FREE_DAILY_LIMIT,
  FREE_DAILY_MEMORY_RUNS,
  FREE_DAILY_TRANSCRIPTIONS,
} from "@/lib/limits";
import {
  checkAndConsumeQuota,
  checkDailyCap,
  refundDailyCap,
  refundQuota,
  resetLocalQuota,
} from "@/lib/quota";

describe("checkAndConsumeQuota", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetLocalQuota();
    currentUser.mockReset();
    currentUser.mockResolvedValue(null);

    for (const fn of Object.values(redis)) {
      fn.mockReset();
    }
  });

  it("gives a paid user an unlimited allowance without counting messages", async () => {
    currentUser.mockResolvedValue({ publicMetadata: { plan: "paid" } });

    await expect(checkAndConsumeQuota("user-1")).resolves.toEqual({
      allowed: true,
      remaining: Infinity,
      limit: null,
    });

    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("expires the usage key the day after it was first written", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    redis.incr.mockResolvedValue(1);

    const result = await checkAndConsumeQuota("user-2");

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(FREE_DAILY_LIMIT - 1);
    expect(result.limit).toBe(FREE_DAILY_LIMIT);
    expect(redis.expire).toHaveBeenCalledWith(
      expect.stringMatching(/^usage:user-2:\d{4}-\d{2}-\d{2}$/),
      60 * 60 * 26,
    );
  });

  it("blocks once the daily count passes the limit", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    redis.incr.mockResolvedValue(FREE_DAILY_LIMIT + 1);

    await expect(checkAndConsumeQuota("user-3")).resolves.toEqual({
      allowed: false,
      remaining: 0,
      limit: FREE_DAILY_LIMIT,
    });

    expect(redis.expire).not.toHaveBeenCalled();
  });

  it("still enforces the ceiling when Upstash is not configured", async () => {
    for (let message = 0; message < FREE_DAILY_LIMIT; message += 1) {
      const result = await checkAndConsumeQuota("user-4");

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(FREE_DAILY_LIMIT - message - 1);
    }

    await expect(checkAndConsumeQuota("user-4")).resolves.toEqual({
      allowed: false,
      remaining: 0,
      limit: FREE_DAILY_LIMIT,
    });
  });

  it("counts each user separately without a shared counter", async () => {
    await checkAndConsumeQuota("user-5");

    await expect(checkAndConsumeQuota("user-6")).resolves.toMatchObject({
      allowed: true,
      remaining: FREE_DAILY_LIMIT - 1,
    });
  });

  it("refunds a local reservation so a failed request costs nothing", async () => {
    for (let message = 0; message < FREE_DAILY_LIMIT; message += 1) {
      await checkAndConsumeQuota("user-7");
    }

    await refundQuota("user-7");

    await expect(checkAndConsumeQuota("user-7")).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("never drops a local count below zero", async () => {
    await refundQuota("user-8");

    await expect(checkAndConsumeQuota("user-8")).resolves.toMatchObject({
      allowed: true,
      remaining: FREE_DAILY_LIMIT - 1,
    });
  });

  it("refunds through Redis when it is configured", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    redis.get.mockResolvedValue(3);

    await refundQuota("user-9");

    expect(redis.decr).toHaveBeenCalledWith(expect.stringMatching(/^usage:user-9:/));
  });

  it("leaves Redis alone when refunding a paid user", async () => {
    currentUser.mockResolvedValue({ publicMetadata: { plan: "paid" } });

    await refundQuota("user-10");

    expect(redis.get).not.toHaveBeenCalled();
  });

  /*
   * One message used to look the plan up on the consume, again on the route's
   * own ceiling and a third time on any refund - each of them an account API
   * call on the request's critical path. A caller that already knows can say so.
   */
  it("takes the plan from the caller instead of asking the account again", async () => {
    await expect(checkAndConsumeQuota("user-11", "paid")).resolves.toEqual({
      allowed: true,
      remaining: Infinity,
      limit: null,
    });

    expect(currentUser).not.toHaveBeenCalled();
  });

  it("refunds on the caller's plan without another lookup", async () => {
    await refundQuota("user-12", "free");

    expect(currentUser).not.toHaveBeenCalled();
  });

  it("counts the day from the offset the deployment names", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T22:00:00.000Z"));
    vi.stubEnv("USAGE_DAY_OFFSET_MINUTES", "300");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    redis.incr.mockResolvedValue(1);

    await checkAndConsumeQuota("user-13");

    // 22:00 UTC is 03:00 the next day five hours ahead, and the counter has to
    // belong to the day the user is living through.
    expect(redis.incr).toHaveBeenCalledWith("usage:user-13:2026-09-29");

    vi.useRealTimers();
  });

  it("ignores a day offset that is not a number", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T22:00:00.000Z"));
    vi.stubEnv("USAGE_DAY_OFFSET_MINUTES", "Karachi");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    redis.incr.mockResolvedValue(1);

    await checkAndConsumeQuota("user-14");

    expect(redis.incr).toHaveBeenCalledWith("usage:user-14:2026-09-28");

    vi.useRealTimers();
  });

  /*
   * An attempt over the ceiling is refused before the route reaches `endRun()`,
   * so nothing used to hand back the unit it had already counted: the number
   * climbed one past the limit for every rejection, and the refund of one real
   * in-flight failure cancelled a refusal instead of restoring a message.
   */
  it("does not let a refused attempt spend the allowance", async () => {
    for (let message = 0; message < FREE_DAILY_LIMIT; message += 1) {
      await checkAndConsumeQuota("user-15");
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(checkAndConsumeQuota("user-15")).resolves.toMatchObject({
        allowed: false,
      });
    }

    await refundQuota("user-15");

    await expect(checkAndConsumeQuota("user-15")).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("gives the increment back when Redis refuses the attempt", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    redis.incr.mockResolvedValue(FREE_DAILY_LIMIT + 1);
    redis.get.mockResolvedValue(FREE_DAILY_LIMIT + 1);

    await checkAndConsumeQuota("user-16");

    expect(redis.decr).toHaveBeenCalledWith(
      expect.stringMatching(/^usage:user-16:\d{4}-\d{2}-\d{2}$/),
    );
  });

  it("leaves a count that was inside the ceiling alone", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    redis.incr.mockResolvedValue(2);

    await checkAndConsumeQuota("user-17");

    expect(redis.decr).not.toHaveBeenCalled();
  });
});

describe("checkDailyCap", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetLocalQuota();
    currentUser.mockReset();
    currentUser.mockResolvedValue(null);

    for (const fn of Object.values(redis)) {
      fn.mockReset();
    }
  });

  it("never counts a paid user's runs", async () => {
    currentUser.mockResolvedValue({ publicMetadata: { plan: "paid" } });

    await expect(checkDailyCap("user-1", "memory")).resolves.toEqual({
      allowed: true,
      remaining: Infinity,
      limit: FREE_DAILY_MEMORY_RUNS,
    });

    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("takes the caller's plan for its own ceiling too", async () => {
    await expect(checkDailyCap("user-7", "memory", "paid")).resolves.toEqual({
      allowed: true,
      remaining: Infinity,
      limit: FREE_DAILY_MEMORY_RUNS,
    });

    expect(currentUser).not.toHaveBeenCalled();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it("keeps its own key per scope instead of sharing the message counter", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    redis.incr.mockResolvedValue(1);

    await checkDailyCap("user-2", "transcribe");

    expect(redis.incr).toHaveBeenCalledWith(
      expect.stringMatching(/^cap:transcribe:user-2:\d{4}-\d{2}-\d{2}$/),
    );
    expect(redis.expire).toHaveBeenCalledWith(
      expect.stringMatching(/^cap:transcribe:user-2:/),
      60 * 60 * 26,
    );
  });

  it("blocks once the scope's own ceiling is passed", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    redis.incr.mockResolvedValue(FREE_DAILY_TRANSCRIPTIONS + 1);

    await expect(checkDailyCap("user-3", "transcribe")).resolves.toEqual({
      allowed: false,
      remaining: 0,
      limit: FREE_DAILY_TRANSCRIPTIONS,
    });
  });

  it("still holds the ceiling without Redis, and separately per scope", async () => {
    for (let run = 0; run < FREE_DAILY_TRANSCRIPTIONS; run += 1) {
      await expect(checkDailyCap("user-4", "transcribe")).resolves.toMatchObject({
        allowed: true,
      });
    }

    await expect(checkDailyCap("user-4", "transcribe")).resolves.toMatchObject({
      allowed: false,
    });

    // Hitting the voice ceiling says nothing about memory saves.
    await expect(checkDailyCap("user-4", "memory")).resolves.toMatchObject({
      allowed: true,
      remaining: FREE_DAILY_MEMORY_RUNS - 1,
    });
  });

  it("refunds only the scope that failed", async () => {
    await checkDailyCap("user-5", "memory");

    await refundDailyCap("user-5", "memory");

    await expect(checkDailyCap("user-5", "memory")).resolves.toMatchObject({
      remaining: FREE_DAILY_MEMORY_RUNS - 1,
    });

    await expect(checkDailyCap("user-5", "transcribe")).resolves.toMatchObject({
      remaining: FREE_DAILY_TRANSCRIPTIONS - 1,
    });
  });

  it("never drops a refunded count below zero", async () => {
    await refundDailyCap("user-6", "memory");

    await expect(checkDailyCap("user-6", "memory")).resolves.toMatchObject({
      allowed: true,
      remaining: FREE_DAILY_MEMORY_RUNS - 1,
    });
  });

  it("gives a refused run back instead of deepening the ceiling", async () => {
    for (let run = 0; run < FREE_DAILY_TRANSCRIPTIONS; run += 1) {
      await checkDailyCap("user-8", "transcribe");
    }

    await expect(checkDailyCap("user-8", "transcribe")).resolves.toMatchObject({
      allowed: false,
    });

    // The route's own refund for a failed transcription is now the second hand
    // back, so the next attempt is judged against the ceiling, not against the
    // refusals.
    await refundDailyCap("user-8", "transcribe");

    await expect(checkDailyCap("user-8", "transcribe")).resolves.toMatchObject({
      allowed: true,
    });
  });
});

