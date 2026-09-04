import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireConcurrency,
  CONCURRENCY_LIMIT,
  CONCURRENCY_TTL_SECONDS,
  resetLocalConcurrency,
} from "./concurrency";

describe("distributed concurrency protection", () => {
  beforeEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    resetLocalConcurrency();
  });

  it("has a bounded per-user concurrency limit", () => {
    expect(CONCURRENCY_LIMIT).toBe(3);
  });

  it("has a finite slot recovery TTL", () => {
    expect(CONCURRENCY_TTL_SECONDS).toBe(120);
  });

  it("allows requests up to the configured per-user limit", async () => {
    const leases = await Promise.all(
      Array.from(
        { length: CONCURRENCY_LIMIT },
        () => acquireConcurrency("user-1"),
      ),
    );

    expect(leases.every((lease) => lease.acquired)).toBe(true);

    for (const lease of leases) {
      await lease.release();
    }
  });

  it("rejects the next concurrent request for the same user", async () => {
    const leases = await Promise.all(
      Array.from(
        { length: CONCURRENCY_LIMIT + 1 },
        () => acquireConcurrency("user-2"),
      ),
    );

    expect(
      leases.filter((lease) => lease.acquired),
    ).toHaveLength(CONCURRENCY_LIMIT);

    expect(
      leases.filter((lease) => !lease.acquired),
    ).toHaveLength(1);

    for (const lease of leases) {
      await lease.release();
    }
  });

  it("isolates concurrency limits per user", async () => {
    const userA = await Promise.all(
      Array.from(
        { length: CONCURRENCY_LIMIT },
        () => acquireConcurrency("user-a"),
      ),
    );

    const userB = await acquireConcurrency("user-b");

    expect(userA.every((lease) => lease.acquired)).toBe(true);
    expect(userB.acquired).toBe(true);

    for (const lease of userA) {
      await lease.release();
    }

    await userB.release();
  });

  it("releases a slot so a later request can enter", async () => {
    const leases = await Promise.all(
      Array.from(
        { length: CONCURRENCY_LIMIT },
        () => acquireConcurrency("user-3"),
      ),
    );

    const blocked = await acquireConcurrency("user-3");
    expect(blocked.acquired).toBe(false);

    await leases[0].release();

    const allowedAgain = await acquireConcurrency("user-3");
    expect(allowedAgain.acquired).toBe(true);

    for (const lease of leases.slice(1)) {
      await lease.release();
    }

    await allowedAgain.release();
  });

  it("makes release idempotent", async () => {
    const lease = await acquireConcurrency("user-4");

    expect(lease.acquired).toBe(true);

    await lease.release();
    await lease.release();

    const next = await acquireConcurrency("user-4");
    expect(next.acquired).toBe(true);

    await next.release();
  });
});
