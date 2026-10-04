"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";

export type PlanId = "free" | "paid";

type ClerkUser = ReturnType<typeof useUser>["user"];

function planOf(user: ClerkUser): PlanId | null {
  if (!user) {
    return null;
  }

  return user.publicMetadata?.plan === "paid" ? "paid" : "free";
}

/**
 * Marks the card matching the signed-in visitor's plan. Anonymous visitors get
 * nothing here, which is what keeps `/pricing` renderable as static output.
 */
export function CurrentPlanFlag({ which }: { which: PlanId }) {
  const { user, isLoaded } = useUser();

  if (!isLoaded || planOf(user) !== which) {
    return null;
  }

  return (
    <span className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-[var(--accent)]/50 bg-[var(--accent)]/10 px-2.5 py-1 text-[11px] font-medium">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent2)]" />
      {which === "paid" ? "Your active plan" : "You're on this plan"}
    </span>
  );
}

const CTA_CLASS =
  "mt-6 block rounded-xl border border-[var(--border)] px-4 py-2.5 text-center font-medium transition hover:border-[var(--accent)]";

/**
 * What an anonymous visitor sees, and also the markup emitted during
 * prerendering: `useUser()` reports `isLoaded: false` on the server, so this is
 * rendered until the client has a session to check. Keeping it identical on the
 * server and on the first client paint avoids a hydration mismatch while making
 * the links work without JavaScript.
 */
function SignedOutCallToAction({ which }: { which: PlanId }) {
  return (
    <Link href="/sign-up" className={CTA_CLASS}>
      {which === "paid" ? "Start free, upgrade any time" : "Create a free account"}
    </Link>
  );
}

/**
 * The card button. Signed-out visitors are sent to sign-up; signed-in ones get
 * the real actions: the existing Stripe checkout session for an upgrade, or a
 * Stripe customer-portal link to change or cancel.
 */
export function PlanCallToAction({ which }: { which: PlanId }) {
  const { user, isLoaded } = useUser();
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const plan = isLoaded ? planOf(user) : null;

  const open = (path: string) => async () => {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(path, { method: "POST" });
      const data = (await response.json()) as { url?: string; error?: string };

      if (!response.ok || !data.url) {
        throw new Error(data.error ?? "that didn't work, please try again");
      }

      window.location.href = data.url;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const button = (label: string) => (busy ? "Loading..." : label);

  if (!mounted) {
    return <SignedOutCallToAction which={which} />;
  }

  if (!isLoaded) {
    return (
      <span className="mt-6 block h-[42px] rounded-xl border border-[var(--border)] bg-[var(--surface-2)]" />
    );
  }

  if (!plan) {
    return <SignedOutCallToAction which={which} />;
  }

  if (which === "free") {
    return (
      <Link href="/" className={CTA_CLASS}>
        Open the app
      </Link>
    );
  }

  if (plan === "paid") {
    return (
      <div className="mt-6">
        <button
          type="button"
          onClick={open("/api/stripe/portal")}
          disabled={busy}
          className="w-full rounded-xl border border-[var(--border)] px-4 py-2.5 font-medium transition hover:border-[var(--accent)] disabled:opacity-50"
        >
          {button("Manage subscription")}
        </button>
        <p className="mt-2 text-center text-xs text-[var(--muted)]">
          Update your card or cancel in Stripe&apos;s customer portal.
        </p>
        {error ? <p className="mt-2 text-center text-xs text-red-400">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={open("/api/stripe/checkout")}
        disabled={busy}
        className="w-full rounded-xl bg-gradient-to-r from-[var(--accent)] to-[var(--accent2)] px-4 py-2.5 font-medium text-black transition hover:opacity-90 disabled:opacity-50"
      >
        {button("Upgrade now")}
      </button>
      {error ? <p className="mt-2 text-center text-xs text-red-400">{error}</p> : null}
    </div>
  );
}
