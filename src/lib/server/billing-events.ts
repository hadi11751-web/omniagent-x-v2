import { Redis } from "@upstash/redis";

/*
 * Stripe retries a failed delivery for hours afterwards, and the dashboard can
 * replay an event that was delivered weeks ago, so every billing handler has to
 * assume the same event arrives more than once - including two copies of it
 * arriving at the same moment, which a "have I seen this?" check followed by a
 * "now record that I have" answer cannot see at all. The claim below is one
 * atomic write: whoever wins it runs the handler, and the loser answers
 * "duplicate" without touching anyone's plan.
 */
const SEEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * How long a claim is held while the handler works. Well past the handful of
 * Stripe and Clerk calls one event makes, and short enough that a delivery cut
 * off mid-flight - a cold start killed, an instance recycled - is retried by
 * Stripe rather than silently lost behind a claim nobody still holds.
 */
const LEASE_SECONDS = 5 * 60;

/** Without Redis, the memory of delivered events is per-process and bounded. */
const MAX_LOCAL_EVENTS = 500;

function redisConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL &&
      process.env.UPSTASH_REDIS_REST_TOKEN,
  );
}

function redis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

function seenKey(eventId: string): string {
  return `stripe:seen:${eventId}`;
}

const localClaims = new Set<string>();

function claimLocally(eventId: string): boolean {
  if (localClaims.has(eventId)) return false;

  localClaims.add(eventId);

  if (localClaims.size > MAX_LOCAL_EVENTS) {
    // Sets iterate in insertion order, so this forgets the oldest id.
    const oldest = localClaims.values().next().value;

    if (oldest !== undefined) localClaims.delete(oldest);
  }

  return true;
}

/**
 * True when this delivery may run the handler. A Redis failure answers "yours"
 * on purpose: dropping a billing event because the cache is unreachable is
 * worse than applying it twice, and the plan writes are idempotent.
 */
export async function claimEvent(eventId: string): Promise<boolean> {
  if (!eventId) return true;

  if (!redisConfigured()) return claimLocally(eventId);

  try {
    const claimed = await redis().set<string>(seenKey(eventId), "1", {
      ex: LEASE_SECONDS,
      nx: true,
    });

    return claimed !== null;
  } catch {
    return true;
  }
}

/**
 * Extends the record of a claim from the lease into the month that a replay
 * needs. Local mode has nothing to do: the claim itself is the record.
 */
export async function markEventHandled(eventId: string): Promise<void> {
  if (!eventId || !redisConfigured()) return;

  try {
    await redis().set(seenKey(eventId), "1", { ex: SEEN_TTL_SECONDS });
  } catch {
    /*
     * The state is already correct, so failing here would only make Stripe
     * re-deliver an event that has been applied. The next replay pays for the
     * missing record.
     */
  }
}

/**
 * Gives the claim back after a handler that did not finish, so Stripe's retry of
 * the same delivery is treated as new work rather than a duplicate.
 */
export async function releaseEventClaim(eventId: string): Promise<void> {
  if (!eventId) return;

  if (!redisConfigured()) {
    localClaims.delete(eventId);
    return;
  }

  try {
    await redis().del(seenKey(eventId));
  } catch {
    /* The lease expires on its own; a retry may simply arrive sooner. */
  }
}

export function resetHandledEvents(): void {
  localClaims.clear();
}
