```ts
import type { ModelInfo } from "@/lib/types";

/**
 * Curated model catalogue.
 *
 * IMPORTANT:
 * - `id` is the exact provider API model identifier.
 * - A model is exposed by the application only when its provider is
 *   registered and configured.
 * - Do not put marketing-only names in `id`.
 */
export const MODELS: ModelInfo[] = [
  // ---------------------------------------------------------------------------
  // OpenAI
  // ---------------------------------------------------------------------------
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra (OpenAI)",
    provider: "openai",
    execution: "cloud",
    capabilities: ["coding", "reasoning", "research"],
    vision: true,
  },

  // ---------------------------------------------------------------------------
  // Anthropic
  // ---------------------------------------------------------------------------
  {
    id: "claude-opus-5",
    label: "Claude Opus 5 (Anthropic)",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["coding", "reasoning", "research"],
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5 (Anthropic)",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["coding", "reasoning", "research"],
  },

  // ---------------------------------------------------------------------------
  // Google Gemini
  // ---------------------------------------------------------------------------
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash (Google)",
    provider: "gemini",
    execution: "cloud",
    capabilities: ["fast", "coding", "reasoning", "research"],
    vision: true,
  },

  // ---------------------------------------------------------------------------
  // xAI
  // ---------------------------------------------------------------------------
  {
    id: "grok-4.6",
    label: "Grok 4.6 (xAI)",
    provider: "xai",
    execution: "cloud",
    capabilities: ["coding", "reasoning", "research"],
    vision: true,
  },

  // ---------------------------------------------------------------------------
  // DeepSeek
  // ---------------------------------------------------------------------------
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "deepseek",
    execution: "cloud",
    capabilities: ["coding", "reasoning", "research"],
  },

  // ---------------------------------------------------------------------------
  // Groq
  // ---------------------------------------------------------------------------
  {
    id: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B (Groq)",
    provider: "groq",
    execution: "cloud",
    capabilities: ["coding", "reasoning", "research"],
  },
  {
    id: "openai/gpt-oss-20b",
    label: "GPT-OSS 20B (Groq)",
    provider: "groq",
    execution: "cloud",
    capabilities: ["fast", "coding", "reasoning"],
  },
  {
    id: "llama-3.3-70b-versatile",
    label: "Llama 3.3 70B (Groq)",
    provider: "groq",
    execution: "cloud",
    capabilities: ["coding", "reasoning", "research"],
  },
  {
    id: "llama-3.1-8b-instant",
    label: "Llama 3.1 8B Instant (Groq)",
    provider: "groq",
    execution: "cloud",
    capabilities: ["fast"],
  },

  // ---------------------------------------------------------------------------
  // OpenRouter
  // ---------------------------------------------------------------------------
  //
  // Keep this provider available, but do not manufacture model IDs here.
  // OpenRouter has a live model catalogue and model IDs can change independently
  // of OmniAgent releases. We will add explicitly verified OpenRouter models
  // after validating their current IDs against the provider catalogue.
  //

  // ---------------------------------------------------------------------------
  // Hugging Face
  // ---------------------------------------------------------------------------
  //
  // The existing Hugging Face provider should remain available, but its model
  // catalogue should not contain stale hard-coded IDs without a current provider
  // check. Image generation is handled separately from this chat catalogue.
  //

  // ---------------------------------------------------------------------------
  // Ollama
  // ---------------------------------------------------------------------------
  {
    id: "llama3.1:latest",
    label: "Llama 3.1 (Ollama local)",
    provider: "ollama",
    execution: "local",
    capabilities: ["private", "fast"],
  },
];

export const DEFAULT_SYSTEM_PROMPT = [
  "You are OmniAgent, a helpful multi-provider AI assistant.",
  "Answer in Markdown.",
  "Use fenced code blocks with a language tag for code.",
  "Be accurate and concise.",
  "If you are unsure, say so instead of inventing facts.",
  "You never have live web access unless a tool result in the conversation provides it.",
  "When tool results provide sources, preserve and cite those sources appropriately.",
  "Never claim that an action, tool call, search, or external operation happened unless the application actually completed it.",
].join(" ");
```
