import { Redis } from "@upstash/redis";

const MAX_MEMORIES = 100;
const MAX_FACT_LENGTH = 500;
const MAX_RETRIEVED = 8;

export interface StoredMemory {
  id: string;
  fact: string;
  createdAt: number;
  updatedAt: number;
  sourceConversationId?: string;
}

function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Automatic memory requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN",
    );
  }

  return new Redis({ url, token });
}

function memoryIndexKey(userId: string): string {
  return `omniagent:memory:index:${userId}`;
}

function memoryKey(userId: string, id: string): string {
  return `omniagent:memory:${userId}:${id}`;
}

function normalizeFact(fact: string): string {
  return fact
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_FACT_LENGTH);
}

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
}

export async function listMemories(
  userId: string,
): Promise<StoredMemory[]> {
  const redis = getRedis();

  const ids = await redis.zrange(
    memoryIndexKey(userId),
    0,
    MAX_MEMORIES - 1,
    { rev: true },
  );

  if (!ids.length) return [];

  const memories = await Promise.all(
    ids.map((id) =>
      redis.get<StoredMemory>(
        memoryKey(userId, String(id)),
      ),
    ),
  );

  return memories
    .filter(
      (memory): memory is StoredMemory =>
        Boolean(memory),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveMemory(
  userId: string,
  fact: string,
  sourceConversationId?: string,
): Promise<StoredMemory | null> {
  const normalized = normalizeFact(fact);
  if (!normalized) return null;

  const memories = await listMemories(userId);

  const duplicate = memories.find(
    (memory) =>
      memory.fact.toLowerCase() === normalized.toLowerCase(),
  );

  const now = Date.now();

  if (duplicate) {
    const updated: StoredMemory = {
      ...duplicate,
      fact: normalized,
      updatedAt: now,
      sourceConversationId:
        sourceConversationId ?? duplicate.sourceConversationId,
    };

    const redis = getRedis();

    await redis.set(
      memoryKey(userId, updated.id),
      updated,
    );

    await redis.zadd(memoryIndexKey(userId), {
      score: updated.updatedAt,
      member: updated.id,
    });

    return updated;
  }

  const id = crypto.randomUUID();

  const memory: StoredMemory = {
    id,
    fact: normalized,
    createdAt: now,
    updatedAt: now,
    sourceConversationId,
  };

  const redis = getRedis();

  await redis.set(
    memoryKey(userId, id),
    memory,
  );

  await redis.zadd(memoryIndexKey(userId), {
    score: now,
    member: id,
  });

  const all = await listMemories(userId);

  if (all.length > MAX_MEMORIES) {
    const stale = all.slice(MAX_MEMORIES);

    for (const item of stale) {
      await redis.del(memoryKey(userId, item.id));
      await redis.zrem(memoryIndexKey(userId), item.id);
    }
  }

  return memory;
}

export async function saveMemories(
  userId: string,
  facts: string[],
  sourceConversationId?: string,
): Promise<StoredMemory[]> {
  const saved: StoredMemory[] = [];

  for (const fact of facts.slice(0, MAX_MEMORIES)) {
    const memory = await saveMemory(
      userId,
      fact,
      sourceConversationId,
    );

    if (memory) saved.push(memory);
  }

  return saved;
}

export async function getRelevantMemories(
  userId: string,
  query: string,
): Promise<StoredMemory[]> {
  const memories = await listMemories(userId);

  if (!memories.length || !query.trim()) return [];

  const queryTokens = tokenise(query);

  const ranked = memories
    .map((memory) => {
      const factTokens = tokenise(memory.fact);

      let overlap = 0;

      for (const token of queryTokens) {
        if (factTokens.has(token)) overlap += 1;
      }

      return {
        memory,
        score: overlap,
      };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return ranked
    .slice(0, MAX_RETRIEVED)
    .map(({ memory }) => memory);
}
