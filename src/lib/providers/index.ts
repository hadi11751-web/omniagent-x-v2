import { anthropicProvider } from "./anthropic";
import { huggingFaceProvider } from "./huggingface";
import { openAiProvider } from "./openai";
import { createOpenAiCompatibleProvider } from "./openaiCompatible";
import { MODELS } from "@/lib/models";
import type { ChatProvider, ModelInfo, ProviderId } from "@/lib/types";

const groqProvider = createOpenAiCompatibleProvider({
  id: "groq",
  label: "Groq",
  execution: "cloud",
  baseUrl: () => "https://api.groq.com/openai/v1",
  apiKey: () => process.env.GROQ_API_KEY,
  requiresKey: true,
});

const openRouterProvider = createOpenAiCompatibleProvider({
  id: "openrouter",
  label: "OpenRouter",
  execution: "cloud",
  baseUrl: () => "https://openrouter.ai/api/v1",
  apiKey: () => process.env.OPENROUTER_API_KEY,
  requiresKey: true,
  extraHeaders: { "x-title": "OmniAgent" },
});

const ollamaProvider = createOpenAiCompatibleProvider({
  id: "ollama",
  label: "Local (Ollama)",
  execution: "local",
  baseUrl: () => {
    const base = process.env.OLLAMA_BASE_URL;
    return base ? `${base.replace(/\/$/, "")}/v1` : undefined;
  },
  apiKey: () => undefined,
  requiresKey: false,
});

export const PROVIDERS: Record<ProviderId, ChatProvider> = {
  openai: openAiProvider,
  groq: groqProvider,
  openrouter: openRouterProvider,
  huggingface: huggingFaceProvider,
  ollama: ollamaProvider,
  anthropic: anthropicProvider,
};

export function configuredProviders(): ChatProvider[] {
  return Object.values(PROVIDERS).filter((provider) => provider.isConfigured());
}

export function availableModels(): ModelInfo[] {
  return MODELS.filter((model) => PROVIDERS[model.provider].isConfigured());
}

export function findModel(modelId: string): ModelInfo | undefined {
  return MODELS.find((model) => model.id === modelId);
}

export function providerFor(modelId: string): ChatProvider | undefined {
  const model = findModel(modelId);
  return model ? PROVIDERS[model.provider] : undefined;
}
