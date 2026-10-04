import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { retrieve } = vi.hoisted(() => ({ retrieve: vi.fn() }));

vi.mock("stripe", () => ({
  // A `function`, not an arrow: price.ts calls `new Stripe(key)`.
  default: vi.fn(function () {
    return { prices: { retrieve } };
  }),
}));

import { readPlanPrice } from "@/lib/server/price";

describe("readPlanPrice", () => {
  beforeEach(() => {
    retrieve.mockReset();
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    vi.stubEnv("STRIPE_PRICE_ID", "price_123");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns the configured price so the page can show the real amount", async () => {
    retrieve.mockResolvedValue({
      active: true,
      unit_amount: 1900,
      currency: "usd",
      recurring: { interval: "month" },
    });

    await expect(readPlanPrice()).resolves.toEqual({
      unitAmount: 1900,
      currency: "usd",
      interval: "month",
    });

    expect(retrieve).toHaveBeenCalledWith("price_123");
  });

  it("refuses a one-off price that subscription checkout cannot charge", async () => {
    retrieve.mockResolvedValue({
      active: true,
      unit_amount: 500,
      currency: "eur",
    });

    await expect(readPlanPrice()).resolves.toBeNull();
  });

  it.each([
    ["no secret key", "", "price_123"],
    ["no price id", "sk_test_123", ""],
  ])("stays silent when billing has %s", async (_label, secret, priceId) => {
    vi.stubEnv("STRIPE_SECRET_KEY", secret);
    vi.stubEnv("STRIPE_PRICE_ID", priceId);

    await expect(readPlanPrice()).resolves.toBeNull();
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("ignores an archived price instead of showing a dead amount", async () => {
    retrieve.mockResolvedValue({
      active: false,
      unit_amount: 1900,
      currency: "usd",
      recurring: { interval: "month" },
    });

    await expect(readPlanPrice()).resolves.toBeNull();
  });

  it("ignores a metered price with no fixed amount", async () => {
    retrieve.mockResolvedValue({
      active: true,
      unit_amount: null,
      currency: "usd",
    });

    await expect(readPlanPrice()).resolves.toBeNull();
  });

  it("degrades to null when Stripe cannot be reached", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    retrieve.mockRejectedValue(new Error("network down"));

    await expect(readPlanPrice()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });
});
