import { Redis } from "@upstash/redis";

const MAX_CONCURRENT_PER_USER = 3;
const SLOT_TTL_SECONDS = 120;

const localCounts = new Map<string, number>();

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

local next = current + 1
redis.call('SET', KEYS[1], next)

if current == 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
end

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
  const count = localCounts.get(userId) ?? 0;

  if (count >= MAX_CONCURRENT_PER_USER) {
    return {
      acquired: false,
      limit: MAX_CONCURRENT_PER_USER,
      release: async () => {},
    };
  }

  localCounts.set(userId, count + 1);

  let released = false;

  return {
    acquired: true,
    limit: MAX_CONCURRENT_PER_USER,
    release: async () => {
      if (released) return;
      released = true;

      const current = localCounts.get(userId) ?? 0;

      if (current <= 1) {
        localCounts.delete(userId);
      } else {
        localCounts.set(userId, current - 1);
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
  localCounts.clear();
}

export const CONCURRENCY_LIMIT =
  MAX_CONCURRENT_PER_USER;

export const CONCURRENCY_TTL_SECONDS =
  SLOT_TTL_SECONDS;
