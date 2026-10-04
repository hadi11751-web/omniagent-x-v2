import { beforeEach, describe, expect, it, vi } from "vitest";

const { redis } = vi.hoisted(() => ({
  redis: {
    set: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("@upstash/redis", () => ({
  // A `function`, not an arrow: the module calls `new Redis({...})`.
  Redis: vi.fn(function () {
    return redis;
  }),
}));

import {
  claimEvent,
  markEventHandled,
  releaseEventClaim,
  resetHandledEvents,
} from "@/lib/server/billing-events";

const LEASE_SECONDS = 5 * 60;
const SEEN_TTL_SECONDS = 30 * 24 * 60 * 60;

describe("billing event dedupe", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetHandledEvents();

    for (const fn of Object.values(redis)) {
      fn.mockReset();
    }

    redis.set.mockResolvedValue("OK");
    redis.del.mockResolvedValue(1);
  });

  /*
   * A check-then-record pair let two copies of one delivery both see "not yet
   * handled" and both run the handler. The claim is one write, so only one of
   * them can win it.
   */
  it("lets only one of two concurrent deliveries claim an event", async () => {
    const [first, second] = await Promise.all([
      claimEvent("evt_race"),
      claimEvent("evt_race"),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("remembers a delivered event without Redis", async () => {
    await expect(claimEvent("evt_local")).resolves.toBe(true);

    await markEventHandled("evt_local");

    await expect(claimEvent("evt_local")).resolves.toBe(false);
    await expect(claimEvent("evt_other")).resolves.toBe(true);
  });

  it("gives an unfinished claim back so the retry counts as new", async () => {
    await claimEvent("evt_failed");
    await releaseEventClaim("evt_failed");

    await expect(claimEvent("evt_failed")).resolves.toBe(true);
  });

  it("keeps a bounded number of ids in the local fallback", async () => {
    for (let index = 0; index < 600; index += 1) {
      await claimEvent(`evt_${index}`);
    }

    // The oldest ids are forgotten rather than the table growing forever.
    await expect(claimEvent("evt_0")).resolves.toBe(true);
    await expect(claimEvent("evt_599")).resolves.toBe(false);
  });

  it("claims with a lease instead of a permanent mark", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");

    await expect(claimEvent("evt_1")).resolves.toBe(true);

    expect(redis.set).toHaveBeenCalledWith("stripe:seen:evt_1", "1", {
      ex: LEASE_SECONDS,
      nx: true,
    });
  });

  it("reads a refused claim as somebody else already handling it", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    redis.set.mockResolvedValue(null);

    await expect(claimEvent("evt_seen")).resolves.toBe(false);
  });

  it("lengthens the record of a claim once the event is applied", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");

    await claimEvent("evt_1");
    await markEventHandled("evt_1");

    expect(redis.set).toHaveBeenLastCalledWith("stripe:seen:evt_1", "1", {
      ex: SEEN_TTL_SECONDS,
    });
  });

  it("runs the event anyway when Redis cannot be read", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    redis.set.mockRejectedValue(new Error("connection refused"));

    await expect(claimEvent("evt_2")).resolves.toBe(true);
  });

  it("still answers for the event it could not record", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");
    redis.set.mockRejectedValue(new Error("connection refused"));

    await expect(markEventHandled("evt_3")).resolves.toBeUndefined();
    await expect(releaseEventClaim("evt_3")).resolves.toBeUndefined();
  });

  it("releases a Redis claim when the handler did not finish", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");

    await releaseEventClaim("evt_4");

    expect(redis.del).toHaveBeenCalledWith("stripe:seen:evt_4");
  });

  it("ignores an empty event id instead of sharing one key", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "token");

    await expect(claimEvent("")).resolves.toBe(true);
    await markEventHandled("");
    await releaseEventClaim("");

    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });
});
