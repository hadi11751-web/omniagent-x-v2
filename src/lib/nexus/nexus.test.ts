import { describe, expect, it } from "vitest";
import { nexusPlan, NEXUS_ID, NEXUS_LABEL } from "./index";
import type {
  ModelInfo,
  ToolDefinition,
} from "@/lib/types";

const models: ModelInfo[] = [
  {
    id: "cloud-fast",
    label: "Cloud Fast",
    provider: "openai",
    execution: "cloud",
    capabilities: ["fast", "coding", "research"],
  },
  {
    id: "local-private",
    label: "Local Private",
    provider: "ollama",
    execution: "local",
    capabilities: ["private", "fast"],
  },
  {
    id: "vision-reasoning",
    label: "Vision Reasoning",
    provider: "anthropic",
    execution: "cloud",
    capabilities: ["reasoning", "research"],
    vision: true,
  },
];

const tools: ToolDefinition[] = [
  {
    name: "web_search",
    description: "Search",
    argument: "query",
    run: async () => ({ ok: true, content: "" }),
  },
  {
    name: "fetch_url",
    description: "Fetch",
    argument: "url",
    run: async () => ({ ok: true, content: "" }),
  },
  {
    name: "analyze_text",
    description: "Analyze",
    argument: "text",
    run: async () => ({ ok: true, content: "" }),
  },
  {
    name: "calculator",
    description: "Calculate",
    argument: "expression",
    run: async () => ({ ok: true, content: "" }),
  },
  {
    name: "generate_image",
    description: "Generate image",
    argument: "prompt",
    run: async () => ({ ok: true, content: "" }),
  },
];

describe("OmniAgent Nexus", () => {
  it("has a stable internal identity", () => {
    expect(NEXUS_ID).toBe("omniagent-nexus");
    expect(NEXUS_LABEL).toBe("OmniAgent Nexus");
  });

  it("routes coding requests to a coding-capable model", () => {
    const plan = nexusPlan(
      "Fix this TypeScript function",
      models,
      tools,
    );

    expect(plan.capability).toBe("coding");
    expect(plan.model?.id).toBe("cloud-fast");
  });

  it("selects research tools for research requests", () => {
    const plan = nexusPlan(
      "Search for the latest information and cite sources",
      models,
      tools,
    );

    expect(plan.capability).toBe("research");
    expect(plan.toolNames).toEqual([
      "web_search",
      "fetch_url",
      "analyze_text",
    ]);
  });

  it("selects reasoning tools for analytical requests", () => {
    const plan = nexusPlan(
      "Analyze why this approach fails step by step",
      models,
      tools,
    );

    expect(plan.capability).toBe("reasoning");
    expect(plan.toolNames).toEqual([
      "calculator",
      "analyze_text",
    ]);
  });

  it("retrieves memory for coding work", () => {
    const plan = nexusPlan(
      "Refactor this Python code",
      models,
      tools,
    );

    expect(plan.retrieveMemory).toBe(true);
  });

  it("retrieves memory for reasoning work", () => {
    const plan = nexusPlan(
      "Explain why this strategy is wrong",
      models,
      tools,
    );

    expect(plan.retrieveMemory).toBe(true);
  });

  it("retrieves memory for research work", () => {
    const plan = nexusPlan(
      "Research today's latest AI news",
      models,
      tools,
    );

    expect(plan.retrieveMemory).toBe(true);
  });

  it("uses a local model and disables memory for private requests", () => {
    const plan = nexusPlan(
      "Keep this private and local only",
      models,
      tools,
    );

    expect(plan.capability).toBe("private");
    expect(plan.model?.id).toBe("local-private");
    expect(plan.retrieveMemory).toBe(false);
    expect(plan.toolNames).toEqual([]);
  });
  it("refuses cloud routing for private requests when no local model exists", () => {
    const cloudOnlyModels = models.filter(
      (model) => model.execution === "cloud",
    );

    const plan = nexusPlan(
      "Keep this private and local only",
      cloudOnlyModels,
      tools,
    );

    expect(plan.capability).toBe("private");
    expect(plan.model).toBeUndefined();
    expect(plan.retrieveMemory).toBe(false);
  });

  it("requires a vision-capable model for image input", () => {
    const plan = nexusPlan(
      "Explain this image",
      models,
      tools,
      true,
    );

    expect(plan.model?.vision).toBe(true);
    expect(plan.model?.id).toBe("vision-reasoning");
  });

  it("only selects tools that actually exist", () => {
    const limitedTools = tools.filter(
      (tool) =>
        tool.name === "web_search",
    );

    const plan = nexusPlan(
      "Search for current information",
      models,
      limitedTools,
    );

    expect(plan.toolNames).toEqual([
      "web_search",
    ]);
  });
});
