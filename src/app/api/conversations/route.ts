import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  ConversationValidationError,
  deleteAllConversations,
  listConversations,
  saveConversation,
  type StoredConversation,
} from "@/lib/server/conversations";
import {
  bodyAsRecord,
  decodeJsonBody,
  oversizedBody,
  readCappedBody,
} from "@/lib/server/guards";
import { MAX_CONVERSATION_BODY_BYTES } from "@/lib/limits";

export const runtime = "nodejs";

/*
 * `normalizeConversation` refuses anything larger than MAX_CONVERSATION_JSON_CHARS
 * characters, but that check runs after the body has already been parsed. This
 * rejects blind sizes on the bytes instead, without turning away a legitimate
 * save.
 */
const MAX_BODY_BYTES = MAX_CONVERSATION_BODY_BYTES;

async function requireUserId(): Promise<string> {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("UNAUTHORIZED");
  }

  return userId;
}

/**
 * `null`, an array and a number in the `title` slot are all valid JSON, and the
 * body arrives as `StoredConversation` only because the route says so. The
 * object check runs here, through `bodyAsRecord`, so a malformed save is a 400
 * rather than a `TypeError` inside the normaliser.
 */
type BodyRead =
  | { conversation: StoredConversation }
  | { tooLarge: true }
  | { malformed: true };

async function readBody(request: Request): Promise<BodyRead> {
  const incoming = await readCappedBody(request, MAX_BODY_BYTES);

  if ("tooLarge" in incoming) return { tooLarge: true };

  const decoded = decodeJsonBody(incoming.bytes);

  if ("invalidJson" in decoded) return { malformed: true };

  const record = bodyAsRecord(decoded.parsed);

  if (!record) return { malformed: true };

  return { conversation: record as unknown as StoredConversation };
}

export async function GET() {
  try {
    const userId = await requireUserId();
    const conversations = await listConversations(userId);

    return NextResponse.json({ conversations });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    console.error("conversation_list_failed", error);

    return NextResponse.json(
      { error: "Failed to load conversations" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const userId = await requireUserId();
    const tooLarge = oversizedBody(request, MAX_BODY_BYTES);

    if (tooLarge) return tooLarge;

    const incoming = await readBody(request);

    if ("tooLarge" in incoming) {
      return NextResponse.json(
        { error: "request body is too large" },
        { status: 413 },
      );
    }

    if ("malformed" in incoming) {
      return NextResponse.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const conversation = await saveConversation(userId, incoming.conversation);

    return NextResponse.json({ conversation });
  } catch (error) {
    if (error instanceof ConversationValidationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 },
      );
    }

    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    console.error("conversation_save_failed", error);

    return NextResponse.json(
      { error: "Failed to save conversation" },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  try {
    const userId = await requireUserId();
    await deleteAllConversations(userId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    console.error("conversation_delete_all_failed", error);

    return NextResponse.json(
      { error: "Failed to delete conversations" },
      { status: 500 },
    );
  }
}
