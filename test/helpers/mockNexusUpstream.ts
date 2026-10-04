import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for whatever OpenAI-compatible endpoint sits behind Nexus. It is a
 * real HTTP server speaking the real wire protocol (SSE deltas, JSON tool
 * calls, HTTP errors), so a test through it exercises the actual Nexus
 * adapter, transport, retry layer and chat route - only the language model
 * itself is scripted.
 */
export type Script =
  /** A streamed text answer, one SSE delta per chunk. */
  | { kind: "text"; chunks: string[] }
  /** A non-streamed completion that is a native function call. */
  | { kind: "tool_call"; name: string; argument: string }
  /** A non-streamed plain completion (what native-tools mode returns). */
  | { kind: "json"; content: string }
  /** An HTTP error with a body, as a real backend would send it. */
  | { kind: "http"; status: number; body: string }
  /** A 200 whose stream carries no text at all. */
  | { kind: "empty" };

export interface RecordedCall {
  path: string;
  headers: IncomingHttpHeaders;
  body: {
    model?: string;
    stream?: boolean;
    tools?: unknown;
    tool_choice?: unknown;
    messages: Array<{
      role: string;
      content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    }>;
  };
}

export interface MockNexusUpstream {
  /** Base URL to give NEXUS_BASE_URL. */
  url: string;
  calls: RecordedCall[];
  /** Queue what the next requests will do; once drained, it answers "OK". */
  enqueue: (...scripts: Script[]) => void;
  reset: () => void;
  close: () => Promise<void>;
}

function sse(chunks: string[]): string {
  return (
    chunks
      .map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
}

export async function startMockNexusUpstream(): Promise<MockNexusUpstream> {
  const calls: RecordedCall[] = [];
  const queue: Script[] = [];

  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];

    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");

      calls.push({ path: req.url ?? "", headers: req.headers, body });

      const script: Script = queue.shift() ?? { kind: "text", chunks: ["OK"] };

      if (script.kind === "http") {
        res.writeHead(script.status, { "content-type": "application/json" });
        res.end(script.body);
        return;
      }

      if (script.kind === "tool_call") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      function: {
                        name: script.name,
                        arguments: JSON.stringify({ argument: script.argument }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
        return;
      }

      if (script.kind === "json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: script.content } }] }));
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(script.kind === "empty" ? "data: [DONE]\n\n" : sse(script.chunks));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    enqueue: (...scripts) => {
      queue.push(...scripts);
    },
    reset: () => {
      calls.length = 0;
      queue.length = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
