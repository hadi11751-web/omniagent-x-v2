import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  eval: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  Redis: class {
    get = mocks.get;
    set = mocks.set;
    eval = mocks.eval;
  },
}));

import {
  STRIPE_WEBHOOK_LOCK_TTL_SECONDS,
  STRIPE_WEBHOOK_PROCESSED_TTL_SECONDS,
  STRIPE_WEBHOOK_PROCESSING_TTL_SECONDS,
  acquireStripeSubscriptionLock,
  claimStripeWebhookEvent,
  stripeWebhookRedisConfigured,
} from "./stripeWebhook";

describe("Stripe webhook state protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.UPSTASH_REDIS_REST_URL =
      "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN =
      "test-token";
  });

  it("atomically claims a new webhook event", async () => {
    mocks.set.mockResolvedValueOnce("OK");

    const claim =
      await claimStripeWebhookEvent("evt_123");

    expect(claim.acquired).toBe(true);

    expect(mocks.set).toHaveBeenCalledWith(
      "stripe:webhook:event:evt_123",
      expect.stringMatching(/^processing:/),
      {
        nx: true,
        ex: STRIPE_WEBHOOK_PROCESSING_TTL_SECONDS,
      },
    );
  });

  it("rejects a duplicate webhook event atomically", async () => {
    mocks.set.mockResolvedValueOnce(null);
    mocks.get.mockResolvedValueOnce(
      "processing:another-worker",
    );

    const claim =
      await claimStripeWebhookEvent("evt_456");

    expect(claim.acquired).toBe(false);
    expect(claim.processed).toBe(false);

    expect(mocks.get).toHaveBeenCalledWith(
      "stripe:webhook:event:evt_456",
    );
  });

  it("recognizes a completed duplicate webhook event", async () => {
    mocks.set.mockResolvedValueOnce(null);
    mocks.get.mockResolvedValueOnce("processed");

    const claim =
      await claimStripeWebhookEvent("evt_457");

    expect(claim.acquired).toBe(false);
    expect(claim.processed).toBe(true);
  });

  it("marks an owned event as processed", async () => {
    mocks.set.mockResolvedValueOnce("OK");

    const claim =
      await claimStripeWebhookEvent("evt_789");

    await claim.complete();

    expect(mocks.eval).toHaveBeenCalledTimes(1);

    const [script, keys, args] =
      mocks.eval.mock.calls[0];

    expect(script).toContain(
      "redis.call('SET', KEYS[1], 'processed'",
    );
    expect(keys).toEqual([
      "stripe:webhook:event:evt_789",
    ]);
    expect(args).toEqual([
      expect.stringMatching(/^processing:/),
      STRIPE_WEBHOOK_PROCESSED_TTL_SECONDS,
    ]);
  });

  it("releases an owned event claim", async () => {
    mocks.set.mockResolvedValueOnce("OK");

    const claim =
      await claimStripeWebhookEvent("evt_release");

    await claim.release();

    expect(mocks.eval).toHaveBeenCalledTimes(1);

    const [script, keys, args] =
      mocks.eval.mock.calls[0];

    expect(script).toContain(
      "return redis.call('DEL', KEYS[1])",
    );
    expect(keys).toEqual([
      "stripe:webhook:event:evt_release",
    ]);
    expect(args).toEqual([
      expect.stringMatching(/^processing:/),
    ]);
  });

  it("does not complete or release the same claim twice", async () => {
    mocks.set.mockResolvedValueOnce("OK");

    const claim =
      await claimStripeWebhookEvent("evt_once");

    await claim.complete();
    await claim.complete();
    await claim.release();

    expect(mocks.eval).toHaveBeenCalledTimes(1);
  });

  it("has a finite processing TTL", () => {
    expect(
      STRIPE_WEBHOOK_PROCESSING_TTL_SECONDS,
    ).toBe(5 * 60);
  });

  it("has durable processed-event retention", () => {
    expect(
      STRIPE_WEBHOOK_PROCESSED_TTL_SECONDS,
    ).toBe(35 * 24 * 60 * 60);
  });

  it("acquires a per-subscription lock with NX and EX", async () => {
    mocks.set.mockResolvedValueOnce("OK");

    const lock =
      await acquireStripeSubscriptionLock("sub_123");

    expect(lock.acquired).toBe(true);

    expect(mocks.set).toHaveBeenCalledWith(
      "stripe:webhook:lock:sub_123",
      expect.any(String),
      {
        nx: true,
        ex: STRIPE_WEBHOOK_LOCK_TTL_SECONDS,
      },
    );
  });

  it("rejects a second simultaneous subscription lock", async () => {
    mocks.set.mockResolvedValueOnce(null);

    const lock =
      await acquireStripeSubscriptionLock("sub_456");

    expect(lock.acquired).toBe(false);
  });

  it("releases only its own subscription lock", async () => {
    mocks.set.mockResolvedValueOnce("OK");

    const lock =
      await acquireStripeSubscriptionLock("sub_789");

    await lock.release();

    expect(mocks.eval).toHaveBeenCalledTimes(1);

    const [script, keys, args] =
      mocks.eval.mock.calls[0];

    expect(script).toContain(
      "return redis.call('DEL', KEYS[1])",
    );
    expect(keys).toEqual([
      "stripe:webhook:lock:sub_789",
    ]);
    expect(args).toEqual([
      expect.any(String),
    ]);
  });

  it("makes subscription-lock release idempotent", async () => {
    mocks.set.mockResolvedValueOnce("OK");

    const lock =
      await acquireStripeSubscriptionLock("sub_999");

    await lock.release();
    await lock.release();

    expect(mocks.eval).toHaveBeenCalledTimes(1);
  });

  it("reports whether durable webhook storage is configured", () => {
    expect(stripeWebhookRedisConfigured()).toBe(true);

    delete process.env.UPSTASH_REDIS_REST_URL;

    expect(stripeWebhookRedisConfigured()).toBe(false);
  });
});