import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listCustomers, listSubscriptions, createPortalSession } = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  listSubscriptions: vi.fn(),
  createPortalSession: vi.fn(),
}));

vi.mock("stripe", () => ({
  // A `function`, not an arrow: portal.ts calls `new Stripe(key)`.
  default: vi.fn(function () {
    return {
      customers: { list: listCustomers },
      subscriptions: { list: listSubscriptions },
      billingPortal: { sessions: { create: createPortalSession } },
    };
  }),
}));

import { createPortalUrl } from "@/lib/server/portal";

function customer(id: string, created: number) {
  return { id, created };
}

function subscription(status: string) {
  return { status };
}

describe("createPortalUrl", () => {
  beforeEach(() => {
    listCustomers.mockReset();
    listSubscriptions.mockReset();
    createPortalSession.mockReset();
    listSubscriptions.mockResolvedValue({ data: [] });
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("opens the portal for the customer matching this account's email", async () => {
    listCustomers.mockResolvedValue({ data: [{ id: "cus_42" }] });
    createPortalSession.mockResolvedValue({
      url: "https://billing.stripe.com/session/abc",
    });

    const result = await createPortalUrl("me@example.com", "https://app.test/pricing");

    expect(result).toEqual({ url: "https://billing.stripe.com/session/abc" });
    expect(listCustomers).toHaveBeenCalledWith({
      email: "me@example.com",
      limit: 5,
    });
    expect(createPortalSession).toHaveBeenCalledWith({
      customer: "cus_42",
      return_url: "https://app.test/pricing",
    });
  });

  it("opens the portal on the customer that is still being billed", async () => {
    // Stripe lists customers newest-first, so the cancelled one comes first here.
    listCustomers.mockResolvedValue({
      data: [customer("cus_new_cancelled", 300), customer("cus_old_active", 200)],
    });
    listSubscriptions.mockImplementation(async ({ customer: id }: { customer: string }) => ({
      data:
        id === "cus_new_cancelled"
          ? [subscription("canceled")]
          : [subscription("active")],
    }));
    createPortalSession.mockResolvedValue({ url: "https://billing.stripe.com/active" });

    const result = await createPortalUrl("me@example.com", "https://app.test/pricing");

    expect(result).toEqual({ url: "https://billing.stripe.com/active" });
    expect(createPortalSession).toHaveBeenCalledWith({
      customer: "cus_old_active",
      return_url: "https://app.test/pricing",
    });
  });

  it("keeps the newest customer when none of them has a subscription", async () => {
    listCustomers.mockResolvedValue({
      data: [customer("cus_b", 300), customer("cus_a", 100)],
    });
    createPortalSession.mockResolvedValue({ url: "https://billing.stripe.com/newest" });

    const result = await createPortalUrl("me@example.com", "https://app.test/pricing");

    expect(result).toEqual({ url: "https://billing.stripe.com/newest" });
    expect(createPortalSession).toHaveBeenCalledWith({
      customer: "cus_b",
      return_url: "https://app.test/pricing",
    });
  });

  it("refuses without an email to match on", async () => {
    await expect(createPortalUrl(undefined, "https://app.test/pricing")).resolves.toEqual({
      error: "this account has no email address to match a Stripe customer against",
      status: 400,
    });

    expect(listCustomers).not.toHaveBeenCalled();
  });

  it("says billing is unconfigured rather than calling Stripe", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");

    await expect(createPortalUrl("me@example.com", "https://app.test/pricing")).resolves.toEqual(
      {
        error: "billing isn't configured on the server yet",
        status: 503,
      },
    );

    expect(listCustomers).not.toHaveBeenCalled();
  });

  it("reports a paid user whose Stripe customer can't be found", async () => {
    listCustomers.mockResolvedValue({ data: [] });

    await expect(
      createPortalUrl("new@example.com", "https://app.test/pricing"),
    ).resolves.toEqual({
      error: "no Stripe customer found for this email yet",
      status: 404,
    });

    expect(createPortalSession).not.toHaveBeenCalled();
  });

  it("turns a Stripe failure into a status instead of throwing", async () => {
    listCustomers.mockResolvedValue({ data: [{ id: "cus_42" }] });
    createPortalSession.mockRejectedValue(
      new Error("No configuration found for customer portal"),
    );

    await expect(
      createPortalUrl("me@example.com", "https://app.test/pricing"),
    ).resolves.toEqual({
      error: "Stripe could not open the portal: No configuration found for customer portal",
      status: 502,
    });
  });
});
