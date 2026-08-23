import { NextResponse } from "next/server";
import Stripe from "stripe";
import { auth, currentUser } from "@clerk/nextjs/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!secretKey || !priceId) {
    return NextResponse.json({ error: "billing isn't configured on the server yet" }, { status: 503 });
  }

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress;
  const origin = new URL(request.url).origin;

  const stripe = new Stripe(secretKey);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: email,
    // Carried through to the webhook so we know which Clerk user to upgrade
    // — Stripe has no idea what a "Clerk user" is on its own. Attaching it
    // to the subscription (not just the session) means cancellation events
    // later can find the right user with no separate database lookup.
    client_reference_id: userId,
    subscription_data: { metadata: { clerkUserId: userId } },
    success_url: `${origin}/?upgraded=1`,
    cancel_url: `${origin}/?upgrade=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}

