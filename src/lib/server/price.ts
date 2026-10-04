import Stripe from "stripe";

export interface PlanPrice {
  /** Amount in the currency's minor units, exactly as Stripe stores it. */
  unitAmount: number;
  currency: string;
  /** "month" | "week" | "year", from the subscription the price recurs on. */
  interval: string;
}

/**
 * Reads the amount of the subscription the server is already selling
 * (`STRIPE_PRICE_ID`, the same price `/api/stripe/checkout` creates a session
 * for) so the public pricing page displays the real figure instead of a
 * hard-coded copy. Returns null when billing has no keys yet or Stripe cannot
 * be reached; the page then says the price is shown at checkout.
 */
export async function readPlanPrice(): Promise<PlanPrice | null> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;

  if (!secretKey || !priceId) {
    return null;
  }

  try {
    const stripe = new Stripe(secretKey);
    const price = await stripe.prices.retrieve(priceId);

    // `/api/stripe/checkout` creates a session with `mode: "subscription"`, and
    // Stripe rejects a one-off price for that mode. Showing an amount the
    // upgrade path cannot charge would be worse than showing none at all.
    if (!price.active || !price.recurring || typeof price.unit_amount !== "number") {
      return null;
    }

    return {
      unitAmount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring.interval,
    };
  } catch (error) {
    console.error("pricing_page_price_lookup_failed", error);
    return null;
  }
}
