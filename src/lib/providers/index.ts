```ts
import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import { huggingFaceProvider } from "./huggingface";
import { openaiProvider } from "./openai";
import { createOpenAiCompatibleProvider } from "./openaiCompatible";
import { MODELS } from "@/lib/models";
import type { ChatProvider, ModelInfo, ProviderId } from "@/lib/types";

const groqProvider: ChatProvider = createOpenAiCompatibleProvider({
  id: "groq",
  label: "Groq",
  execution: "cloud",
  baseUrl: () => "https://api.groq.com/openai/v1",
  apiKey: () => process.env.GROQ_API_KEY,
  requiresKey: true,
});

const openRouterProvider: ChatProvider = createOpenAiCompatibleProvider({
  id: "openrouter",
  label: "OpenRouter",
  execution: "cloud",
  baseUrl: () => "https://openrouter.ai/api/v1",
  apiKey: () => process.env.OPENROUTER_API_KEY,
  requiresKey: true,
  extraHeaders: {
    "x-title": "OmniAgent",
  },
});

const ollamaProvider: ChatProvider = createOpenAiCompatibleProvider({
  id: "ollama",
  label: "Local (Ollama)",
  execution: "local",
  baseUrl: () => {
    const base = process.env.OLLAMA_BASE_URL;

    if (!base?.trim()) {
      return undefined;
    }

    return `${base.replace(/\/+$/, "")}/v1`;
  },
  apiKey: () => undefined,
  requiresKey: false,
});

/**
 * The registry is intentionally partial.
 *
 * A ProviderId alone does not mean a provider is implemented.
 * A model is available only when:
 *
 * 1. Its provider is registered.
 * 2. The provider reports itself as configured.
 */
export const PROVIDERS: Partial<Record<ProviderId, ChatProvider>> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  groq: groqProvider,
  openrouter: openRouterProvider,
  huggingface: huggingFaceProvider,
  ollama: ollamaProvider,
};

export function configuredProviders(): ChatProvider[] {
  return Object.values(PROVIDERS).filter(
    (provider): provider is ChatProvider =>
      Boolean(provider?.isConfigured()),
  );
}

export function availableModels(): ModelInfo[] {
  return MODELS.filter((model) => {
    const provider = PROVIDERS[model.provider];
    return Boolean(provider?.isConfigured());
  });
}

export function findModel(modelId: string): ModelInfo | undefined {
  return MODELS.find((model) => model.id === modelId);
}

export function providerFor(modelId: string): ChatProvider | undefined {
  const model = findModel(modelId);

  if (!model) {
    return undefined;
  }

  return PROVIDERS[model.provider];
}
```
