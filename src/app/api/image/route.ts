import { NextResponse } from "next/server";
import { generateImage, imageGenerationAvailable } from "@/lib/tools/generateImage";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!imageGenerationAvailable()) {
    return NextResponse.json(
      { error: "Image generation needs GEMINI_API_KEY configured on the server." },
      { status: 503 },
    );
  }
  let prompt = "";
  try {
    const body = (await request.json()) as { prompt?: string };
    prompt = (body.prompt ?? "").trim();
  } catch {
    return NextResponse.json({ error: "request body must be JSON" }, { status: 400 });
  }
  if (!prompt) return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  try {
    return NextResponse.json({ image: await generateImage(prompt) });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}
