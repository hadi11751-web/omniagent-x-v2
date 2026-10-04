import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireConcurrency,
  CONCURRENCY_LIMIT,
  CONCURRENCY_TTL_SECONDS,
  resetLocalConcurrency,
} from "./concurrency";
import { MAX_REQUEST_SECONDS } from "@/lib/limits";

describe("distributed concurrency protection", () => {
  beforeEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    resetLocalConcurrency();
  });

  it("has a bounded per-user concurrency limit", () => {
    expect(CONCURRENCY_LIMIT).toBe(3);
  });

  it("keeps its recovery TTL longer than the maximum request duration", () => {
    expect(CONCURRENCY_TTL_SECONDS).toBeGreaterThan(MAX_REQUEST_SECONDS);
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

  /*
   * Without Redis the counters are this process's own memory, so a slot that is
   * never released used to be permanent: leak three of them and the account
   * could not start another request until the server restarted. The distributed
   * path recovers by TTL, and these cover the fallback doing the same.
   */
  it("reclaims a local slot a request never released", async () => {
    vi.useFakeTimers();

    try {
      const held = await Promise.all(
        Array.from({ length: CONCURRENCY_LIMIT }, () => acquireConcurrency("user-5")),
      );

      expect(held.every((lease) => lease.acquired)).toBe(true);
      expect((await acquireConcurrency("user-5")).acquired).toBe(false);

      // Abandon them without calling release.
      vi.advanceTimersByTime(CONCURRENCY_TTL_SECONDS * 1000);

      const afterExpiry = await acquireConcurrency("user-5");
      expect(afterExpiry.acquired).toBe(true);

      await afterExpiry.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a live slot counted until its expiry, so the limit still holds", async () => {
    vi.useFakeTimers();

    try {
      const first = await acquireConcurrency("user-6");
      expect(first.acquired).toBe(true);

      vi.advanceTimersByTime(CONCURRENCY_TTL_SECONDS * 1000 - 1);

      const remaining = await Promise.all([
        acquireConcurrency("user-6"),
        acquireConcurrency("user-6"),
      ]);

      expect(remaining.filter((lease) => lease.acquired)).toHaveLength(CONCURRENCY_LIMIT - 1);
      expect((await acquireConcurrency("user-6")).acquired).toBe(false);

      await first.release();
      for (const lease of remaining) {
        await lease.release();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an expired slot's release drop one still in use", async () => {
    vi.useFakeTimers();

    try {
      const doomed = await acquireConcurrency("user-7");

      // A second slot taken a minute later expires a minute after the first.
      vi.advanceTimersByTime(60_000);
      const live = await acquireConcurrency("user-7");

      vi.advanceTimersByTime(61_000);
      await doomed.release();

      // `live` still holds its slot, so only two more can start.
      expect((await acquireConcurrency("user-7")).acquired).toBe(true);
      expect((await acquireConcurrency("user-7")).acquired).toBe(true);
      expect((await acquireConcurrency("user-7")).acquired).toBe(false);

      await live.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
