import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import {
  deleteAllConversations,
  listConversations,
  saveConversation,
  type StoredConversation,
} from "@/lib/server/conversations";

export const runtime = "nodejs";

async function requireUserId(): Promise<string> {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("UNAUTHORIZED");
  }

  return userId;
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

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = (await request.json()) as StoredConversation;

    const conversation = await saveConversation(userId, body);

    return NextResponse.json({ conversation });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    console.error("conversation_save_failed", error);

    return NextResponse.json(
      { error: "Failed to save conversation" },
      { status: 400 },
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
