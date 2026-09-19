import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";

export const STRIPE_WEBHOOK_PROCESSED_TTL_SECONDS =
  35 * 24 * 60 * 60;

export const STRIPE_WEBHOOK_PROCESSING_TTL_SECONDS = 5 * 60;

export const STRIPE_WEBHOOK_LOCK_TTL_SECONDS = 60;

const COMPLETE_EVENT_SCRIPT = `
local owner = redis.call('GET', KEYS[1])

if owner ~= ARGV[1] then
  return 0
end

redis.call('SET', KEYS[1], 'processed', 'EX', ARGV[2])
return 1
`;

const RELEASE_EVENT_SCRIPT = `
local owner = redis.call('GET', KEYS[1])

if owner ~= ARGV[1] then
  return 0
end

return redis.call('DEL', KEYS[1])
`;

const RELEASE_LOCK_SCRIPT = `
local owner = redis.call('GET', KEYS[1])

if owner ~= ARGV[1] then
  return 0
end

return redis.call('DEL', KEYS[1])
`;

export interface StripeWebhookEventClaim {
  acquired: boolean;
  processed: boolean;
  complete: () => Promise<void>;
  release: () => Promise<void>;
}

export interface StripeWebhookLock {
  acquired: boolean;
  release: () => Promise<void>;
}

export function stripeWebhookRedisConfigured(): boolean {
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

function processedEventKey(eventId: string): string {
  return `stripe:webhook:event:${eventId}`;
}

function subscriptionLockKey(subscriptionId: string): string {
  return `stripe:webhook:lock:${subscriptionId}`;
}

export async function claimStripeWebhookEvent(
  eventId: string,
): Promise<StripeWebhookEventClaim> {
  const client = redis();
  const key = processedEventKey(eventId);
  const owner = `processing:${randomUUID()}`;

  const result = await client.set(
    key,
    owner,
    {
      nx: true,
      ex: STRIPE_WEBHOOK_PROCESSING_TTL_SECONDS,
    },
  );

  const acquired = result === "OK";

  if (!acquired) {
    const current = await client.get(key);

    return {
      acquired: false,
      processed: current === "processed",
      complete: async () => {},
      release: async () => {},
    };
  }

  let completed = false;
  let released = false;

  return {
    acquired: true,
    processed: false,

    complete: async () => {
      if (completed || released) return;
      completed = true;

      try {
        await client.eval(
          COMPLETE_EVENT_SCRIPT,
          [key],
          [
            owner,
            STRIPE_WEBHOOK_PROCESSED_TTL_SECONDS,
          ],
        );
      } catch {
        // The processing record remains under its finite TTL.
      }
    },

    release: async () => {
      if (completed || released) return;
      released = true;

      try {
        await client.eval(
          RELEASE_EVENT_SCRIPT,
          [key],
          [owner],
        );
      } catch {
        // The finite processing TTL remains the recovery mechanism.
      }
    },
  };
}

export async function acquireStripeSubscriptionLock(
  subscriptionId: string,
): Promise<StripeWebhookLock> {
  const client = redis();
  const key = subscriptionLockKey(subscriptionId);
  const owner = randomUUID();

  const result = await client.set(
    key,
    owner,
    {
      nx: true,
      ex: STRIPE_WEBHOOK_LOCK_TTL_SECONDS,
    },
  );

  const acquired = result === "OK";

  if (!acquired) {
    return {
      acquired: false,
      release: async () => {},
    };
  }

  let released = false;

  return {
    acquired: true,

    release: async () => {
      if (released) return;
      released = true;

      try {
        await client.eval(
          RELEASE_LOCK_SCRIPT,
          [key],
          [owner],
        );
      } catch {
        // The lock's finite TTL remains the recovery mechanism.
      }
    },
  };
}