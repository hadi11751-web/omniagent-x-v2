import type { Conversation } from "./types";

interface ConversationResponse {
  conversation: Conversation;
}

interface ConversationListResponse {
  conversations: Conversation[];
}

export async function loadServerConversations(): Promise<Conversation[]> {
  const response = await fetch("/api/conversations", {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`failed to load conversations: ${response.status}`);
  }

  const data = (await response.json()) as ConversationListResponse;
  return data.conversations;
}

export async function saveServerConversation(
  conversation: Conversation,
): Promise<Conversation> {
  const response = await fetch("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...conversation,
      updatedAt: Date.now(),
      // The server requires a numeric stamp per message; backfill older local
      // history without rewriting timestamps the client already knows.
      messages: conversation.messages.map((message) => ({
        ...message,
        createdAt: message.createdAt ?? Date.now(),
      })),
    }),
  });

  if (!response.ok) {
    throw new Error(`failed to save conversation: ${response.status}`);
  }

  const data = (await response.json()) as ConversationResponse;
  return data.conversation;
}

export async function deleteServerConversation(
  conversationId: string,
): Promise<void> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "DELETE",
    },
  );

  // A row that is already gone satisfies the deletion, so the caller can stop
  // asking and forget the tombstone.
  if (!response.ok && response.status !== 404) {
    throw new Error(`failed to delete conversation: ${response.status}`);
  }
}

export async function deleteAllServerConversations(): Promise<void> {
  const response = await fetch("/api/conversations", {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`failed to delete conversations: ${response.status}`);
  }
}
