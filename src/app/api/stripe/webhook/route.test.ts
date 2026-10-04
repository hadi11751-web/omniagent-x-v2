import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  constructEvent,
  retrieveSubscription,
  listSubscriptions,
  retrieveCustomer,
  listCustomers,
  updateUserMetadata,
  claimEvent,
  markEventHandled,
  releaseEventClaim,
} = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  retrieveSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
  retrieveCustomer: vi.fn(),
  listCustomers: vi.fn(),
  updateUserMetadata: vi.fn(),
  claimEvent: vi.fn(),
  markEventHandled: vi.fn(),
  releaseEventClaim: vi.fn(),
}));

vi.mock("stripe", () => ({
  // A `function`, not an arrow: the route calls `new Stripe(secretKey)`.
  default: vi.fn(function () {
    return {
      webhooks: { constructEvent },
      subscriptions: {
        retrieve: retrieveSubscription,
        list: listSubscriptions,
      },
      customers: {
        retrieve: retrieveCustomer,
        list: listCustomers,
      },
    };
  }),
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: vi.fn(async () => ({
    users: { updateUserMetadata },
  })),
}));

vi.mock("@/lib/server/billing-events", () => ({
  claimEvent,
  markEventHandled,
  releaseEventClaim,
}));

import { POST } from "@/app/api/stripe/webhook/route";

function delivery(
  id: string,
  type: string,
  object: Record<string, unknown>,
) {
  const body = JSON.stringify({ id, type, data: { object } });

  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "t=1,v1=signature",
    },
    body,
  });
}

function checkoutRequest(id = "evt_checkout") {
  return delivery(id, "checkout.session.completed", {
    client_reference_id: "user-1",
    subscription: "sub_123",
    payment_status: "paid",
  });
}

function subscriptionRequest(
  id: string,
  payloadStatus: string,
  currentStatus: string,
) {
  retrieveSubscription.mockResolvedValue({ status: currentStatus });

  return delivery(id, "customer.subscription.updated", {
    id: "sub_123",
    status: payloadStatus,
    metadata: { clerkUserId: "user-1" },
  });
}

