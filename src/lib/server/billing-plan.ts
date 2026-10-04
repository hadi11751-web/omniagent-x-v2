import Stripe from "stripe";

/** The same two statuses the rest of the app reads as a paid account. */
export function planFor(status: string | null | undefined): "free" | "paid" {
  return status === "active" || status === "trialing" ? "paid" : "free";
}

/**
 * `free` and `paid` are answers about the account. `undefined` says the account
 * could not be read to the end, which is not the same statement and must not be
 * written as one.
 */
export type ReconciledPlan = "free" | "paid" | undefined;

/** The largest page Stripe serves. */
const PAGE_SIZE = 100;

/**
 * How far one reconciliation pages. Three pages is 300 customers behind an
 * email, or 300 subscriptions on one customer: an account past that is not a
 * customer who used the pricing page twice, so the scan stops and reports
 * itself incomplete rather than answering from what the first page happened to
 * show.
 */
const MAX_PAGES = 3;

interface Page<T> {
  data: T[];
  has_more: boolean;
}

interface Scanned<T> {
  items: T[];
  /** True when the list went past `MAX_PAGES * PAGE_SIZE` and stopped. */
  truncated: boolean;
}

async function scanAll<T extends { id: string }>(
  read: (startingAfter: string | undefined) => Promise<Page<T>>,
): Promise<Scanned<T>> {
  const items: T[] = [];
  let startingAfter: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const next = await read(startingAfter);

    items.push(...next.data);

    if (!next.has_more) return { items, truncated: false };

    const last = next.data[next.data.length - 1];

    if (!last) return { items, truncated: true };

    startingAfter = last.id;
  }

  return { items, truncated: true };
}

function customerIdOf(customer: Stripe.Subscription["customer"]): string | undefined {
  return typeof customer === "string" ? customer : customer?.id;
}

/**
 * The plan the account really has, after every subscription that could still be
 * billing it has had a say.
 *
 * A cancellation event names one subscription, and one subscription is not one
 * account: Stripe creates a customer per checkout session, so going through the
 * pricing page twice leaves two subscriptions and reading either one alone
 * switches the plan off while the other is still charging. Reconciliation can
 * only ever keep access on, never grant it, which is why looking at the whole
 * account here is safe in the direction that matters — and why an account that
 * cannot be read to the end says so instead of answering `free`.
 */
export async function reconcilePlan(
  stripe: Stripe,
  subscriptionId: string,
  clerkUserId: string,
): Promise<ReconciledPlan> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  if (planFor(subscription.status) === "paid") return "paid";

  const ownCustomerId = customerIdOf(subscription.customer);

  if (!ownCustomerId) return "free";

  const customer = (await stripe.customers.retrieve(
    ownCustomerId,
  )) as Stripe.Customer;

  const email = customer.deleted ? undefined : customer.email || undefined;

  let truncated = false;
  const customerIds: string[] = [];

  if (email) {
    const siblings = await scanAll((startingAfter) =>
      stripe.customers.list({
        email,
        limit: PAGE_SIZE,
        starting_after: startingAfter,
      }),
    );

    truncated = siblings.truncated;
    customerIds.push(...siblings.items.map((entry) => entry.id));

    /*
     * Stripe filters a customer list by exact email, so the customer named by
     * the event is normally in it. Asking for it again costs nothing and keeps
     * this account's own subscriptions in the scan if it ever is not.
     */
    if (!customerIds.includes(ownCustomerId)) customerIds.push(ownCustomerId);
  } else {
    customerIds.push(ownCustomerId);
  }

  for (const customerId of customerIds) {
    const subscriptions = await scanAll((startingAfter) =>
      stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: PAGE_SIZE,
        starting_after: startingAfter,
      }),
    );

    truncated = truncated || subscriptions.truncated;

    for (const entry of subscriptions.items) {
      /*
       * Another account on the same email is not this account. Subscriptions
       * found through a sibling customer only count when Stripe was told who
       * they were bought for, which is the same tag the checkout sets.
       */
      if (
        customerId !== ownCustomerId &&
        entry.metadata?.clerkUserId !== clerkUserId
      ) {
        continue;
      }

      if (planFor(entry.status) === "paid") return "paid";
    }
  }

  return truncated ? undefined : "free";
}
