import { Redis } from "@upstash/redis";
import {
  MAX_CONVERSATIONS,
  MAX_CONVERSATION_JSON_CHARS,
  MAX_IMAGE_DATA_CHARS,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES,
  isImageDataUrl,
} from "@/lib/limits";

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

/**
 * The caller sent something this server refuses to store. Routes turn this into
 * a 400 so a Redis outage can keep its 500 — a client cannot retry its way out
 * of a bad body, but it can retry out of a bad database.
 */
export class ConversationValidationError extends Error {}

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
    throw new ConversationValidationError("invalid conversation id");
  }
}

/**
 * A shorter snapshot is refused on purpose. The browser that deleted a turn and
 * a browser that never received it send byte-identical prefixes, so accepting
 * the first would let a stale tab remove another device's newest turn from the
 * account for good. Regenerate does not hit this: it re-grows the turn it kept
 * before the debounced save runs.
 */
export function shouldReplaceStoredConversation(
  stored: StoredConversation,
  incoming: StoredConversation,
): boolean {
  if (incoming.messages.length !== stored.messages.length) {
    return incoming.messages.length > stored.messages.length;
  }

  const storedLastMessage = stored.messages.at(-1);
  const incomingLastMessage = incoming.messages.at(-1);
  const storedLast = storedLastMessage?.createdAt ?? stored.createdAt;
  const incomingLast = incomingLastMessage?.createdAt ?? incoming.createdAt;

  if (incomingLast !== storedLast) {
    return incomingLast > storedLast;
  }

  /*
   * Same length, same newest timestamp. When that newest message is the very
   * same one, this is the same writer's later state of it: an autosave can land
   * mid-run, and the sources, images, files or error that arrive afterwards
   * change the message without changing its id, text or time. Refusing that
   * write would keep the stale copy on the server and hand it back to the
   * browser, which would then drop what it had just received.
   *
   * A different message at the identical timestamp is an ambiguous concurrent
   * write from another tab or device, so what is already stored is kept.
   */
  if (storedLastMessage && incomingLastMessage) {
    return incomingLastMessage.id === storedLastMessage.id;
  }

  // Neither side has a message yet; only the title or project can differ.
  return true;
}

function normalizeConversation(
  conversation: StoredConversation,
): StoredConversation {
  /*
   * `StoredConversation` is a compile-time claim about JSON that arrived, so the
   * three fields this function calls string methods on are checked here. A
   * number in the `title` slot used to satisfy a truthiness test and then throw
   * `title.slice is not a function`, which the route could only report as a 500
   * for what was a malformed body.
   */
  const { id, title, projectId } = conversation;

  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof projectId !== "string" ||
    !id ||
    !title ||
    !projectId
  ) {
    throw new ConversationValidationError("invalid conversation");
  }

  assertConversationId(id);

  if (!Array.isArray(conversation.messages)) {
    throw new ConversationValidationError("invalid messages");
  }

  if (conversation.messages.length > MAX_MESSAGES) {
    throw new ConversationValidationError(`conversation exceeds ${MAX_MESSAGES} messages`);
  }

  const messages = conversation.messages.map((message) => {
    if (
      !message ||
      typeof message.id !== "string" ||
      !/^(user|assistant)$/.test(message.role) ||
      typeof message.content !== "string" ||
      typeof message.createdAt !== "number"
    ) {
      throw new ConversationValidationError("invalid conversation message");
    }

    if (message.content.length > MAX_MESSAGE_CHARS) {
      throw new ConversationValidationError("message content is too large");
    }

    if (message.images) {
      if (!Array.isArray(message.images) || message.images.length > MAX_IMAGES_PER_MESSAGE) {
        throw new ConversationValidationError("invalid conversation images");
      }

      for (const image of message.images) {
        if (
          typeof image !== "string" ||
          !isImageDataUrl(image) ||
          image.length > MAX_IMAGE_DATA_CHARS
        ) {
          throw new ConversationValidationError("conversation image is invalid or too large");
        }
      }
    }

    if (Array.isArray(message.files)) {
      for (const file of message.files) {
        if (
          !file ||
          typeof file !== "object" ||
          typeof (file as { dataUrl?: unknown }).dataUrl !== "string" ||
          (file as { dataUrl: string }).dataUrl.length > MAX_IMAGE_DATA_CHARS
        ) {
          throw new ConversationValidationError("conversation file is invalid or too large");
        }
      }
    }

    return message;
  });

  const normalized = {
    ...conversation,
    title: title.slice(0, 200),
    projectId: projectId.slice(0, 100),
    messages,
    updatedAt: Date.now(),
  };

  if (JSON.stringify(normalized).length > MAX_CONVERSATION_JSON_CHARS) {
    throw new ConversationValidationError("conversation is too large to persist");
  }

  return normalized;
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
  const key = conversationKey(userId, normalized.id);
  const existing = await redis.get<StoredConversation>(key);

  // A late request from an older tab/device must not erase messages that a
  // newer save already persisted. The comparison is message-based rather than
  // clock-based so small client/server clock skew cannot drop valid updates.
  if (existing && !shouldReplaceStoredConversation(existing, normalized)) {
    return existing;
  }

  await redis.set(key, normalized);

  await redis.zadd(indexKey(userId), {
    score: normalized.updatedAt,
    member: normalized.id,
  });

  // listConversations reads only the newest MAX_CONVERSATIONS entries, so keep
  // the index itself bounded — otherwise deleted-everywhere conversations
  // would linger in Redis and escape deleteAllConversations.
  const stale = await redis.zrange(indexKey(userId), MAX_CONVERSATIONS, -1, {
    rev: true,
  });

  if (stale.length) {
    const ids = stale.map((id) => String(id));

    await redis.del(...ids.map((id) => conversationKey(userId, id)));
    await redis.zrem(indexKey(userId), ...ids);
  }

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
