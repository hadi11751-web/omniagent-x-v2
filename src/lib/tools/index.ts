import { analyzeTextTool } from "./analyzeText";
import { calculatorTool } from "./calculator";
import { fetchUrlTool } from "./fetchUrl";
import { generateImageTool, imageGenerationAvailable } from "./generateImage";
import { generatePdfTool } from "./generatePdf";
import { inspectPdfTool } from "./inspectPdf";
import { webSearchTool } from "./webSearch";
import type { ToolDefinition } from "@/lib/types";

const ALL_TOOLS: ToolDefinition[] = [
  webSearchTool,
  fetchUrlTool,
  calculatorTool,
  analyzeTextTool,
  generateImageTool,
  generatePdfTool,
  inspectPdfTool,
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
    "Do not use function calls or JSON tool payloads; the line above is the only supported form.",
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

const ARGUMENT_KEYS = ["query", "expression", "url", "text", "prompt", "input"];

/**
 * Some models emit a native OpenAI-style tool call
 * (`{"name":"web_search","arguments":{"query":"..."}}`) instead of the text
 * protocol. This maps such a payload onto the registry.
 */
export function parseNativeToolCall(raw: string | undefined): { name: string; argument: string } | undefined {
  if (!raw) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const call = payload as { name?: unknown; arguments?: unknown };
  if (typeof call.name !== "string") return undefined;
  let args: unknown = call.arguments;
  if (typeof args === "string") {
    const text = args;
    try {
      args = JSON.parse(text);
    } catch {
      return { name: call.name.toLowerCase(), argument: text.trim() };
    }
  }
  if (!args || typeof args !== "object") return undefined;
  const entries = Object.entries(args as Record<string, unknown>).filter(
    ([, value]) => typeof value === "string" && value.trim().length > 0,
  ) as [string, string][];
  if (!entries.length) return undefined;
  const preferred = entries.find(([key]) => ARGUMENT_KEYS.includes(key.toLowerCase())) ?? entries[0];
  return { name: call.name.toLowerCase(), argument: preferred[1].trim() };
}

