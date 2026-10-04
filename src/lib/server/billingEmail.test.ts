import { describe, expect, it } from "vitest";
import { billingEmail, type BillingEmailSource } from "./billingEmail";

/** Clerk's storage order, which is not a statement about which address is real. */
function account(
  overrides: Partial<BillingEmailSource> = {},
): BillingEmailSource {
  return {
    primaryEmailAddressId: "idn_1",
    emailAddresses: [
      {
        id: "idn_1",
        emailAddress: "old@example.test",
        verification: { status: "unverified" },
      },
      {
        id: "idn_2",
        emailAddress: "work@example.test",
        verification: { status: "verified" },
      },
    ],
    ...overrides,
  };
}

function verified(id: string, emailAddress: string) {
  return { id, emailAddress, verification: { status: "verified" } };
}

function unverified(id: string, emailAddress: string) {
  return { id, emailAddress, verification: { status: "unverified" } };
}

describe("billingEmail", () => {
  it("takes the primary address once it is confirmed", () => {
    expect(
      billingEmail(
        account({
          emailAddresses: [
            verified("idn_9", "spam@example.test"),
            verified("idn_1", "me@example.test"),
          ],
        }),
      ),
    ).toBe("me@example.test");
  });

  it("will not bill an address nobody confirmed, even the primary one", () => {
    expect(
      billingEmail({
        primaryEmailAddressId: "idn_1",
        emailAddresses: [
          unverified("idn_1", "typo@example.test"),
          verified("idn_2", "real@example.test"),
        ],
      }),
    ).toBe("real@example.test");
  });

  it("says nothing when no address is confirmed", () => {
    expect(
      billingEmail({
        primaryEmailAddressId: "idn_1",
        emailAddresses: [unverified("idn_1", "typo@example.test")],
      }),
    ).toBeUndefined();
  });

  it("survives an account whose addresses carry no verification object", () => {
    expect(
      billingEmail({
        primaryEmailAddressId: "idn_1",
        emailAddresses: [{ id: "idn_1", emailAddress: "nobody@example.test" }],
      }),
    ).toBeUndefined();
  });

  it("survives an account that has no addresses at all", () => {
    expect(
      billingEmail({ primaryEmailAddressId: null, emailAddresses: [] }),
    ).toBeUndefined();
    expect(billingEmail(null)).toBeUndefined();
    expect(billingEmail(undefined)).toBeUndefined();
  });
});
