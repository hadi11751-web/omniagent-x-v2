import Stripe from "stripe";

export type PortalFailure = {
  error: string;
  /** 503 when billing has no keys, 400/404 for this account, 502 when Stripe fails. */
  status: 400 | 404 | 502 | 503;
};

export type PortalResult = { url: string } | PortalFailure;

/**
 * Stripe creates a customer per checkout session, so one email can own several.
 * A handful is enough to cover that without an unbounded loop of follow-up
 * lookups.
 */
const MAX_CUSTOMERS_PER_EMAIL = 5;

/** Lower wins: the account still being billed is the one to manage. */
const SUBSCRIPTION_RANK: Record<string, number> = {
  active: 0,
  trialing: 1,
  past_due: 2,
  paused: 3,
  incomplete: 4,
  unpaid: 5,
  incomplete_expired: 6,
  canceled: 7,
};

const CUSTOMER_WITHOUT_SUBSCRIPTION = Number.MAX_SAFE_INTEGER;

/**
 * Opens Stripe's customer portal for the signed-in account so a paid user can
 * change their card or cancel. It matches the customer by email because this
 * project stores no Stripe objects of its own -- the webhook only flips
 * `publicMetadata.plan` on the Clerk user.
 *
 * Existing billing (`/api/stripe/checkout`, `/api/stripe/webhook`) is not
 * involved here; this only reads.
 */
export async function createPortalUrl(
  email: string | undefined,
  returnUrl: string,
): Promise<PortalResult> {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return { error: "billing isn't configured on the server yet", status: 503 };
  }

  if (!email) {
    return {
      error: "this account has no email address to match a Stripe customer against",
      status: 400,
    };
  }

  const stripe = new Stripe(secretKey);

  try {
    const { data: customers } = await stripe.customers.list({
      email,
      limit: MAX_CUSTOMERS_PER_EMAIL,
    });

    if (!customers.length) {
      return {
        error: "no Stripe customer found for this email yet",
        status: 404,
      };
    }

    const customer =
      customers.length === 1
        ? customers[0]
        : await pickCustomer(stripe, customers);

    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: returnUrl,
    });

    return { url: session.url };
  } catch (error) {
    return {
      error: `Stripe could not open the portal: ${(error as Error).message}`,
      status: 502,
    };
  }
}

/**
 * Reading whichever customer Stripe happened to list first can open the portal
 * on a cancelled customer while the live subscription sits on another one. So
 * when an email matches more than one, rank them by their subscriptions and
 * prefer the one still being billed; ties fall back to the newest customer.
 */
async function pickCustomer(
  stripe: Stripe,
  customers: Stripe.Customer[],
): Promise<Stripe.Customer> {
  const newestFirst = [...customers].sort((a, b) => b.created - a.created);
  let best = newestFirst[0];
  let bestRank = CUSTOMER_WITHOUT_SUBSCRIPTION;

  for (const customer of newestFirst) {
    const { data: subscriptions } = await stripe.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 10,
    });

    if (!subscriptions.length) continue;

    const rank = Math.min(
      ...subscriptions.map(
        (subscription) => SUBSCRIPTION_RANK[subscription.status] ??
          CUSTOMER_WITHOUT_SUBSCRIPTION,
      ),
    );

    if (rank < bestRank) {
      best = customer;
      bestRank = rank;
    }
  }

  return best;
}
