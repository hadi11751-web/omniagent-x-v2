import { NextResponse } from "next/server";
import { availableModels, configuredProviders } from "@/lib/providers";
import { availableTools } from "@/lib/tools";
import { imageGenerationAvailable } from "@/lib/tools/generateImage";

export const runtime = "nodejs";

/**
 * Tells the browser what the server can actually do. Only names and flags are
 * returned - never key material.
 */
export function GET() {
  const providers = configuredProviders().map((provider) => ({
    id: provider.id,
    label: provider.label,
    execution: provider.execution,
  }));
  return NextResponse.json({
    providers,
    models: availableModels(),
    tools: availableTools().map((tool) => ({ name: tool.name, description: tool.description })),
    imageGeneration: imageGenerationAvailable(),
    voiceInput: Boolean(process.env.GROQ_API_KEY),
    visionInput: availableModels().some((m) => m.vision),
    searchEngine: process.env.TAVILY_API_KEY
      ? "Tavily"
      : process.env.BRAVE_API_KEY
        ? "Brave Search"
        : "DuckDuckGo (keyless fallback)",
  });
}

