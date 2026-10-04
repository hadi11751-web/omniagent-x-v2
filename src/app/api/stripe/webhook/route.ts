import { NextResponse } from "next/server";
import Stripe from "stripe";
import { clerkClient } from "@clerk/nextjs/server";
import {
  claimEvent,
  markEventHandled,
  releaseEventClaim,
} from "@/lib/server/billing-events";
import { reconcilePlan, type ReconciledPlan } from "@/lib/server/billing-plan";

export const runtime = "nodejs";

async function setPlan(clerkUserId: string, plan: "free" | "paid") {
  const client = await clerkClient();
  await client.users.updateUserMetadata(clerkUserId, { publicMetadata: { plan } });
}

/**
 * Writes the plan for an account, or refuses to write one it could not confirm.
 * `undefined` from a reconciliation whose lists went on past the last page it
 * read has no answer in it: the safe thing is to leave this account exactly as
 * it is and let Stripe deliver again, not to switch a paying visitor to free.
 */
async function applyPlan(clerkUserId: string, plan: ReconciledPlan) {
  if (!plan) {
    throw new Error(
      "the account's subscriptions could not be read to the end",
    );
  }

  await setPlan(clerkUserId, plan);
}

export async function POST(request: Request) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    return NextResponse.json({ error: "billing isn't configured on the server yet" }, { status: 503 });
  }

  // Stripe signs the RAW request body, so this must not be JSON-parsed
  // before verification — parsing first would invalidate the signature.
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing stripe-signature header" }, { status: 400 });

  const stripe = new Stripe(secretKey);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    return NextResponse.json({ error: `signature verification failed: ${(error as Error).message}` }, { status: 400 });
  }

  if (!(await claimEvent(event.id))) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const clerkUserId = session.client_reference_id;
        if (!clerkUserId) break;

        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id;

        /*
         * "checkout finished" is not the same statement as "this subscription
         * is charging somebody", so the status is read back from Stripe rather
         * than trusted from the event body — a replayed or out-of-order
         * delivery carries the status as it was when Stripe wrote the event. If
         * the session carries no subscription id there is nothing to reconcile
         * against, and the payment status is the only signal available.
         */
        const plan: ReconciledPlan = subscriptionId
          ? await reconcilePlan(stripe, subscriptionId, clerkUserId)
          : session.payment_status === "paid"
            ? "paid"
            : "free";

        await applyPlan(clerkUserId, plan);
        break;
      }
      case "customer.subscription.deleted":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const clerkUserId = subscription.metadata?.clerkUserId;
        if (!clerkUserId) break;

        await applyPlan(
          clerkUserId,
          await reconcilePlan(stripe, subscription.id, clerkUserId),
        );
        break;
      }
      default:
        // Other event types aren't relevant to plan status; ignore them.
        break;
    }
  } catch (error) {
    /*
     * 502 so Stripe retries this delivery. The claim is given back first: a
     * Clerk or Stripe outage has to leave the replay path open, and the handler
     * is idempotent, so a retry is safe.
     */
    await releaseEventClaim(event.id);

    return NextResponse.json({ error: `billing update failed: ${(error as Error).message}` }, { status: 502 });
  }

  await markEventHandled(event.id);

  return NextResponse.json({ received: true });
}
