import { Redis } from "@upstash/redis";
import {
  cosineSimilarity,
  createEmbedding,
} from "@/lib/server/embeddings";

const MAX_MEMORIES = 100;
const MAX_FACT_LENGTH = 500;
const MAX_RETRIEVED = 8;
const MAX_QUERY_LENGTH = 1_000;

export interface StoredMemory {
  id: string;
  fact: string;
  createdAt: number;
  updatedAt: number;
  sourceConversationId?: string;
  keywords?: string[];
  embedding?: number[];
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

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
}

function normalizeKeywords(keywords: unknown): string[] {
  if (!Array.isArray(keywords)) {
    return [];
  }

  return [
    ...new Set(
      keywords
        .filter(
          (keyword): keyword is string =>
            typeof keyword === "string",
        )
        .map((keyword) =>
          keyword
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80),
        )
        .filter(Boolean),
    ),
  ].slice(0, 20);
}

function memoryScore(
  memory: StoredMemory,
  queryTokens: Set<string>,
): number {
  const factTokens = tokenize(memory.fact);

  const keywordTokens = tokenize(
    (memory.keywords ?? []).join(" "),
  );

  let factOverlap = 0;
  let keywordOverlap = 0;

  for (const token of queryTokens) {
    if (factTokens.has(token)) {
      factOverlap += 1;
    }

    if (keywordTokens.has(token)) {
      keywordOverlap += 1;
    }
  }

  return factOverlap + keywordOverlap * 1.5;
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

  if (!ids.length) {
    return [];
  }

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
  keywords: string[] = [],
  embedding?: number[],
): Promise<StoredMemory | null> {
  const normalized = normalizeFact(fact);

  if (!normalized) {
    return null;
  }

  const normalizedKeywords =
    normalizeKeywords(keywords);

  const memories = await listMemories(userId);

  const duplicate = memories.find(
    (memory) =>
      memory.fact.toLowerCase() ===
      normalized.toLowerCase(),
  );

  const now = Date.now();
  const redis = getRedis();

  if (duplicate) {
    const updated: StoredMemory = {
      ...duplicate,
      fact: normalized,
      updatedAt: now,
      sourceConversationId:
        sourceConversationId ??
        duplicate.sourceConversationId,
      keywords:
        normalizedKeywords.length > 0
          ? normalizedKeywords
          : duplicate.keywords,
      embedding:
        embedding && embedding.length > 0
          ? embedding
          : duplicate.embedding,
    };

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
    keywords: normalizedKeywords,
    ...(embedding && embedding.length > 0
      ? { embedding }
      : {}),
  };

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
      await redis.del(
        memoryKey(userId, item.id),
      );

      await redis.zrem(
        memoryIndexKey(userId),
        item.id,
      );
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

  for (const item of facts.slice(
    0,
    MAX_MEMORIES,
  )) {
    const fact =
      typeof item === "string"
        ? item
        : "";

    const memory = await saveMemory(
      userId,
      fact,
      sourceConversationId,
    );

    if (memory) {
      saved.push(memory);
    }
  }

  return saved;
}

export async function saveExtractedMemories(
  userId: string,
  entries: Array<{
    fact: string;
    keywords?: string[];
  }>,
  sourceConversationId?: string,
): Promise<StoredMemory[]> {
  const saved: StoredMemory[] = [];

  for (const entry of entries.slice(
    0,
    MAX_MEMORIES,
  )) {
    let embedding: number[] | undefined;

    try {
      const embeddingInput = [
        entry.fact,
        ...(entry.keywords ?? []),
      ].join("\n");

      const generated = await createEmbedding(
        embeddingInput,
      );

      embedding =
        generated.length > 0
          ? generated
          : undefined;
    } catch {
      embedding = undefined;
    }

    const memory = await saveMemory(
      userId,
      entry.fact,
      sourceConversationId,
      entry.keywords ?? [],
      embedding,
    );

    if (memory) {
      saved.push(memory);
    }
  }

  return saved;
}

export async function getRelevantMemories(
  userId: string,
  query: string,
): Promise<StoredMemory[]> {
  const normalizedQuery = query
    .trim()
    .slice(0, MAX_QUERY_LENGTH);

  if (!normalizedQuery) {
    return [];
  }

  const memories = await listMemories(userId);

  if (!memories.length) {
    return [];
  }

  const queryTokens = tokenize(normalizedQuery);

  let queryEmbedding: number[] = [];

  try {
    const generated =
      await createEmbedding(normalizedQuery);

    queryEmbedding =
      Array.isArray(generated)
        ? generated
        : [];
  } catch {
    queryEmbedding = [];
  }

  const hasLexicalQuery = queryTokens.size > 0;
  const hasSemanticQuery = queryEmbedding.length > 0;

  if (!hasLexicalQuery && !hasSemanticQuery) {
    return [];
  }

  return memories
    .map((memory) => {
      const lexicalScore = hasLexicalQuery
        ? memoryScore(memory, queryTokens)
        : 0;

      const semanticScore =
        hasSemanticQuery &&
        memory.embedding &&
        memory.embedding.length ===
          queryEmbedding.length
          ? cosineSimilarity(
              queryEmbedding,
              memory.embedding,
            )
          : 0;

      return {
        memory,
        lexicalScore,
        semanticScore,
        score:
          semanticScore > 0
            ? semanticScore * 10 + lexicalScore
            : lexicalScore,
      };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.memory.updatedAt -
          a.memory.updatedAt,
    )
    .slice(0, MAX_RETRIEVED)
    .map(({ memory }) => memory);
}



