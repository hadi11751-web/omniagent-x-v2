import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { currentUser } from "@clerk/nextjs/server";

const FREE_DAILY_LIMIT = 20;
const QUOTA_TTL_SECONDS = 60 * 60 * 26;

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
export async function getPlan(): Promise<"free" | "paid"> {
  const user = await currentUser();
  const plan = user?.publicMetadata?.plan;
  return plan === "paid" ? "paid" : "free";
}

function todayKey(userId: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `usage:${userId}:${day}`;
}

function reservationKey(userId: string, reservationId: string): string {
  return `quota-reservation:${userId}:${reservationId}`;
}

const CONSUME_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

if current >= limit then
  return 0
end

local next = redis.call('INCR', KEYS[1])

if current == 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
end

redis.call('SET', KEYS[2], KEYS[1], 'EX', ttl)

return next
`;

const REFUND_SCRIPT = `
local usageKey = redis.call('GET', KEYS[1])

if not usageKey then
  return 0
end

if redis.call('DEL', KEYS[1]) ~= 1 then
  return 0
end

local current = tonumber(redis.call('GET', usageKey) or '0')

if current <= 0 then
  return 0
end

return redis.call('DECR', usageKey)
`;

export interface QuotaResult {
  allowed: boolean;
  remaining: number;
  limit: number | null;
  reservationId?: string;
}

/** Read-only quota check used to fail fast before charging anything. */
export async function peekQuota(userId: string): Promise<QuotaResult> {
  const plan = await getPlan();

  if (plan === "paid") {
    return { allowed: true, remaining: Infinity, limit: null };
  }

  if (!redisConfigured()) {
    return {
      allowed: true,
      remaining: FREE_DAILY_LIMIT,
      limit: FREE_DAILY_LIMIT,
    };
  }

  const count = Number((await redis().get(todayKey(userId))) ?? 0);

  return {
    allowed: count < FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - count),
    limit: FREE_DAILY_LIMIT,
  };
}

/**
 * Atomically reserves one free message only when the daily limit has not
 * already been reached. The reservation token makes any later refund belong
 * only to this exact request.
 */
export async function checkAndConsumeQuota(
  userId: string,
): Promise<QuotaResult> {
  const plan = await getPlan();

  if (plan === "paid") {
    return { allowed: true, remaining: Infinity, limit: null };
  }

  if (!redisConfigured()) {
    return {
      allowed: true,
      remaining: FREE_DAILY_LIMIT,
      limit: FREE_DAILY_LIMIT,
    };
  }

  const key = todayKey(userId);
  const reservationId = randomUUID();
  const reservation = reservationKey(userId, reservationId);
  const client = redis();

  const result = await client.eval(
    CONSUME_SCRIPT,
    [key, reservation],
    [FREE_DAILY_LIMIT, QUOTA_TTL_SECONDS],
  );

  const count = Number(result);

  if (count === 0) {
    return {
      allowed: false,
      remaining: 0,
      limit: FREE_DAILY_LIMIT,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, FREE_DAILY_LIMIT - count),
    limit: FREE_DAILY_LIMIT,
    reservationId,
  };
}

/** Best-effort atomic refund for this exact quota reservation. */
export async function refundQuota(
  userId: string,
  reservationId?: string,
): Promise<void> {
  try {
    const plan = await getPlan();

    if (plan === "paid" || !redisConfigured() || !reservationId) {
      return;
    }

    await redis().eval(
      REFUND_SCRIPT,
      [
        reservationKey(userId, reservationId),
        todayKey(userId),
      ],
      [],
    );
  } catch {
    // Refunding is a best-effort courtesy; never let it crash the request.
  }
}
