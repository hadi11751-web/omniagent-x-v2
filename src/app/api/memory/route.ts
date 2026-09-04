import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { collectText } from "@/lib/stream";
import { providerFor } from "@/lib/providers";
import { listMemories, saveMemories } from "@/lib/server/memory";
import type { ChatMessage } from "@/lib/types";

export const runtime = "nodejs";

interface Body {
  conversationId?: string;
  messages?: ChatMessage[];
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

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Body;

  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      { error: "Request body must be JSON" },
      { status: 400 },
    );
  }

  const messages = (body.messages ?? [])
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    )
    .slice(-40);

  if (!messages.length) {
    return NextResponse.json({ memories: [] });
  }

  const opus = providerFor("claude-opus-5");

  if (!opus || !opus.isConfigured()) {
    return NextResponse.json(
      { error: "Claude Opus 5 is not configured" },
      { status: 503 },
    );
  }

  const transcript = messages
    .map(
      (message) =>
        `${message.role.toUpperCase()}: ${message.content}`,
    )
    .join("\n\n");

  try {
    const extracted = await collectText(
      opus,
      "claude-opus-5",
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
      new AbortController().signal,
    );

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
      body.conversationId,
    );

    return NextResponse.json({ memories });
  } catch (error) {
    console.error("memory_extraction_failed", error);
    return NextResponse.json(
      { error: "Memory extraction failed" },
      { status: 500 },
    );
  }
}