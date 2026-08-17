import type { StreamEvent } from "@/lib/stream";
import type { ChatMessage } from "@/lib/types";
import type { Mode } from "./types";

export interface SendOptions {
  messages: ChatMessage[];
  model: string;
  mode: Mode;
  autoRoute: boolean;
  toolsEnabled: boolean;
  memory?: string;
  projectContext?: string;
  signal: AbortSignal;
  onEvent: (event: StreamEvent) => void;
}

/** Posts to /api/chat and replays the NDJSON event stream. */
export async function sendChat(options: SendOptions): Promise<void> {
  const { signal, onEvent, ...payload } = options;
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok || !response.body) {
    let message = `request failed with status ${response.status}`;
    try {
      const data = (await response.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* keep the status message */
    }
    onEvent({ type: "error", message });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as StreamEvent);
      } catch {
        /* ignore malformed line */
      }
    }
  }
}
