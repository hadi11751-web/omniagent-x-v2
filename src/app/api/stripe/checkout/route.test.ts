import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, currentUser, createSession, stripe } = vi.hoisted(() => {
  const createSession = vi.fn();

  return {
    auth: vi.fn(),
    currentUser: vi.fn(),
    createSession,
    // A `function`, not an arrow: the route calls `new Stripe(secretKey)`.
    stripe: vi.fn(function () {
      return { checkout: { sessions: { create: createSession } } };
    }),
  };
});

vi.mock("@clerk/nextjs/server", () => ({ auth, currentUser }));
vi.mock("stripe", () => ({ default: stripe }));

import { POST } from "@/app/api/stripe/checkout/route";

function request() {
  return new Request("https://app.test/api/stripe/checkout", { method: "POST" });
}

/** Clerk's storage order, which is not a statement about which address is real. */
function account(plan?: string) {
  return {
    primaryEmailAddressId: "idn_2",
    publicMetadata: plan ? { plan } : {},
    emailAddresses: [
      verified("idn_1", "abandoned@example.test"),
      verified("idn_2", "me@example.test"),
    ],
  };
}

function verified(id: string, emailAddress: string) {
  return { id, emailAddress, verification: { status: "verified" } };
}

describe("POST /api/stripe/checkout", () => {
  beforeEach(() => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_1");
    vi.stubEnv("STRIPE_PRICE_ID", "price_1");

    auth.mockReset();
    auth.mockResolvedValue({ userId: "user_1" });
    currentUser.mockReset();
    currentUser.mockResolvedValue(account());
    createSession.mockReset();
    createSession.mockResolvedValue({ url: "https://checkout.stripe.test/cs_1" });
  });

  it("will not open a second subscription for an account that already pays", async () => {
    currentUser.mockResolvedValue(account("paid"));

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ alreadySubscribed: true });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("bills the primary address, not whichever Clerk happened to return first", async () => {
    await POST(request());

    expect(createSession.mock.calls[0][0]).toMatchObject({
      customer_email: "me@example.test",
    });
  });

  it("leaves Stripe to ask for an address when none is confirmed", async () => {
    currentUser.mockResolvedValue({
      primaryEmailAddressId: "idn_1",
      publicMetadata: {},
      emailAddresses: [
        {
          id: "idn_1",
          emailAddress: "typo@example.test",
          verification: { status: "unverified" },
        },
      ],
    });

    await POST(request());

    expect(createSession.mock.calls[0][0]).not.toHaveProperty("customer_email");
  });

  it("takes the confirmed address when the primary one was never verified", async () => {
    currentUser.mockResolvedValue({
      primaryEmailAddressId: "idn_1",
      publicMetadata: {},
      emailAddresses: [
        {
          id: "idn_1",
          emailAddress: "typo@example.test",
          verification: { status: "unverified" },
        },
        verified("idn_2", "me@example.test"),
      ],
    });

    await POST(request());

    expect(createSession.mock.calls[0][0]).toMatchObject({
      customer_email: "me@example.test",
    });
  });

  it("still ties the session to this Clerk user so the webhook can find it", async () => {
    await POST(request());

    expect(createSession.mock.calls[0][0]).toMatchObject({
      client_reference_id: "user_1",
      subscription_data: { metadata: { clerkUserId: "user_1" } },
    });
  });

  it("refuses a signed-out request and an unconfigured server", async () => {
    auth.mockResolvedValue({ userId: null });

    expect((await POST(request())).status).toBe(401);

    auth.mockResolvedValue({ userId: "user_1" });
    vi.stubEnv("STRIPE_PRICE_ID", "");

    expect((await POST(request())).status).toBe(503);
    expect(createSession).not.toHaveBeenCalled();
  });
});
