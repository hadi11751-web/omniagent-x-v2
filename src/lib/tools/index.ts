import { analyzeTextTool } from "./analyzeText";
import { calculatorTool } from "./calculator";
import { fetchUrlTool } from "./fetchUrl";
import { generateImageTool, imageGenerationAvailable } from "./generateImage";
import { generatePdfTool } from "./generatePdf";
import { inspectPdfTool } from "./inspectPdf";
import { webSearchTool } from "./webSearch";
import type { PrivacyPolicy } from "@/lib/privacy";
import type { ToolDefinition, ToolResult } from "@/lib/types";

/** Every tool in the catalog, regardless of which server keys are configured. */
export const ALL_TOOLS: ToolDefinition[] = [
  webSearchTool,
  fetchUrlTool,
  calculatorTool,
  analyzeTextTool,
  generateImageTool,
  generatePdfTool,
  inspectPdfTool,
];

/**
 * The tools whose work puts something on the public internet, or in another
 * company's model. `generate_pdf`, `inspect_pdf`, `calculator` and
 * `analyze_text` only ever touch bytes already in the request, so they stay
 * available under a privacy request.
 */
const EXTERNAL_TOOLS = new Set(["web_search", "fetch_url", "generate_image"]);

export function availableTools(policy?: PrivacyPolicy): ToolDefinition[] {
  return ALL_TOOLS.filter((tool) => {
    if (tool.name === "generate_image" && !imageGenerationAvailable()) {
      return false;
    }

    /*
     * `requested`, not `localOnly`. A turn the user marked private that no
     * local model can serve still has no business calling out to a search
     * engine or an image API: the reply may have to come from a cloud chat
     * provider, but nothing else about the request leaves.
     */
    if (policy?.requested && EXTERNAL_TOOLS.has(tool.name)) {
      return false;
    }

    return true;
  });
}

export function findTool(
  name: string,
  policy?: PrivacyPolicy,
): ToolDefinition | undefined {
  const normalised = name.trim().toLowerCase();
  return availableTools(policy).find((tool) => tool.name === normalised);
}

/**
 * A tool is an untrusted boundary: a parser, PDF library, DNS operation, or
 * upstream provider can still throw even though every shipped tool normally
 * returns a ToolResult. Keep that failure inside the tool protocol so one bad
 * tool call cannot tear down the streaming chat request.
 */
export async function runToolSafely(
  tool: ToolDefinition,
  input: string,
  signal?: AbortSignal,
): Promise<ToolResult> {
  try {
    return await tool.run(input, signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown tool failure";
    return {
      ok: false,
      content: `${tool.name} error: ${message}`,
    };
  }
}

/** Prompt fragment describing the tool protocol the model must follow. */
export function toolInstructions(tools: ToolDefinition[]): string {
  if (!tools.length) return "";
  return [
    "You can call tools. To call one, reply with ONLY this single line and nothing else:",
    "TOOL: <name> | <argument>",
    "The tool result is then given back to you, and you answer the user using it.",
    "Call a tool only when it genuinely helps. Never invent a tool result.",
    "Text tool calls use the TOOL: <name> | <argument> form. If the backend uses native function calling, the application will translate that call into the same tool protocol before execution.",
    "Available tools:",
    ...tools.map((tool) => `- ${tool.name}: ${tool.description} Argument: ${tool.argument}.`),
  ].join("\n");
}

const CALL_PATTERN = /^\s*TOOL:\s*([a-z_]+)\s*\|\s*([\s\S]+)$/i;
const SIMPLE_IMAGE_PATTERN = /^\s*(?:generate_image|generate\s+image)\s*(?:of|:|-)?\s*(.+)$/i;

/**
 * What the reader was meant to see of a reasoning model's reply: everything
 * outside its reasoning block, which the model marks with a `think` tag pair.
 *
 * A block that never closes is dropped too, because a stream that ended mid-thought
 * has no answer after it. The mid-stream path in the chat route holds text back
 * while a block is open and then removes it from what it forwards, but the buffer
 * is also flushed at the end of a turn, at the tool-failure fallback, and into the
 * saved history — and a raw flush there sends the whole reasoning block to the
 * reader. One function for all four is what keeps them from diverging again.
 */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trimStart();
}

export function parseToolCall(text: string): { name: string; argument: string } | undefined {
  const raw = text.trim();

  const direct = raw.match(CALL_PATTERN);
  if (direct) {
    return {
      name: direct[1].toLowerCase(),
      argument: direct[2].trim(),
    };
  }

  const withoutThink = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();

  const cleaned = withoutThink.match(CALL_PATTERN);
  if (cleaned) {
    return {
      name: cleaned[1].toLowerCase(),
      argument: cleaned[2].trim(),
    };
  }

  const image = withoutThink.match(SIMPLE_IMAGE_PATTERN);
  if (image) {
    return {
      name: "generate_image",
      argument: image[1].trim(),
    };
  }

  return undefined;
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

