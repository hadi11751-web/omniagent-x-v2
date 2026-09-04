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
): Promise<ClientMemory[]> {
  const response = await fetch("/api/memory", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      conversationId,
      messages,
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
