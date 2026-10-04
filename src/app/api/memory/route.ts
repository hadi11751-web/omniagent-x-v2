import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { collectText } from "@/lib/stream";
import { nexusModel, NEXUS_NOT_CONFIGURED_MESSAGE } from "@/lib/nexus";
import { classify } from "@/lib/intent";
import {
  beginRun,
  bodyAsRecord,
  decodeJsonBody,
  endRun,
  optionalText,
  oversizedBody,
  readCappedBody,
} from "@/lib/server/guards";
import {
  clearMemories,
  deleteMemory,
  listMemories,
  saveMemories,
} from "@/lib/server/memory";
import {
  MAX_CONTEXT_FIELD_CHARS,
  MAX_MEMORY_ID_CHARS,
  MAX_MEMORY_TRANSCRIPT_MESSAGES,
  MAX_MESSAGE_CHARS,
} from "@/lib/limits";
import type { ChatMessage } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The same history `/api/chat` already accepts (5 MB) plus the reply that
 * streamed in since, so this leaves room for the assistant message on top.
 */
const MAX_MEMORY_BODY_BYTES = 8 * 1024 * 1024;
const EXTRACTION_TIMEOUT_MS = 45_000;

interface Body {
  conversationId?: string;
  messages?: ChatMessage[];

  /**
   * Set when the turn this transcript came from was answered by a local model.
   * It is only one input to the boundary: the route also classifies the
   * transcript itself, so the claim can narrow the boundary but never widen it.
   */
  localOnly?: boolean;
}

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const memories = await listMemories(userId);
    return NextResponse.json({ memories });
  } catch (error) {
    console.error("memory_list_failed", error);
    return NextResponse.json(
      { error: "Failed to load memories" },
      { status: 500 },
    );
  }
}

/*
 * Forgetting is the half that was missing: the settings panel listed nothing and
 * could delete nothing, while the pricing page told readers they could "delete
 * any stored memory". `?id=` forgets one fact, `?all=1` forgets the account's
 * whole list, and the response carries what is left so the caller does not have
 * to ask again to find out.
 *
 * No run guard: this reaches no model, so it costs nothing upstream and owes
 * neither the message allowance nor the extraction ceiling.
 */
