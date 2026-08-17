import { analyzeTextTool } from "./analyzeText";
import { calculatorTool } from "./calculator";
import { fetchUrlTool } from "./fetchUrl";
import { generateImageTool, imageGenerationAvailable } from "./generateImage";
import { webSearchTool } from "./webSearch";
import type { ToolDefinition } from "@/lib/types";

const ALL_TOOLS: ToolDefinition[] = [
  webSearchTool,
  fetchUrlTool,
  calculatorTool,
  analyzeTextTool,
  generateImageTool,
];

export function availableTools(): ToolDefinition[] {
  return ALL_TOOLS.filter((tool) => tool.name !== "generate_image" || imageGenerationAvailable());
}

export function findTool(name: string): ToolDefinition | undefined {
  return availableTools().find((tool) => tool.name === name);
}

/** Prompt fragment describing the tool protocol the model must follow. */
export function toolInstructions(tools: ToolDefinition[]): string {
  if (!tools.length) return "";
  return [
    "You can call tools. To call one, reply with ONLY this single line and nothing else:",
    "TOOL: <name> | <argument>",
    "The tool result is then given back to you, and you answer the user using it.",
    "Call a tool only when it genuinely helps. Never invent a tool result.",
    "Available tools:",
    ...tools.map((tool) => `- ${tool.name}: ${tool.description} Argument: ${tool.argument}.`),
  ].join("\n");
}

const CALL_PATTERN = /^\s*TOOL:\s*([a-z_]+)\s*\|\s*([\s\S]+)$/i;

export function parseToolCall(text: string): { name: string; argument: string } | undefined {
  const match = text.trim().match(CALL_PATTERN);
  if (!match) return undefined;
  return { name: match[1].toLowerCase(), argument: match[2].trim() };
}
