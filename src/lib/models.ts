import type { ModelInfo } from "@/lib/types";

/**
 * Curated model catalogue.
 * A model only appears when its provider has server-side credentials.
 *
 * Claude Opus 3.5 is intentionally first because OmniAgent's default model
 * selection uses the first configured model.
 */
export const MODELS: ModelInfo[] = [
  {
    id: "claude-3-5-opus-20241022",
    label: "Claude 3.5 Opus (Anthropic)",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["reasoning", "coding", "research"],
  },
  {
    id: "claude-3-5-sonnet-20241022",
    label: "Claude 3.5 Sonnet (Anthropic)",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["coding", "reasoning", "research"],
  },
  {
    id: "claude-3-5-haiku-20241022",
    label: "Claude 3.5 Haiku (Anthropic)",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["fast"],
  },
  {
    id: "mixtral-8x7b-32768",
    label: "Mixtral 8x7B (Groq)",
    provider: "groq",
    execution: "cloud",
    capabilities: ["fast", "coding"],
  },
  {
    id: "gemma2-9b-it",
    label: "Gemma 2 9B (Groq)",
    provider: "groq",
    execution: "cloud",
    capabilities: ["reasoning", "research"],
  },
  {
    id: "gemini-2-0-flash-exp",
    label: "Gemini 2.0 Flash (Google)",
    provider: "gemini",
    execution: "cloud",
    capabilities: ["fast", "research", "reasoning"],
  },
  {
    id: "openai/gpt-4o",
    label: "GPT-4o (OpenRouter)",
    provider: "openrouter",
    execution: "cloud",
    capabilities: ["reasoning", "coding", "research"],
  },
  {
    id: "openai/gpt-4-turbo",
    label: "GPT-4 Turbo (OpenRouter)",
    provider: "openrouter",
    execution: "cloud",
    capabilities: ["coding", "reasoning"],
  },
  {
    id: "meta-llama/llama-3-8b-instruct:free",
    label: "Llama 3 8B (OpenRouter Free)",
    provider: "openrouter",
    execution: "cloud",
    capabilities: ["fast"],
  },
  {
    id: "meta-llama/llama-3-70b-instruct",
    label: "Llama 3 70B (Hugging Face)",
    provider: "huggingface",
    execution: "cloud",
    capabilities: ["reasoning"],
  },
  {
    id: "llama3.1",
    label: "Llama 3.1 (Ollama local)",
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
