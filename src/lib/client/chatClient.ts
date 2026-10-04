import type { StreamEvent } from "@/lib/stream";
import type { ChatMessage } from "@/lib/types";
import type { Mode } from "./types";

export interface SendOptions {
  messages: ChatMessage[];
  mode: Mode;
  toolsEnabled: boolean;
  memory?: string;

  /** The settings switch: the server reads remembered facts only while it is on. */
  memoryEnabled: boolean;
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

  const drain = (line: string) => {
    if (!line.trim()) return;
    try {
      onEvent(JSON.parse(line) as StreamEvent);
    } catch {
      /* ignore malformed line */
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) drain(line);
  }

  // A connection can close mid-codepoint or without a trailing newline.
  buffer += decoder.decode();
  drain(buffer);
}
