import { NextResponse } from "next/server";
import Stripe from "stripe";
import { clerkClient } from "@clerk/nextjs/server";
import {
  acquireStripeSubscriptionLock,
  claimStripeWebhookEvent,
  stripeWebhookRedisConfigured,
} from "@/lib/stripeWebhook";

export const runtime = "nodejs";

async function setPlan(clerkUserId: string, plan: "free" | "paid") {
  const client = await clerkClient();
  await client.users.updateUserMetadata(clerkUserId, { publicMetadata: { plan } });
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

  const relevantEvent =
    event.type === "checkout.session.completed" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted";

  if (!relevantEvent) {
    return NextResponse.json({ received: true });
  }

  const eventClaim = stripeWebhookRedisConfigured()
    ? await claimStripeWebhookEvent(event.id)
    : null;

  if (eventClaim && !eventClaim.acquired) {
    if (eventClaim.processed) {
      return NextResponse.json({ received: true });
    }

    return NextResponse.json(
      { error: "webhook event is already being processed" },
      { status: 409 },
    );
  }

  const subscriptionId =
    event.type === "checkout.session.completed"
      ? (() => {
          const session = event.data.object as Stripe.Checkout.Session;
          return typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id ?? null;
        })()
      : event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted"
        ? (event.data.object as Stripe.Subscription).id
        : null;

  const subscriptionLock =
    subscriptionId && stripeWebhookRedisConfigured()
      ? await acquireStripeSubscriptionLock(subscriptionId)
      : null;

  if (subscriptionLock && !subscriptionLock.acquired) {
    await eventClaim?.release();

    return NextResponse.json(
      { error: "subscription webhook is already being processed" },
      { status: 409 },
    );
  }

  try {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const fallbackUserId = session.client_reference_id;
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id;

      let resolvedUserId = fallbackUserId;
      let plan: "free" | "paid" = "paid";

      if (subscriptionId) {
        const subscription =
          await stripe.subscriptions.retrieve(subscriptionId);

        resolvedUserId =
          subscription.metadata?.clerkUserId ?? resolvedUserId;

        const stillActive =
          subscription.status === "active" ||
          subscription.status === "trialing";

        plan = stillActive ? "paid" : "free";
      }

      if (resolvedUserId) {
        await setPlan(resolvedUserId, plan);
      }

      break;
    }
    case "customer.subscription.deleted":
    case "customer.subscription.updated": {
      const eventSubscription =
        event.data.object as Stripe.Subscription;

      let resolvedUserId =
        eventSubscription.metadata?.clerkUserId;
      let plan: "free" | "paid";

      if (event.type === "customer.subscription.deleted") {
        plan = "free";
      } else {
        const currentSubscription =
          await stripe.subscriptions.retrieve(eventSubscription.id);

        resolvedUserId =
          currentSubscription.metadata?.clerkUserId ??
          resolvedUserId;

        const stillActive =
          currentSubscription.status === "active" ||
          currentSubscription.status === "trialing";

        plan = stillActive ? "paid" : "free";
      }

      if (resolvedUserId) {
        await setPlan(resolvedUserId, plan);
      }

      break;
    }
    default:
      // Other event types aren't relevant to plan status; ignore them.
      break;
  }


    await eventClaim?.complete();

    return NextResponse.json({ received: true });
  } catch (error) {
    await eventClaim?.release();
    throw error;
  } finally {
    await subscriptionLock?.release();
  }
}

