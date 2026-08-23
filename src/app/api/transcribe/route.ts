import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Voice-message input. Reuses GROQ_API_KEY (Groq offers Whisper transcription
 * on the same key as chat, so this needs no new provider or secret) and
 * forwards the recorded audio straight through to Groq's OpenAI-compatible
 * transcription endpoint.
 */
export async function POST(request: Request) {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "Voice input needs GROQ_API_KEY, since it reuses your Groq key for transcription." },
      { status: 503 },
    );
  }

  const incoming = await request.formData().catch(() => null);
  const audio = incoming?.get("audio");
  if (!audio || typeof audio === "string") {
    return NextResponse.json({ error: "no audio file received" }, { status: 400 });
  }
  if (audio.size === 0) {
    return NextResponse.json({ error: "recording was empty" }, { status: 400 });
  }
  if (audio.size > 24 * 1024 * 1024) {
    return NextResponse.json({ error: "recording too large (Groq's limit is 25MB)" }, { status: 413 });
  }

  const upstream = new FormData();
  upstream.append("file", audio, "voice-message.webm");
  upstream.append("model", "whisper-large-v3-turbo");
  upstream.append("response_format", "json");

  try {
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: upstream,
    });
    const raw = await response.text();
    if (!response.ok) {
      let detail = raw.slice(0, 300);
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string } };
        detail = parsed.error?.message ?? detail;
      } catch {
        // raw text is fine as-is
      }
      return NextResponse.json({ error: `Groq transcription failed (${response.status}): ${detail}` }, { status: 502 });
    }
    const data = JSON.parse(raw) as { text?: string };
    return NextResponse.json({ text: (data.text ?? "").trim() });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}

