import type { ChatMessage } from "@/lib/types";

export interface ClientMemory {
  id: string;
  fact: string;
  createdAt: number;
  updatedAt: number;
  sourceConversationId?: string;
}

export async function saveAutomaticMemory(
  conversationId: string,
  messages: ChatMessage[],
  /**
   * True when the answer being remembered came from a local model. The server
   * will not use a cloud model to summarise it, so this is what keeps a local
   * conversation from leaving the machine one memory at a time.
   */
  localOnly = false,
): Promise<ClientMemory[]> {
  const response = await fetch("/api/memory", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      conversationId,
      messages,
      localOnly,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `automatic memory failed: ${response.status}`,
    );
  }

  const data = (await response.json()) as {
    memories?: ClientMemory[];
  };

  return data.memories ?? [];
}

/** Every fact the server currently remembers for this account. */
export async function listAutomaticMemories(): Promise<ClientMemory[]> {
  const response = await fetch("/api/memory");

  if (!response.ok) {
    throw new Error(`memory list failed: ${response.status}`);
  }

  const data = (await response.json()) as { memories?: ClientMemory[] };

  return data.memories ?? [];
}

/**
 * Forget one remembered fact. An id the server no longer has counts as success:
 * the request asked for it to be gone, and gone is what it is.
 */
export async function forgetAutomaticMemory(id: string): Promise<ClientMemory[]> {
  const response = await fetch(
    `/api/memory?id=${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );

  if (!response.ok) {
    throw new Error(`memory delete failed: ${response.status}`);
  }

  const data = (await response.json()) as { memories?: ClientMemory[] };

  return data.memories ?? [];
}

/** Forget everything this account has remembered. */
export async function forgetAllAutomaticMemories(): Promise<void> {
  const response = await fetch("/api/memory?all=1", { method: "DELETE" });

  if (!response.ok) {
    throw new Error(`memory clear failed: ${response.status}`);
  }
}
