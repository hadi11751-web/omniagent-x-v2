import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  generateImage,
  imageGenerationAvailable,
} from "@/lib/tools/generateImage";
import {
  beginRun,
  bodyAsRecord,
  decodeJsonBody,
  endRun,
  optionalText,
  oversizedBody,
  readCappedBody,
} from "@/lib/server/guards";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_PROMPT_LENGTH = 10_000;
const MAX_BODY_BYTES = 16_000;

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!imageGenerationAvailable()) {
    return NextResponse.json(
      { error: "Image generation needs GEMINI_API_KEY configured on the server." },
      { status: 503 },
    );
  }

  const oversized = oversizedBody(request, MAX_BODY_BYTES);
  if (oversized) return oversized;

  /*
   * The header is only an early exit — a chunked request can omit it — so the
   * bytes themselves are capped, and the prompt is read through the same
   * boundary checks every other route uses. A `null` body satisfied the old
   * cast, and its property access only answered 400 because it happened to sit
   * inside the parse `catch`, which reported it as "request body must be JSON".
   */
  const incoming = await readCappedBody(request, MAX_BODY_BYTES);

  if ("tooLarge" in incoming) {
    return NextResponse.json(
      { error: "request body is too large" },
      { status: 413 },
    );
  }

  const decoded = decodeJsonBody(incoming.bytes);

  if ("invalidJson" in decoded) {
    return NextResponse.json(
      { error: "request body must be JSON" },
      { status: 400 },
    );
  }

  const record = bodyAsRecord(decoded.parsed);

  if (!record) {
    return NextResponse.json(
      { error: "request body must be a JSON object" },
      { status: 400 },
    );
  }

  const prompt = (optionalText(record.prompt) ?? "").trim();

  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json(
      { error: "prompt is too long" },
      { status: 400 },
    );
  }

  /*
   * This route has no client caller today, but it is reachable by any signed-in
   * account, so it pays for its own generation: a billed image counts against
   * the daily free allowance exactly like a chat message does.
   */
  const guard = await beginRun(userId, { consumesQuota: true });

  if ("rejection" in guard) return guard.rejection;

  try {
    const image = await generateImage(prompt, request.signal);
    await endRun(userId, guard.run, true);

    return NextResponse.json({ image });
  } catch (error) {
    await endRun(userId, guard.run, false);

    return NextResponse.json(
      { error: (error as Error).message },
      { status: 502 },
    );
  }
}
