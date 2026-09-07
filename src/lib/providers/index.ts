```ts
import { anthropicProvider } from "./anthropic";
import { deepseekProvider } from "./deepseek";
import { geminiProvider } from "./gemini";
import { huggingFaceProvider } from "./huggingface";
import { openaiProvider } from "./openai";
import { xaiProvider } from "./xai";
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

const ollamaProvider = createOpenAiCompatibleProvider({
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

export const PROVIDERS: Partial<Record<ProviderId, ChatProvider>> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  xai: xaiProvider,
  deepseek: deepseekProvider,
  groq: groqProvider,
  openrouter: openRouterProvider,
  huggingface: huggingFaceProvider,
  ollama,
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
