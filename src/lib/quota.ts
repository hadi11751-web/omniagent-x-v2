import { Redis } from "@upstash/redis";
import { currentUser } from "@clerk/nextjs/server";
import {
  FREE_DAILY_LIMIT,
  FREE_DAILY_MEMORY_RUNS,
  FREE_DAILY_TRANSCRIPTIONS,
} from "@/lib/limits";

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

/** Plan is stored in the Clerk user's public metadata, set by the Stripe webhook. */
export type Plan = "free" | "paid";

export async function getPlan(): Promise<Plan> {
  const user = await currentUser();
  const plan = user?.publicMetadata?.plan;
  return plan === "paid" ? "paid" : "free";
}

/*
 * Which calendar day a counter belongs to. "Daily" on the pricing page is the
 * user's day, not UTC's, so a deployment can name the minutes its users are
 * ahead of or behind UTC and the allowance turns over at their midnight instead
 * of London's. Changing it mid-day moves every counter to a fresh key, which is
 * a config change an operator makes once, not something to schedule.
 */
function day(): string {
  return new Date(Date.now() + dayOffsetMinutes() * 60_000)
    .toISOString()
    .slice(0, 10);
}

function dayOffsetMinutes(): number {
  const raw = Number(process.env.USAGE_DAY_OFFSET_MINUTES ?? "0");

  if (!Number.isFinite(raw)) return 0;

  return Math.max(-1439, Math.min(1439, Math.trunc(raw)));
}

function todayKey(userId: string): string {
  return `usage:${userId}:${day()}`;
}

export interface QuotaReservation {
  allowed: boolean;
  remaining: number;
  limit: number | null;
}

/** The model-calling routes that bill no chat message but still cost money. */
export type DailyCap = "memory" | "transcribe";

const DAILY_CAPS: Record<DailyCap, number> = {
  memory: FREE_DAILY_MEMORY_RUNS,
  transcribe: FREE_DAILY_TRANSCRIPTIONS,
};

function capKey(userId: string, scope: DailyCap): string {
  return `cap:${scope}:${userId}:${day()}`;
}

/**
 * In-process usage counters used when Upstash is not configured. Per-instance
 * rather than global, so it is weaker than Redis, but it is still a ceiling:
 * returning "allowed" for an unconfigured deployment meant forgetting the
 * Upstash environment variables removed the daily limit entirely.
 */
const localCounts = new Map<string, number>();

export function resetLocalQuota(): void {
  localCounts.clear();
}

function consumeLocal(key: string): number {
  const count = (localCounts.get(key) ?? 0) + 1;
  localCounts.set(key, count);
  return count;
}

async function consumeCounted(key: string): Promise<number> {
  if (!redisConfigured()) return consumeLocal(key);

  const client = redis();
  const count = await client.incr(key);

  if (count === 1) {
    await client.expire(key, 60 * 60 * 26);
  }

  return count;
}

async function refundCounted(key: string): Promise<void> {
  if (!redisConfigured()) {
    const local = localCounts.get(key) ?? 0;

    if (local <= 0) return;

    if (local === 1) {
      localCounts.delete(key);
    } else {
      localCounts.set(key, local - 1);
    }

    return;
  }

  const client = redis();
  const current = await client.get<number>(key);

  if (typeof current !== "number" || current <= 0) return;

  await client.decr(key);
}

/*
 * Take one unit, and put it straight back if it went over the ceiling.
 *
 * Counting has to happen before deciding, so an attempt the ceiling refuses had
 * already spent a unit of an allowance it never got to use - and nothing handed
 * it back, because the route returns a rejection before `endRun()` ever runs.
 * Each refused try therefore pushed the counter one further above the limit, so
 * an account that had sent 19 messages could be locked out by its own rejected
 * attempts, and the one refund a genuine in-flight failure did get back was spent
 * cancelling a refusal rather than restoring a message.
 */
async function consumeUpTo(key: string, limit: number): Promise<number> {
  const count = await consumeCounted(key);

  if (count > limit) await refundCounted(key);

  return count;
}

/**
 * Reserves one free message. A failed request can later refund that
 * reservation with refundQuota(), so transient provider failures do not
 * consume a user's daily allowance.
 *
 * `plan` is the caller's answer from earlier in the same request. Looking the
 * plan up is an account API call, and one message used to make two or three of
 * them - consume, cap, refund - so a request that has already resolved it says
 * so instead of asking again.
 */
export async function checkAndConsumeQuota(
  userId: string,
  plan?: Plan,
): Promise<QuotaReservation> {
  if ((plan ?? (await getPlan())) === "paid") {
    return { allowed: true, remaining: Infinity, limit: null };
  }

  const count = await consumeUpTo(todayKey(userId), FREE_DAILY_LIMIT);

  return {
    allowed: count <= FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - count),
    limit: FREE_DAILY_LIMIT,
  };
}

/** Refunds a reserved message when no usable output was produced. */
export async function refundQuota(
  userId: string,
  plan?: Plan,
): Promise<void> {
  if ((plan ?? (await getPlan())) === "paid") return;

  await refundCounted(todayKey(userId));
}

/** Reserves one run against a route's own daily ceiling. */
export async function checkDailyCap(
  userId: string,
  scope: DailyCap,
  plan?: Plan,
): Promise<QuotaReservation> {
  const limit = DAILY_CAPS[scope];

  if ((plan ?? (await getPlan())) === "paid") {
    return { allowed: true, remaining: Infinity, limit };
  }

  const count = await consumeUpTo(capKey(userId, scope), limit);

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    limit,
  };
}

export async function refundDailyCap(
  userId: string,
  scope: DailyCap,
  plan?: Plan,
): Promise<void> {
  if ((plan ?? (await getPlan())) === "paid") return;

  await refundCounted(capKey(userId, scope));
}
