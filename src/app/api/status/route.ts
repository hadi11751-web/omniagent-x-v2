import { NextResponse } from "next/server";
import { nexusModel } from "@/lib/nexus";
import { availableTools } from "@/lib/tools";
import { imageGenerationAvailable } from "@/lib/tools/generateImage";

export const runtime = "nodejs";

/**
 * Tells the browser what the server can actually do. There is one model, so
 * this reports whether Nexus is ready and whether it can see images - never
 * which engine, vendor, endpoint or key is behind it.
 */
export function GET() {
  const nexus = nexusModel();

  return NextResponse.json({
    nexus: {
      label: "Nexus",
      ready: Boolean(nexus),
      vision: nexus?.vision ?? false,
      execution: nexus?.execution ?? null,
    },
    tools: availableTools().map((tool) => ({ name: tool.name, description: tool.description })),
    imageGeneration: imageGenerationAvailable(),
    voiceInput: Boolean(process.env.GROQ_API_KEY),
    visionInput: nexus?.vision ?? false,
    searchEngine: process.env.TAVILY_API_KEY
      ? "Tavily"
      : process.env.BRAVE_API_KEY
        ? "Brave Search"
        : "DuckDuckGo (keyless fallback)",
  });
}
