/**
 * The email a billing request may be made under.
 *
 * `emailAddresses[0]` is Clerk's storage order, not a statement about the
 * account: a person with a discarded address first had Stripe bill that one, and
 * an address nobody ever confirmed can belong to somebody else. The primary wins
 * when it is verified; failing that, a verified address is used; failing that
 * there is nothing to assert, and the caller passes no email at all so Stripe
 * asks for it on the checkout page.
 *
 * Shaped to what `currentUser()` hands back, so the routes can pass the user
 * straight in.
 */
interface BillingEmailAddress {
  id: string;
  emailAddress: string;
  verification?: { status: string } | null;
}

export interface BillingEmailSource {
  primaryEmailAddressId: string | null;
  emailAddresses: BillingEmailAddress[];
}

function isVerified(address: BillingEmailAddress): boolean {
  return Boolean(
    address.emailAddress && address.verification?.status === "verified",
  );
}

export function billingEmail(
  user: BillingEmailSource | null | undefined,
): string | undefined {
  if (!user) return undefined;

  const addresses = user.emailAddresses ?? [];

  const primary = user.primaryEmailAddressId
    ? addresses.find((entry) => entry.id === user.primaryEmailAddressId)
    : undefined;

  if (primary && isVerified(primary)) return primary.emailAddress;

  const verified = addresses.find(isVerified);

  return verified?.emailAddress;
}
