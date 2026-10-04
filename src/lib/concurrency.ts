import { Redis } from "@upstash/redis";
import {
  MAX_CONCURRENT_PER_USER,
  MAX_REQUEST_SECONDS,
} from "@/lib/limits";

/* Keep abandoned slots alive slightly beyond the maximum request lifetime so
 * the distributed counter cannot lapse while a legitimate request is still
 * streaming. */
const SLOT_TTL_SECONDS = MAX_REQUEST_SECONDS + 30;

const localSlots = new Map<string, LocalSlot[]>();

/**
 * A slot this process handed out, with the moment it stops counting.
 *
 * The Redis path stamps a TTL on the counter, so a slot whose request died
 * without releasing is reclaimed by the store. A plain count has no such
 * recovery, and a request that throws between taking a slot and reaching its
 * release would hold one forever: `MAX_CONCURRENT_PER_USER` leaks of those and
 * the account is shut out of every model route until the process restarts. Each
 * local slot therefore carries the same expiry the Redis key gets, and an
 * expired slot is dropped the next time anyone asks.
 */
interface LocalSlot {
  readonly expiresAt: number;
}

function liveLocalSlots(userId: string, now: number): LocalSlot[] {
  const held = localSlots.get(userId) ?? [];
  const live = held.filter((slot) => slot.expiresAt > now);

  if (live.length === 0) {
    localSlots.delete(userId);
  } else if (live.length !== held.length) {
    localSlots.set(userId, live);
  }

  return live;
}

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

function redisKey(userId: string): string {
  return `concurrency:${userId}`;
}

const ACQUIRE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

if current >= limit then
  return 0
end

redis.call('SET', KEYS[1], current + 1)
-- Refresh on every acquire: /api/chat can run for maxDuration seconds, so a
-- slot whose TTL was only stamped by the first request in a busy window could
-- lapse while that request was still streaming, letting the user exceed the limit.
redis.call('EXPIRE', KEYS[1], ttl)

return 1
`;

const RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')

if current <= 1 then
  redis.call('DEL', KEYS[1])
  return 0
end

return redis.call('DECR', KEYS[1])
`;

export interface ConcurrencyLease {
  acquired: boolean;
  limit: number;
  release: () => Promise<void>;
}

async function acquireRedis(
  userId: string,
): Promise<ConcurrencyLease> {
  const client = redis();
  const key = redisKey(userId);

  const result = await client.eval(
    ACQUIRE_SCRIPT,
    [key],
    [MAX_CONCURRENT_PER_USER, SLOT_TTL_SECONDS],
  );

  const acquired = Number(result) === 1;

  if (!acquired) {
    return {
      acquired: false,
      limit: MAX_CONCURRENT_PER_USER,
      release: async () => {},
    };
  }

  let released = false;

  return {
    acquired: true,
    limit: MAX_CONCURRENT_PER_USER,
    release: async () => {
      if (released) return;
      released = true;

      try {
        await client.eval(
          RELEASE_SCRIPT,
          [key],
          [],
        );
      } catch {
        // TTL remains as the recovery mechanism.
      }
    },
  };
}

function acquireLocal(
  userId: string,
): ConcurrencyLease {
  const now = Date.now();
  const held = liveLocalSlots(userId, now);

  if (held.length >= MAX_CONCURRENT_PER_USER) {
    return {
      acquired: false,
      limit: MAX_CONCURRENT_PER_USER,
      release: async () => {},
    };
  }

  const slot: LocalSlot = { expiresAt: now + SLOT_TTL_SECONDS * 1000 };

  localSlots.set(userId, [...held, slot]);

  let released = false;

  return {
    acquired: true,
    limit: MAX_CONCURRENT_PER_USER,
    release: async () => {
      if (released) return;
      released = true;

      const current = liveLocalSlots(userId, Date.now());
      const index = current.indexOf(slot);

      if (index === -1) return;

      const remaining = current.slice();

      remaining.splice(index, 1);

      if (remaining.length === 0) {
        localSlots.delete(userId);
      } else {
        localSlots.set(userId, remaining);
      }
    },
  };
}

export async function acquireConcurrency(
  userId: string,
): Promise<ConcurrencyLease> {
  if (!redisConfigured()) {
    return acquireLocal(userId);
  }

  try {
    return await acquireRedis(userId);
  } catch {
    return acquireLocal(userId);
  }
}

export function resetLocalConcurrency(): void {
  localSlots.clear();
}

export const CONCURRENCY_LIMIT =
  MAX_CONCURRENT_PER_USER;

export const CONCURRENCY_TTL_SECONDS =
  SLOT_TTL_SECONDS;
