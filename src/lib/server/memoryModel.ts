import {
  availableModels,
  providerFor,
} from "@/lib/providers";
import type {
  ChatProvider,
  ModelInfo,
} from "@/lib/types";

export interface MemoryModel {
  model: ModelInfo;
  provider: ChatProvider;
}

/**
 * Selects a configured model suitable for short, structured memory work.
 *
 * Memory extraction must not depend on one specific vendor/model.
 * Prefer reasoning-capable cloud models, then coding-capable models,
 * then fast models, and finally any configured cloud model.
 */
export function resolveMemoryModel(): MemoryModel | undefined {
  const models = availableModels().filter(
    (model) => model.execution === "cloud",
  );

  const ranked = [...models].sort((a, b) => {
    const score = (model: ModelInfo): number => {
      if (model.capabilities.includes("reasoning")) return 0;
      if (model.capabilities.includes("coding")) return 1;
      if (model.capabilities.includes("fast")) return 2;
      return 3;
    };

    return score(a) - score(b);
  });

  for (const model of ranked) {
    const provider = providerFor(model.id);

    if (provider?.isConfigured()) {
      return {
        model,
        provider,
      };
    }
  }

  return undefined;
}