describe("POST /api/stripe/webhook", () => {
  beforeEach(() => {
    constructEvent.mockReset();
    // Stands in for signature verification: the event is whatever the raw
    // body carried, which is exactly what the route hands to the handler.
    constructEvent.mockImplementation((raw: string) => JSON.parse(raw));
    retrieveSubscription.mockReset().mockResolvedValue({ status: "active" });
    listSubscriptions
      .mockReset()
      .mockResolvedValue({ data: [] });
    retrieveCustomer
      .mockReset()
      .mockResolvedValue({ id: "cus_1", email: "payer@example.test" });
    listCustomers.mockReset().mockResolvedValue({ data: [{ id: "cus_1" }] });
    updateUserMetadata.mockReset().mockResolvedValue(undefined);
    claimEvent.mockReset().mockResolvedValue(true);
    markEventHandled.mockReset().mockResolvedValue(undefined);
    releaseEventClaim.mockReset().mockResolvedValue(undefined);

    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_123");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses a delivery with no signature", async () => {
    const response = await POST(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(400);
    expect(constructEvent).not.toHaveBeenCalled();
  });

  it("stays unconfigured when the signing secret is missing", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");

    const response = await POST(checkoutRequest());

    expect(response.status).toBe(503);
    expect(constructEvent).not.toHaveBeenCalled();
  });

  it("rejects a body the signature does not cover", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature");
    });

    const response = await POST(checkoutRequest());

    expect(response.status).toBe(400);
    expect(updateUserMetadata).not.toHaveBeenCalled();
  });

  it("upgrades a completed checkout once the subscription is confirmed charging", async () => {
    const response = await POST(checkoutRequest());

    expect(response.status).toBe(200);
    expect(updateUserMetadata).toHaveBeenCalledWith("user-1", {
      publicMetadata: { plan: "paid" },
    });
  });

  it("does not re-grant paid when a checkout is replayed after cancellation", async () => {
    retrieveSubscription.mockResolvedValue({ status: "canceled" });

    const response = await POST(checkoutRequest());

    expect(response.status).toBe(200);
    expect(updateUserMetadata).toHaveBeenCalledWith("user-1", {
      publicMetadata: { plan: "free" },
    });
  });

  it("follows the live subscription status instead of the one in the payload", async () => {
    // An old, out-of-order "active" delivery arriving after the cancel.
    const response = await POST(subscriptionRequest("evt_old", "active", "canceled"));

    expect(response.status).toBe(200);
    expect(updateUserMetadata).toHaveBeenCalledWith("user-1", {
      publicMetadata: { plan: "free" },
    });
  });

  it("keeps a past_due subscription off the paid plan", async () => {
    await POST(subscriptionRequest("evt_due", "past_due", "past_due"));

    expect(updateUserMetadata).toHaveBeenCalledWith("user-1", {
      publicMetadata: { plan: "free" },
    });
  });

  it("still counts a trialing subscription as paid", async () => {
    await POST(subscriptionRequest("evt_trial", "trialing", "trialing"));

    expect(updateUserMetadata).toHaveBeenCalledWith("user-1", {
      publicMetadata: { plan: "paid" },
    });
  });

  it("stops a replayed event before it reaches Clerk", async () => {
    claimEvent.mockResolvedValue(false);

    const response = await POST(checkoutRequest("evt_replay"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      received: true,
      duplicate: true,
    });
    expect(updateUserMetadata).not.toHaveBeenCalled();
    expect(retrieveSubscription).not.toHaveBeenCalled();
    expect(markEventHandled).not.toHaveBeenCalled();
  });

  it("leaves an event with no Clerk reference alone", async () => {
    const response = await POST(
      delivery("evt_nobody", "checkout.session.completed", {
        subscription: "sub_123",
        payment_status: "paid",
      }),
    );

    expect(response.status).toBe(200);
    expect(updateUserMetadata).not.toHaveBeenCalled();
  });

  it("ignores an event type that says nothing about the plan", async () => {
    const response = await POST(delivery("evt_ping", "ping", {}));

    expect(response.status).toBe(200);
    expect(updateUserMetadata).not.toHaveBeenCalled();
  });

  it("asks Stripe to retry an event it could not apply", async () => {
    updateUserMetadata.mockRejectedValue(new Error("Clerk is unreachable"));

    const response = await POST(checkoutRequest("evt_failed"));

    expect(response.status).toBe(502);
    expect(markEventHandled).not.toHaveBeenCalled();
    expect(releaseEventClaim).toHaveBeenCalledWith("evt_failed");
  });

  it("records an event only after the plan write succeeded", async () => {
    const response = await POST(checkoutRequest("evt_ok"));

    expect(response.status).toBe(200);
    expect(markEventHandled).toHaveBeenCalledWith("evt_ok");
  });

  /*
   * Stripe creates a customer per checkout session, so walking through the
   * pricing page twice leaves two subscriptions. Reading only the one the event
   * named used to switch the plan off while the other was still charging.
   */
  describe("reconciling a downgrade against the rest of the account", () => {
    function cancellation(customerId = "cus_1") {
      retrieveSubscription.mockResolvedValue({
        status: "canceled",
        customer: customerId,
      });

      return delivery("evt_cancel", "customer.subscription.deleted", {
        id: "sub_old",
        status: "canceled",
        customer: customerId,
        metadata: { clerkUserId: "user-1" },
      });
    }

    it("keeps the plan paid while a sibling subscription on the same customer is active", async () => {
      listSubscriptions.mockResolvedValue({
        data: [
          { status: "canceled", metadata: { clerkUserId: "user-1" } },
          { status: "active", metadata: { clerkUserId: "user-1" } },
        ],
      });

      await POST(cancellation());

      expect(updateUserMetadata).toHaveBeenCalledWith("user-1", {
        publicMetadata: { plan: "paid" },
      });
    });

    it("finds the live subscription on the second customer the same email owns", async () => {
      listCustomers.mockResolvedValue({
        data: [{ id: "cus_1" }, { id: "cus_2" }],
      });
      listSubscriptions.mockImplementation(
        async ({ customer }: { customer: string }) => ({
          data:
            customer === "cus_2"
              ? [{ status: "active", metadata: { clerkUserId: "user-1" } }]
              : [{ status: "canceled", metadata: { clerkUserId: "user-1" } }],
        }),
      );

      await POST(cancellation());

      expect(updateUserMetadata).toHaveBeenCalledWith("user-1", {
        publicMetadata: { plan: "paid" },
      });
    });

    it("will not hold a plan open on another account's subscription", async () => {
      listCustomers.mockResolvedValue({
        data: [{ id: "cus_1" }, { id: "cus_2" }],
      });
      listSubscriptions.mockImplementation(
        async ({ customer }: { customer: string }) => ({
          data:
            customer === "cus_2"
              ? [{ status: "active", metadata: { clerkUserId: "user-9" } }]
              : [{ status: "canceled", metadata: { clerkUserId: "user-1" } }],
        }),
      );

      await POST(cancellation());

      expect(updateUserMetadata).toHaveBeenCalledWith("user-1", {
        publicMetadata: { plan: "free" },
      });
    });

    it("downgrades once nothing on the account is charging any more", async () => {
      listSubscriptions.mockResolvedValue({
        data: [{ status: "canceled", metadata: { clerkUserId: "user-1" } }],
      });

      await POST(cancellation());

      expect(updateUserMetadata).toHaveBeenCalledWith("user-1", {
        publicMetadata: { plan: "free" },
      });
    });

    /*
     * A lookup that stops short is not a lookup that found nothing. Answering
     * `free` from the first few pages would switch off an account whose paying
     * subscription was on the page that was never read.
     */
    it("refuses to downgrade from a list it could not finish reading", async () => {
      listSubscriptions.mockResolvedValue({
        data: [{ status: "canceled", metadata: { clerkUserId: "user-1" } }],
        has_more: true,
      });

      const response = await POST(cancellation());

      expect(response.status).toBe(502);
      expect(updateUserMetadata).not.toHaveBeenCalled();
      expect(releaseEventClaim).toHaveBeenCalledWith("evt_cancel");
    });

    it("pages on until the list ends before answering free", async () => {
      const pages = [
        { data: [{ id: "sub_1", status: "canceled" }], has_more: true },
        { data: [{ id: "sub_2", status: "canceled" }], has_more: true },
        { data: [{ id: "sub_3", status: "active" }], has_more: false },
      ];

      listSubscriptions.mockImplementation(
        async ({ starting_after: startingAfter }: { starting_after?: string }) =>
          pages[startingAfter ? Number(startingAfter.slice(4)) : 0],
      );
      listCustomers.mockResolvedValue({ data: [{ id: "cus_1" }] });

      await POST(cancellation());

      expect(listSubscriptions).toHaveBeenCalledWith(
        expect.objectContaining({ starting_after: "sub_2" }),
      );
      expect(updateUserMetadata).toHaveBeenCalledWith("user-1", {
        publicMetadata: { plan: "paid" },
      });
    });
  });
});