export async function DELETE(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const all = params.get("all");
  const id = params.get("id") ?? "";

  if (all !== null && all !== "1") {
    return NextResponse.json(
      { error: "all must be 1" },
      { status: 400 },
    );
  }

  if (all === null && !id) {
    return NextResponse.json(
      { error: "name the memory to forget with id, or ask for all=1" },
      { status: 400 },
    );
  }

  if (all === null && id.length > MAX_MEMORY_ID_CHARS) {
    return NextResponse.json({ error: "id is not a memory id" }, { status: 400 });
  }

  try {
    if (all === "1") {
      const deleted = await clearMemories(userId);

      return NextResponse.json({ deleted, memories: [] });
    }

    const deleted = (await deleteMemory(userId, id)) ? 1 : 0;
    const memories = await listMemories(userId);

    return NextResponse.json({ deleted, memories });
  } catch (error) {
    console.error("memory_delete_failed", error);
    return NextResponse.json(
      { error: "Failed to delete memory" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tooLarge = oversizedBody(request, MAX_MEMORY_BODY_BYTES);

  if (tooLarge) return tooLarge;

  /*
   * `content-length` is a claim, not a measurement: a chunked body arrives with
   * no usable one and `request.json()` would have buffered all of it before any
   * ceiling was consulted, so the read itself is capped.
   */
  const incoming = await readCappedBody(request, MAX_MEMORY_BODY_BYTES);

  if ("tooLarge" in incoming) {
    return NextResponse.json(
      { error: "request body is too large" },
      { status: 413 },
    );
  }

  const decoded = decodeJsonBody(incoming.bytes);

  if ("invalidJson" in decoded) {
    return NextResponse.json(
      { error: "Request body must be JSON" },
      { status: 400 },
    );
  }

  const record = bodyAsRecord(decoded.parsed);

  if (!record) {
    return NextResponse.json(
      { error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }

  const body = record as Body;

  /*
   * `null` is valid JSON and so is an array full of them, and either used to
   * reach `message.role` and raise a 500 where a 400 was earned.
   */
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (message) =>
        (message?.role === "user" || message?.role === "assistant") &&
        typeof message?.content === "string" &&
        message.content.trim().length > 0,
    )
    .slice(-MAX_MEMORY_TRANSCRIPT_MESSAGES);

  const transcript = buildTranscript(messages);

  if (!transcript) {
    return NextResponse.json({ memories: [] });
  }

  const localOnly =
    body.localOnly === true ||
    /*
     * The transcript is checked here rather than left to the client's flag: a
     * turn that reads as private but had to be answered by a cloud model used to
     * arrive with `localOnly: false`, and its contents were then summarised by a
     * second cloud provider. `requested` is the boundary every other step that
     * is not the reply itself obeys, and the server is the one that owns it.
     */
    messages.some(
      (message) =>
        message.role === "user" && classify(message.content) === "private",
    );

  /*
   * Extraction is done by Nexus, like everything else. The one thing that has
   * to hold is the privacy boundary: a conversation that asked to be private
   * is only summarised if Nexus itself runs locally. A cloud-backed Nexus
   * leaves that turn unremembered rather than sending it for a second look.
   */
  const nexus = nexusModel();

  if (!nexus) {
    return NextResponse.json(
      { error: NEXUS_NOT_CONFIGURED_MESSAGE },
      { status: 503 },
    );
  }

  if (localOnly && nexus.execution !== "local") {
    return NextResponse.json({
      memories: [],
      skipped:
        "this conversation is private and Nexus runs on a cloud backend, so memory extraction will not send it anywhere",
    });
  }

  /*
   * Concurrency but not quota: the chat turn that produced this transcript
   * already paid for a message, and extraction runs after every reply. Charging
   * again would halve the free allowance the pricing page advertises. The daily
   * cap is here instead, because this route is reachable directly and calls a
   * model every time it is called.
   */
  const guard = await beginRun(userId, {
    consumesQuota: false,
    dailyCap: "memory",
  });

  if ("rejection" in guard) return guard.rejection;

  let extractionSucceeded = false;

  try {
    const extracted = await collectText(
      [
        {
          role: "system",
          content: [
            "You extract durable long-term memory for OmniAgent.",
            "Return JSON only as an array of short factual strings.",
            "Store only information explicitly stated or clearly established.",
            "Prefer durable preferences, recurring project context, stable goals, and useful working conventions.",
            "Never store passwords, API keys, authentication codes, payment credentials, or security secrets.",
            "Do not infer sensitive personal traits.",
            "Do not store one-off temporary details unless clearly useful long-term.",
            "Avoid duplicates.",
            "Return [] when nothing useful should be remembered.",
            "Keep every memory under 500 characters.",
          ].join("\n"),
        },
        {
          role: "user",
          content: transcript,
        },
      ],
      AbortSignal.timeout(EXTRACTION_TIMEOUT_MS),
    );

    extractionSucceeded = true;

    const cleaned = extracted
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");

    if (start < 0 || end <= start) {
      return NextResponse.json({ memories: [] });
    }

    const parsed = JSON.parse(
      cleaned.slice(start, end + 1),
    ) as unknown;

    if (!Array.isArray(parsed)) {
      return NextResponse.json({ memories: [] });
    }

    const facts = parsed.filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    );

    const memories = await saveMemories(
      userId,
      facts,
      optionalText(body.conversationId),
    );

    return NextResponse.json({ memories });
  } catch (error) {
    console.error("memory_extraction_failed", error);
    return NextResponse.json(
      { error: "Memory extraction failed" },
      { status: 500 },
    );
  } finally {
    await endRun(userId, guard.run, extractionSucceeded);
  }
}

/**
 * Newest messages win the character budget: extraction summarises where the
 * conversation is now, so dropping older turns costs less than dropping the
 * recent ones. Each message is capped on top of that.
 */
function buildTranscript(messages: ChatMessage[]): string {
  const lines: string[] = [];
  let used = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const line = `${message.role.toUpperCase()}: ${message.content.slice(0, MAX_MESSAGE_CHARS)}`;

    if (used + line.length > MAX_CONTEXT_FIELD_CHARS) break;

    used += line.length;
    lines.unshift(line);
  }

  return lines.join("\n\n");
}