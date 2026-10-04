import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { audioFilename } from "@/lib/audioMime";
import {
  beginRun,
  endRun,
  oversizedBody,
  readCappedBody,
} from "@/lib/server/guards";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

/** The recording plus the multipart framing and field names wrapped around it. */
const MAX_UPLOAD_BYTES = MAX_AUDIO_BYTES + 64 * 1024;

/** Raised for a recording this route will not forward; carries the response code. */
class TranscriptionRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
  }
}

/** Voice input using Groq's OpenAI-compatible transcription endpoint. */
export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = process.env.GROQ_API_KEY?.trim();

  if (!key) {
    return NextResponse.json(
      { error: "Voice input needs GROQ_API_KEY configured on the server." },
      { status: 503 },
    );
  }

  const oversized = oversizedBody(request, MAX_UPLOAD_BYTES);

  if (oversized) return oversized;

  /*
   * Concurrency but not quota: transcription is the step *before* the chat
   * message the transcript becomes, and that request already charges the daily
   * allowance. Charging here would bill a voice message twice. The cap is
   * separate for the same reason the allowance is not enough on its own: this
   * route can be called directly, and every call costs money.
   */
  const guard = await beginRun(userId, {
    consumesQuota: false,
    dailyCap: "transcribe",
  });

  if ("rejection" in guard) return guard.rejection;

  try {
    const text = await transcribe(request, key);

    await endRun(userId, guard.run, true);

    return NextResponse.json({ text });
  } catch (error) {
    await endRun(userId, guard.run, false);

    if (error instanceof TranscriptionRefusal) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}

async function transcribe(request: Request, key: string): Promise<string> {
  /*
   * `formData()` buffers whatever it is handed, so the upload is read through
   * the same byte ceiling as every other body and re-parsed from those bytes.
   * The `content-length` check in the route is only an early exit: a request
   * sent with `Transfer-Encoding: chunked` carries no usable claim, and used to
   * stream past it into memory.
   */
  const incoming = await readCappedBody(request, MAX_UPLOAD_BYTES);

  if ("tooLarge" in incoming) {
    throw new TranscriptionRefusal("recording too large", 413);
  }

  const form = await new Response(incoming.bytes, {
    headers: request.headers,
  })
    .formData()
    .catch(() => null);

  const audio = form?.get("audio");

  if (!audio || typeof audio === "string") {
    throw new TranscriptionRefusal("no audio file received", 400);
  }

  if (audio.size === 0) {
    throw new TranscriptionRefusal("recording was empty", 400);
  }

  if (audio.size > MAX_AUDIO_BYTES) {
    throw new TranscriptionRefusal("recording too large", 413);
  }

  const upstream = new FormData();
  upstream.append("file", audio, audioFilename(audio.type, audio.name));
  upstream.append("model", "whisper-large-v3-turbo");
  upstream.append("response_format", "json");

  const response = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: upstream,
      /*
       * The wall-clock ceiling and the visitor's own cancellation: a browser
       * that goes away mid-upload used to leave a minute-long Whisper call
       * running and billed.
       */
      signal: AbortSignal.any([
        AbortSignal.timeout(60_000),
        request.signal,
      ]),
    },
  );

  const raw = await response.text();

  if (!response.ok) {
    let detail = raw.slice(0, 300);

    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } };
      detail = parsed.error?.message ?? detail;
    } catch {
      // Keep the raw response excerpt.
    }

    throw new Error(`Groq transcription failed (${response.status}): ${detail}`);
  }

  let data: { text?: unknown };

  try {
    data = JSON.parse(raw) as { text?: unknown };
  } catch {
    throw new Error("Groq returned invalid transcription JSON");
  }

  return typeof data.text === "string" ? data.text.trim() : "";
}
