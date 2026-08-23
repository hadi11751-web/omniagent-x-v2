import { Redis } from "@upstash/redis";
import { currentUser } from "@clerk/nextjs/server";

const FREE_DAILY_LIMIT = 20;

function redisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function redis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

/** Plan is stored in the Clerk user's public metadata, set by the Stripe webhook. */
export async function getPlan(): Promise<"free" | "paid"> {
  const user = await currentUser();
  const plan = user?.publicMetadata?.plan;
  return plan === "paid" ? "paid" : "free";
}

function todayKey(userId: string): string {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, resets daily in UTC
  return `usage:${userId}:${day}`;
}

/**
 * Returns { allowed, remaining, limit }. Paid users are always allowed with
 * no counting at all. Free users are capped at FREE_DAILY_LIMIT messages
 * per UTC day. If Redis isn't configured, this fails open (allowed) rather
 * than breaking chat entirely for a missing optional feature.
 */
export async function checkAndConsumeQuota(userId: string): Promise<{
  allowed: boolean;
  remaining: number;
  limit: number | null;
}> {
  const plan = await getPlan();
  if (plan === "paid") return { allowed: true, remaining: Infinity, limit: null };

  if (!redisConfigured()) {
    // Rate limiting is optional infrastructure; don't take down chat for
    // everyone just because Redis env vars aren't set yet.
    return { allowed: true, remaining: FREE_DAILY_LIMIT, limit: FREE_DAILY_LIMIT };
  }

  const key = todayKey(userId);
  const client = redis();
  const count = await client.incr(key);
  if (count === 1) {
    await client.expire(key, 60 * 60 * 26); // a little over a day, covers timezone edge cases
  }

  return {
    allowed: count <= FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - count),
    limit: FREE_DAILY_LIMIT,
  };
}

