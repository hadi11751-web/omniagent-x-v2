import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  deleteConversation,
  getConversation,
} from "@/lib/server/conversations";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await context.params;
    const conversation = await getConversation(userId, id);

    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ conversation });
  } catch (error) {
    console.error("conversation_get_failed", error);
    return NextResponse.json(
      { error: "Failed to load conversation" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { id } = await context.params;
    await deleteConversation(userId, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("conversation_delete_failed", error);
    return NextResponse.json(
      { error: "Failed to delete conversation" },
      { status: 500 },
    );
  }
}