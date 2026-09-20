import { classify } from "@/lib/router";
import type {
  Capability,
  ModelInfo,
  ToolDefinition,
} from "@/lib/types";

export const NEXUS_ID = "omniagent-nexus";
export const NEXUS_LABEL = "OmniAgent Nexus";

export interface NexusPlan {
  capability: Capability;
  model?: ModelInfo;
  retrieveMemory: boolean;
  toolNames: string[];
}

const TOOL_MAP: Record<Capability, string[]> = {
  fast: [],
  coding: ["analyze_text", "calculator"],
  reasoning: ["calculator", "analyze_text"],
  research: ["web_search", "fetch_url", "analyze_text"],
  image: ["generate_image"],
  private: [],
};

function selectModel(
  capability: Capability,
  models: ModelInfo[],
  requiresVision: boolean,
): ModelInfo | undefined {
  const eligible = models.filter(
    (model) => !requiresVision || model.vision === true,
  );

  if (!eligible.length) {
    return undefined;
  }

  const scored = eligible.map((model, index) => {
    let score = 0;

    if (model.capabilities.includes(capability)) {
      score += 100;
    }

    if (capability === "private") {
      score += model.execution === "local" ? 100 : -100;
    } else {
      score += model.execution === "cloud" ? 10 : 0;
    }

    if (requiresVision && model.vision) {
      score += 25;
    }

    score += model.capabilities.length;

    return {
      model,
      score,
      index,
    };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.index - b.index,
  );

  return scored[0]?.model;
}

export function nexusPlan(
  prompt: string,
  models: ModelInfo[],
  tools: ToolDefinition[],
  requiresVision = false,
): NexusPlan {
  const capability = classify(prompt);

  const model = selectModel(
    capability,
    models,
    requiresVision,
  );

  const availableToolNames = new Set(
    tools.map((tool) => tool.name),
  );

  const toolNames = TOOL_MAP[capability].filter(
    (name) => availableToolNames.has(name),
  );

  const retrieveMemory =
    capability === "coding" ||
    capability === "reasoning" ||
    capability === "research";

  return {
    capability,
    model,
    retrieveMemory:
      capability === "private"
        ? false
        : retrieveMemory,
    toolNames,
  };
}
