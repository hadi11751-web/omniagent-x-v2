import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { collectText } from "@/lib/stream";
import {
  listMemories,
  saveExtractedMemories,
} from "@/lib/server/memory";
import { resolveMemoryModel } from "@/lib/server/memoryModel";
import type { ChatMessage } from "@/lib/types";

export const runtime = "nodejs";

interface Body {
  conversationId?: string;
  messages?: ChatMessage[];
}

interface ExtractedMemory {
  fact: string;
  keywords?: string[];
}

function parseExtractedMemories(
  text: string,
): ExtractedMemory[] {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");

  if (start < 0 || end <= start) {
    return [];
  }

  try {
    const parsed = JSON.parse(
      cleaned.slice(start, end + 1),
    ) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry): ExtractedMemory | null => {
        if (
          !entry ||
          typeof entry !== "object"
        ) {
          return null;
        }

        const value = entry as {
          fact?: unknown;
          keywords?: unknown;
        };

        if (
          typeof value.fact !== "string" ||
          !value.fact.trim()
        ) {
          return null;
        }

        const keywords =
          Array.isArray(value.keywords)
            ? value.keywords.filter(
                (keyword): keyword is string =>
                  typeof keyword === "string" &&
                  keyword.trim().length > 0,
              )
            : [];

        return {
          fact: value.fact,
          keywords,
        };
      })
      .filter(
        (
          entry,
        ): entry is ExtractedMemory =>
          Boolean(entry),
      );
  } catch {
    return [];
  }
}

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const memories =
      await listMemories(userId);

    return NextResponse.json({
      memories,
    });
  } catch (error) {
    console.error(
      "memory_list_failed",
      error,
    );

    return NextResponse.json(
      { error: "Failed to load memories" },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 },
    );
  }

  let body: Body;

  try {
    body =
      (await request.json()) as Body;
  } catch {
    return NextResponse.json(
      {
        error:
          "Request body must be JSON",
      },
      { status: 400 },
    );
  }

  const messages = (
    body.messages ?? []
  )
    .filter(
      (message) =>
        (message.role === "user" ||
          message.role === "assistant") &&
        typeof message.content ===
          "string" &&
        message.content
          .trim()
          .length > 0,
    )
    .slice(-40);

  if (!messages.length) {
    return NextResponse.json({
      memories: [],
    });
  }

  const memoryModel =
    resolveMemoryModel();

  if (!memoryModel) {
    /*
     * Memory must never make chat unavailable.
     * If no cloud AI provider is configured,
     * simply skip automatic extraction.
     */
    return NextResponse.json({
      memories: [],
    });
  }

  const transcript = messages
    .map(
      (message) =>
        `${message.role.toUpperCase()}: ${message.content}`,
    )
    .join("\n\n");

  try {
    const extracted =
      await collectText(
        memoryModel.provider,
        memoryModel.model.id,
        [
          {
            role: "system",
            content: [
              "You extract durable long-term memory for OmniAgent.",
              "Return JSON only as an array of objects.",
              'Each object must have "fact" and "keywords".',
              "The fact must be a short factual statement.",
              "Keywords should capture the concepts needed to retrieve the fact even when the user's future wording differs.",
              "Store only information explicitly stated or clearly established.",
              "Prefer durable preferences, recurring project context, stable goals, and useful working conventions.",
              "Never store passwords, API keys, authentication codes, payment credentials, or security secrets.",
              "Do not infer sensitive personal traits.",
              "Do not store one-off temporary details unless clearly useful long-term.",
              "Avoid duplicates.",
              "Return [] when nothing useful should be remembered.",
              "Keep every fact under 500 characters.",
              "Keep each keyword short and useful.",
            ].join("\n"),
          },
          {
            role: "user",
            content: transcript,
          },
        ],
      );

    const entries =
      parseExtractedMemories(extracted);

    const memories =
      await saveExtractedMemories(
        userId,
        entries,
        body.conversationId,
      );

    return NextResponse.json({
      memories,
    });
  } catch (error) {
    console.error(
      "memory_extraction_failed",
      error,
    );

    /*
     * Automatic memory is an enhancement,
     * not a reason to fail the user's chat.
     */
    return NextResponse.json({
      memories: [],
    });
  }
}
