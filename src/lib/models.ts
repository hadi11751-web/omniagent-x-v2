import type { ModelInfo } from "@/lib/types";

/**
 * Curated model catalogue.
 * A model only appears when its provider has server-side credentials.
 *
 * GPT-6 Astra is intentionally first because OmniAgent's default model
 * selection uses the first configured model.
 */
export const MODELS: ModelInfo[] = [
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra (OpenAI)",
    provider: "openai",
    execution: "cloud",
    capabilities: ["reasoning", "coding", "research", "fast"],
    vision: true,
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5 (Anthropic)",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["reasoning", "coding", "research"],
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5 (Anthropic)",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["coding", "reasoning", "research"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5 (Anthropic)",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["fast"],
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8 (Anthropic)",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["reasoning", "research"],
  },
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
    id: "qwen/qwen3.6-27b",
    label: "Qwen 3.6 27B Vision (Groq)",
    provider: "groq",
    execution: "cloud",
    capabilities: ["coding", "reasoning"],
    vision: true,
  },
  {
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
];

export const DEFAULT_SYSTEM_PROMPT = [
  "You are OmniAgent, a helpful multi-provider AI assistant.",
  "Answer in Markdown. Use fenced code blocks with a language tag for code.",
  "Be accurate and concise. If you are unsure, say so instead of inventing facts.",
  "You never have live web access unless a tool result in the conversation provides it;",
  "in that case cite the given sources.",
].join(" ");