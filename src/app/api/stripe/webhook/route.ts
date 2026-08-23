import { NextResponse } from "next/server";
import Stripe from "stripe";
import { clerkClient } from "@clerk/nextjs/server";

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

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const clerkUserId = session.client_reference_id;
      if (clerkUserId) await setPlan(clerkUserId, "paid");
      break;
    }
    case "customer.subscription.deleted":
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const clerkUserId = subscription.metadata?.clerkUserId;
      if (clerkUserId) {
        const stillActive = subscription.status === "active" || subscription.status === "trialing";
        await setPlan(clerkUserId, stillActive ? "paid" : "free");
      }
      break;
    }
    default:
      // Other event types aren't relevant to plan status; ignore them.
      break;
  }

  return NextResponse.json({ received: true });
}

