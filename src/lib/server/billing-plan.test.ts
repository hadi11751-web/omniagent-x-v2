import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { reconcilePlan } from "@/lib/server/billing-plan";

/*
 * The plan a cancellation leaves behind is decided by every subscription the
 * account owns, so these are the shapes of the Stripe answers that matter: one
 * page, several pages, and a list that never ends.
 */

interface StubSubscription {
  id: string;
  status: string;
  metadata?: Record<string, string>;
}

function stripeFor({
  subscription,
  customer = { id: "cus_1", email: "payer@example.test" },
  customers = [{ id: "cus_1" }],
  subscriptions = { cus_1: [] as StubSubscription[] },
}: {
  subscription: StubSubscription & { customer?: string };
  customer?: { id: string; email?: string; deleted?: boolean };
  customers?: { id: string }[];
  subscriptions?: Record<string, StubSubscription[]>;
}) {
  const listSubscriptions = vi.fn();
  const listCustomers = vi.fn();

  const stripe = {
    subscriptions: {
      retrieve: vi.fn(async () => ({
        ...subscription,
        customer: subscription.customer ?? customer.id,
      })),
      list: listSubscriptions,
    },
    customers: {
      retrieve: vi.fn(async () => customer),
      list: listCustomers,
    },
  } as unknown as Stripe;

  listCustomers.mockResolvedValue({ data: customers, has_more: false });

  listSubscriptions.mockImplementation(
    async ({ customer: customerId }: { customer: string }) => ({
      data: subscriptions[customerId] ?? [],
      has_more: false,
    }),
  );

  return { stripe, listSubscriptions, listCustomers };
}

describe("reconcilePlan", () => {
  it("answers from the event's own subscription when it is still charging", async () => {
    const { stripe, listSubscriptions } = stripeFor({
      subscription: { id: "sub_1", status: "active" },
    });

    await expect(reconcilePlan(stripe, "sub_1", "user-1")).resolves.toBe("paid");
    expect(listSubscriptions).not.toHaveBeenCalled();
  });

  it("downgrades when the account has nothing else", async () => {
    const { stripe } = stripeFor({
      subscription: { id: "sub_1", status: "canceled" },
      subscriptions: {
        cus_1: [{ id: "sub_1", status: "canceled", metadata: { clerkUserId: "user-1" } }],
      },
    });

    await expect(reconcilePlan(stripe, "sub_1", "user-1")).resolves.toBe("free");
  });

  it("keeps paying across the second customer one email owns", async () => {
    const { stripe } = stripeFor({
      subscription: { id: "sub_old", status: "canceled" },
      customers: [{ id: "cus_1" }, { id: "cus_2" }],
      subscriptions: {
        cus_1: [{ id: "sub_old", status: "canceled", metadata: { clerkUserId: "user-1" } }],
        cus_2: [{ id: "sub_new", status: "active", metadata: { clerkUserId: "user-1" } }],
      },
    });

    await expect(reconcilePlan(stripe, "sub_old", "user-1")).resolves.toBe("paid");
  });

  it("will not hold a plan open on somebody else's subscription", async () => {
    const { stripe } = stripeFor({
      subscription: { id: "sub_old", status: "canceled" },
      customers: [{ id: "cus_1" }, { id: "cus_2" }],
      subscriptions: {
        cus_1: [{ id: "sub_old", status: "canceled", metadata: { clerkUserId: "user-1" } }],
        cus_2: [{ id: "sub_new", status: "active", metadata: { clerkUserId: "user-9" } }],
      },
    });

    await expect(reconcilePlan(stripe, "sub_old", "user-1")).resolves.toBe("free");
  });

  it("reads a customer with no email as one account", async () => {
    const { stripe, listCustomers } = stripeFor({
      subscription: { id: "sub_1", status: "canceled" },
      customer: { id: "cus_1" },
    });

    await expect(reconcilePlan(stripe, "sub_1", "user-1")).resolves.toBe("free");
    expect(listCustomers).not.toHaveBeenCalled();
  });

  it("follows the cursor until the list is exhausted", async () => {
    const { stripe, listSubscriptions } = stripeFor({
      subscription: { id: "sub_old", status: "canceled" },
    });

    const pages = [
      { data: [{ id: "sub_1", status: "canceled" }], has_more: true },
      { data: [{ id: "sub_2", status: "canceled" }], has_more: true },
      { data: [{ id: "sub_3", status: "trialing" }], has_more: false },
    ];

    listSubscriptions.mockImplementation(
      async ({ starting_after: startingAfter }: { starting_after?: string }) =>
        pages[startingAfter ? Number(startingAfter.slice(4)) : 0],
    );

    await expect(reconcilePlan(stripe, "sub_old", "user-1")).resolves.toBe("paid");

    expect(listSubscriptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ starting_after: "sub_2", limit: 100 }),
    );
  });

  /*
   * The page after the last one read can hold the subscription that is still
   * charging, so a scan that stopped early has no answer in it. `free` from a
   * partial view is the failure this whole function exists to avoid.
   */
  it("says nothing when the customers behind an email never ran out", async () => {
    const { stripe, listCustomers } = stripeFor({
      subscription: { id: "sub_old", status: "canceled" },
    });

    listCustomers.mockImplementation(async ({ starting_after: startingAfter }) => ({
      data: [{ id: startingAfter ? `cus_more_${startingAfter}` : "cus_more" }],
      has_more: true,
    }));

    await expect(reconcilePlan(stripe, "sub_old", "user-1")).resolves.toBeUndefined();
    expect(listCustomers).toHaveBeenCalledTimes(3);
  });

  it("says nothing when one customer's subscriptions never ran out", async () => {
    const { stripe, listSubscriptions } = stripeFor({
      subscription: { id: "sub_old", status: "canceled", customer: "cus_1" },
    });

    listSubscriptions.mockImplementation(async ({ starting_after: startingAfter }) => ({
      data: [{ id: startingAfter ? `sub_${startingAfter}_next` : "sub_next", status: "canceled" }],
      has_more: true,
    }));

    await expect(reconcilePlan(stripe, "sub_old", "user-1")).resolves.toBeUndefined();
    expect(listSubscriptions).toHaveBeenCalledTimes(3);
  });
});
