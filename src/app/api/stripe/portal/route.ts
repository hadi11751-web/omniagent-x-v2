import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { billingEmail } from "@/lib/server/billingEmail";
import { createPortalUrl } from "@/lib/server/portal";

export const runtime = "nodejs";

/**
 * Hands a signed-in paid user a short-lived Stripe customer-portal link, which
 * is where they change their card or cancel. Sign-in is enforced by the
 * middleware allowlist plus the explicit check below.
 */
export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const user = await currentUser();
  const email = billingEmail(user);
  const origin = new URL(request.url).origin;

  const result = await createPortalUrl(email, `${origin}/pricing`);

  if ("url" in result) {
    return NextResponse.json({ url: result.url });
  }

  return NextResponse.json({ error: result.error }, { status: result.status });
}
