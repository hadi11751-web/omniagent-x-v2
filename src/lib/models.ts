import type { ModelInfo } from "@/lib/types";

/**
 * Curated catalogue. A model only shows up in the UI when its provider has
 * credentials configured on the server (see `availableModels`).
 *
 * Every ID below was checked against each provider's own current docs
 * (Aug 2026) to avoid shipping already-deprecated model names.
 */
export const MODELS: ModelInfo[] = [
  {
    id: "openai/gpt-oss-20b",
    label: "GPT-OSS 20B (Groq)",
    provider: "groq",
    execution: "cloud",
    capabilities: ["fast", "coding"],
  },
  {
    id: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B (Groq)",
    provider: "groq",
    execution: "cloud",
    capabilities: ["reasoning", "research"],
  },
  {
    // Groq deprecated meta-llama/llama-4-scout-17b-16e-instruct on
    // 2026-03-23. qwen/qwen3.6-27b is Groq's own recommended replacement
    // and is also their current vision-capable model.
    id: "qwen/qwen3.6-27b",
    label: "Qwen 3.6 27B Vision (Groq)",
    provider: "groq",
    execution: "cloud",
    capabilities: ["coding", "reasoning"],
    vision: true,
  },
  {
    // Google retired gemini-2.0-flash; gemini-3.6-flash is the current
    // stable Flash-tier model as of Aug 2026.
    id: "gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    provider: "gemini",
    execution: "cloud",
    capabilities: ["fast", "research", "reasoning"],
  },
  {
    // OpenRouter's free-tier lineup rotates constantly and DeepSeek
    // currently has zero $0 models there. "openrouter/free" is their own
    // auto-router that always resolves to whatever's free right now,
    // instead of a specific ID that can silently die.
    id: "openrouter/free",
    label: "Auto (Free tier, OpenRouter)",
    provider: "openrouter",
    execution: "cloud",
    capabilities: ["coding", "reasoning"],
  },
  {
    id: "meta-llama/Llama-3.1-8B-Instruct",
    label: "Llama 3.1 8B (Hugging Face)",
    provider: "huggingface",
    execution: "cloud",
    capabilities: ["fast"],
  },
  {
    id: "llama3.1",
    label: "Llama 3.1 (local)",
    provider: "ollama",
    execution: "local",
    capabilities: ["private", "fast"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5 (Anthropic)",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["fast"],
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5 (Anthropic)",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["coding", "reasoning", "research"],
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8 (Anthropic)",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["reasoning", "research"],
  },
];

export const DEFAULT_SYSTEM_PROMPT = [
  "You are OmniAgent, a helpful multi-provider AI assistant.",
  "Answer in Markdown. Use fenced code blocks with a language tag for code.",
  "Be accurate and concise. If you are unsure, say so instead of inventing facts.",
  "You never have live web access unless a tool result in the conversation provides it;",
  "in that case cite the given sources.",
].join(" ");

