import { Redis } from "@upstash/redis";

const MAX_CONVERSATIONS = 200;
const MAX_MESSAGES = 500;
const MAX_CONTENT_LENGTH = 100_000;

export interface StoredConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  [key: string]: unknown;
}

export interface StoredConversation {
  id: string;
  title: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredConversationMessage[];
}

function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "Persistent conversations require UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN",
    );
  }

  return new Redis({ url, token });
}

function conversationKey(userId: string, conversationId: string): string {
  return `omniagent:conversation:${userId}:${conversationId}`;
}

function indexKey(userId: string): string {
  return `omniagent:conversations:${userId}`;
}

function assertConversationId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    throw new Error("invalid conversation id");
  }
}

function normalizeConversation(
  conversation: StoredConversation,
): StoredConversation {
  if (!conversation.id || !conversation.title || !conversation.projectId) {
    throw new Error("invalid conversation");
  }

  assertConversationId(conversation.id);

  if (!Array.isArray(conversation.messages)) {
    throw new Error("invalid messages");
  }

  if (conversation.messages.length > MAX_MESSAGES) {
    throw new Error(`conversation exceeds ${MAX_MESSAGES} messages`);
  }

  const messages = conversation.messages.map((message) => {
    if (
      !message ||
      typeof message.id !== "string" ||
      !/^(user|assistant)$/.test(message.role) ||
      typeof message.content !== "string" ||
      typeof message.createdAt !== "number"
    ) {
      throw new Error("invalid conversation message");
    }

    if (message.content.length > MAX_CONTENT_LENGTH) {
      throw new Error("message content is too large");
    }

    return message;
  });

  return {
    ...conversation,
    title: conversation.title.slice(0, 200),
    projectId: conversation.projectId.slice(0, 100),
    messages,
    updatedAt: Date.now(),
  };
}

export async function listConversations(
  userId: string,
): Promise<StoredConversation[]> {
  const redis = getRedis();

  const ids = await redis.zrange(indexKey(userId), 0, MAX_CONVERSATIONS - 1, {
    rev: true,
  });

  if (!ids.length) return [];

  const conversations = await Promise.all(
    ids.map((id) =>
      redis.get<StoredConversation>(
        conversationKey(userId, String(id)),
      ),
    ),
  );

  return conversations
    .filter(
      (conversation): conversation is StoredConversation =>
        Boolean(conversation),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(
  userId: string,
  conversationId: string,
): Promise<StoredConversation | null> {
  assertConversationId(conversationId);
  const redis = getRedis();

  return redis.get<StoredConversation>(
    conversationKey(userId, conversationId),
  );
}

export async function saveConversation(
  userId: string,
  conversation: StoredConversation,
): Promise<StoredConversation> {
  const normalized = normalizeConversation(conversation);
  const redis = getRedis();

  await redis.set(
    conversationKey(userId, normalized.id),
    normalized,
  );

  await redis.zadd(indexKey(userId), {
    score: normalized.updatedAt,
    member: normalized.id,
  });

  return normalized;
}

export async function deleteConversation(
  userId: string,
  conversationId: string,
): Promise<void> {
  assertConversationId(conversationId);
  const redis = getRedis();

  await redis.del(conversationKey(userId, conversationId));
  await redis.zrem(indexKey(userId), conversationId);
}

export async function deleteAllConversations(
  userId: string,
): Promise<void> {
  const redis = getRedis();
  const conversations = await listConversations(userId);

  if (conversations.length) {
    await redis.del(
      ...conversations.map((conversation) =>
        conversationKey(userId, conversation.id),
      ),
    );
  }

  await redis.del(indexKey(userId));
}
