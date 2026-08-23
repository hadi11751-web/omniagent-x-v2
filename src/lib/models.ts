import type { ModelInfo } from "@/lib/types";

/**
 * Curated catalogue. A model only shows up in the UI when its provider has
 * credentials configured on the server (see `availableModels`).
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
    id: "meta-llama/llama-4-scout-17b-16e-instruct",
    label: "Llama 4 Scout Vision (Groq)",
    provider: "groq",
    execution: "cloud",
    capabilities: ["fast"],
    vision: true,
  },
  {
    id: "qwen/qwen3.6-27b",
    label: "Qwen 3.6 27B (Groq)",
    provider: "groq",
    execution: "cloud",
    capabilities: ["coding", "reasoning"],
  },
  {
    id: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
    provider: "gemini",
    execution: "cloud",
    capabilities: ["fast", "research", "reasoning"],
  },
  {
    id: "deepseek/deepseek-chat-v3-0324:free",
    label: "DeepSeek V3 (OpenRouter)",
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

