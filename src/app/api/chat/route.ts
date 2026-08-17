import { StreamAbortedError } from "@/lib/http";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/models";
import { availableModels, providerFor } from "@/lib/providers";
import { routeModel } from "@/lib/router";
import { collectText, createEventStream, type StreamEvent } from "@/lib/stream";
import {
  availableTools,
  findTool,
  parseNativeToolCall,
  parseToolCall,
  toolInstructions,
} from "@/lib/tools";
import { searchWeb } from "@/lib/tools/webSearch";
import type { ChatMessage, ChatProvider, ModelInfo, Source } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

type Mode = "chat" | "research" | "blend" | "agent";

interface Body {
  messages?: ChatMessage[];
  model?: string;
  mode?: Mode;
  autoRoute?: boolean;
  toolsEnabled?: boolean;
  memory?: string;
  projectContext?: string;
}

const MAX_TOOL_STEPS = 3;

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

function toolData(data: unknown) {
  const payload = (data ?? {}) as { sources?: Source[]; image?: string };
  return payload;
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return badRequest("request body must be JSON");
  }

  const history = (body.messages ?? []).filter(
    (message) => typeof message?.content === "string" && message.content.trim().length > 0,
  );
  if (!history.length) return badRequest("messages must contain at least one entry");

  const models = availableModels();
  if (!models.length) {
    return Response.json(
      {
        error:
          "No AI provider is configured. Add GROQ_API_KEY (or GEMINI_API_KEY / OPENROUTER_API_KEY / HUGGINGFACE_API_KEY) to .env.local and restart the server.",
      },
      { status: 503 },
    );
  }

  const mode: Mode = body.mode ?? "chat";
  const lastUser = [...history].reverse().find((message) => message.role === "user")?.content ?? "";

  let model: ModelInfo | undefined;
  let capability: string | undefined;
  if (body.autoRoute) {
    const routed = routeModel(lastUser, models);
    model = routed.model;
    capability = routed.capability;
  } else {
    model = models.find((candidate) => candidate.id === body.model) ?? models[0];
  }
  if (!model) return badRequest("no usable model");
  const provider = providerFor(model.id);
  if (!provider) return badRequest(`no provider for model ${model.id}`);

  const toolsEnabled = body.toolsEnabled !== false && mode !== "blend";
  const tools = toolsEnabled ? availableTools() : [];

  const systemParts = [DEFAULT_SYSTEM_PROMPT];
  if (body.projectContext?.trim()) systemParts.push(`Project context:\n${body.projectContext.trim()}`);
  if (body.memory?.trim()) systemParts.push(`Long-term memory the user saved:\n${body.memory.trim()}`);
  const systemWithoutTools = systemParts.join("\n\n");
  if (tools.length) systemParts.push(toolInstructions(tools));

  const baseMessages: ChatMessage[] = [
    { role: "system", content: systemParts.join("\n\n") },
    ...history.map((message) => ({ role: message.role, content: message.content })),
  ];

  return createEventStream(async (emit) => {
    emit({
      type: "meta",
      model: model.label,
      provider: provider.label,
      execution: model.execution,
      capability,
      mode,
    });

    const signal = request.signal;
    const conversation = [...baseMessages];

    if (mode === "research") {
      await runResearch(lastUser, conversation, emit, signal);
    }

    if (mode === "blend") {
      await runBlend(model, provider, conversation, emit, signal);
      return;
    }

    if (mode === "agent") {
      await runAgentPlan(provider, model, lastUser, conversation, emit, signal);
    }

    await streamWithTools(
      provider,
      model.id,
      conversation,
      tools.length > 0,
      systemWithoutTools,
      emit,
      signal,
    );
  });
}

async function runResearch(
  query: string,
  conversation: ChatMessage[],
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
) {
  emit({ type: "status", text: "Searching the web..." });
  try {
    const { sources, engine } = await searchWeb(query);
    if (!sources.length) {
      emit({ type: "status", text: `${engine} returned no results; answering from model knowledge only.` });
      return;
    }
    emit({ type: "sources", sources });
    emit({ type: "tool", name: "web_search", argument: query, ok: true, summary: `${sources.length} results via ${engine}` });
    conversation.push({
      role: "system",
      content: [
        `Search results from ${engine}. Use them and cite with [n] markers.`,
        ...sources.map((source, index) => `[${index + 1}] ${source.title} - ${source.url}\n${source.snippet ?? ""}`),
      ].join("\n"),
    });
  } catch (error) {
    emit({ type: "status", text: `Search unavailable: ${(error as Error).message}` });
  }
  void signal;
}

async function runBlend(
  primary: ModelInfo,
  primaryProvider: ChatProvider,
  conversation: ChatMessage[],
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
) {
  const models = availableModels();
  const seen = new Set<string>();
  const participants = models
    .filter((candidate) => {
      if (seen.has(candidate.provider)) return false;
      seen.add(candidate.provider);
      return true;
    })
    .slice(0, 3);

  const answers: { label: string; text: string }[] = [];
  for (const participant of participants) {
    const participantProvider = providerFor(participant.id);
    if (!participantProvider) continue;
    emit({ type: "status", text: `Asking ${participant.label}...` });
    try {
      const text = await collectText(participantProvider, participant.id, conversation, signal);
      if (text) answers.push({ label: `${participant.label} (${participantProvider.label})`, text });
    } catch (error) {
      emit({ type: "status", text: `${participant.label} failed: ${(error as Error).message}` });
    }
  }

  if (!answers.length) {
    emit({ type: "error", message: "every provider in the blend failed" });
    return;
  }
  if (answers.length === 1) {
    emit({ type: "status", text: "Only one provider is configured, showing its answer directly." });
    emit({ type: "delta", text: answers[0].text });
    return;
  }

  emit({ type: "status", text: `Synthesising ${answers.length} answers...` });
  const synthesis: ChatMessage[] = [
    {
      role: "system",
      content:
        "You merge several draft answers into one. Keep what is correct, drop contradictions, and note disagreements briefly.",
    },
    ...conversation.filter((message) => message.role !== "system"),
    {
      role: "user",
      content: answers.map((answer) => `### ${answer.label}\n${answer.text}`).join("\n\n"),
    },
  ];
  for await (const chunk of primaryProvider.stream({ model: primary.id, messages: synthesis, signal })) {
    emit({ type: "delta", text: chunk });
  }
}

async function runAgentPlan(
  provider: ChatProvider,
  model: ModelInfo,
  goal: string,
  conversation: ChatMessage[],
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
) {
  const tools = availableTools();
  if (!tools.length) return;
  emit({ type: "status", text: "Planning..." });
  const planPrompt: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are the planner of a controlled agent. Break the goal into at most 3 steps.",
        "Each line must be exactly: STEP: <tool> | <argument>",
        `Allowed tools: ${tools.map((tool) => tool.name).join(", ")}.`,
        "If no tool is needed, answer exactly: NO_TOOLS.",
        "Never plan destructive or irreversible actions.",
      ].join("\n"),
    },
    { role: "user", content: goal },
  ];

  let plan = "";
  try {
    plan = await collectText(provider, model.id, planPrompt, signal);
  } catch (error) {
    emit({ type: "status", text: `Planner failed, answering directly: ${(error as Error).message}` });
    return;
  }
  if (/NO_TOOLS/i.test(plan)) {
    emit({ type: "status", text: "Planner decided no tools are needed." });
    return;
  }

  const steps = plan
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*STEP:\s*([a-z_]+)\s*\|\s*(.+)$/i))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .slice(0, 3);

  if (!steps.length) {
    emit({ type: "status", text: "Planner produced no usable steps; answering directly." });
    return;
  }

  for (const [, name, argument] of steps) {
    const tool = findTool(name.toLowerCase());
    if (!tool) continue;
    emit({ type: "status", text: `Running ${tool.name}...` });
    const result = await tool.run(argument.trim());
    emitToolResult(emit, tool.name, argument.trim(), result.ok, result.content, result.data);
    conversation.push({
      role: "system",
      content: `Result of ${tool.name}(${argument.trim()}):\n${result.content}`,
    });
  }
  emit({ type: "status", text: "Verifying and writing the answer..." });
}

function emitToolResult(
  emit: (event: StreamEvent) => void,
  name: string,
  argument: string,
  ok: boolean,
  content: string,
  data: unknown,
) {
  emit({
    type: "tool",
    name,
    argument,
    ok,
    summary: ok ? content.slice(0, 160) : content,
  });
  const payload = toolData(data);
  if (payload.sources?.length) emit({ type: "sources", sources: payload.sources });
  if (payload.image) emit({ type: "image", dataUrl: payload.image });
}

/**
 * Streams the answer, but holds back the first characters so a `TOOL:` line is
 * executed instead of being shown to the user.
 */
async function streamWithTools(
  provider: ChatProvider,
  modelId: string,
  conversation: ChatMessage[],
  toolsEnabled: boolean,
  systemWithoutTools: string,
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
) {
  let toolsAllowed = toolsEnabled;

  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const isLastStep = step === MAX_TOOL_STEPS - 1;
    const allowTools = toolsAllowed && !isLastStep;
    let held = allowTools;
    let buffer = "";
    let emitted = false;
    let call: { name: string; argument: string } | undefined;

    try {
      for await (const chunk of provider.stream({ model: modelId, messages: conversation, signal })) {
        if (!held) {
          emitted = true;
          emit({ type: "delta", text: chunk });
          continue;
        }
        buffer += chunk;
        const trimmed = buffer.trimStart();
        if (trimmed.length < 5) continue;
        if (/^tool:/i.test(trimmed)) continue;
        held = false;
        emitted = true;
        emit({ type: "delta", text: buffer });
        buffer = "";
      }
    } catch (error) {
      if (signal.aborted) return;
      // Models that were trained for native tool calls sometimes emit one, and
      // the provider then aborts the stream. Run the requested tool instead of
      // leaving the answer blank.
      const aborted = error instanceof StreamAbortedError ? error : undefined;
      const native = aborted ? parseNativeToolCall(aborted.failedGeneration) : undefined;
      if (!native || emitted) {
        if (emitted) emit({ type: "error", message: (error as Error).message });
        else if (!(await retryWithoutTools(provider, modelId, conversation, systemWithoutTools, emit, signal))) {
          emit({ type: "error", message: (error as Error).message });
        }
        return;
      }
      call = native;
      buffer = `TOOL: ${native.name} | ${native.argument}`;
    }

    if (!call && !held) {
      if (buffer) emit({ type: "delta", text: buffer });
      else if (!emitted && !(await retryWithoutTools(provider, modelId, conversation, systemWithoutTools, emit, signal))) {
        emit({ type: "status", text: "The model returned an empty response." });
      }
      return;
    }

    if (!call) {
      call = parseToolCall(buffer);
      if (!call) {
        if (buffer.trim()) {
          emit({ type: "delta", text: buffer });
        } else if (!(await retryWithoutTools(provider, modelId, conversation, systemWithoutTools, emit, signal))) {
          emit({ type: "status", text: "The model returned an empty response." });
        }
        return;
      }
    }

    const tool = findTool(call.name);
    if (!tool) {
      conversation.push({ role: "assistant", content: buffer.trim() });
      conversation.push({ role: "system", content: `Tool "${call.name}" does not exist. Answer without tools.` });
      toolsAllowed = false;
      continue;
    }
    emit({ type: "status", text: `Running ${tool.name}...` });
    const result = await tool.run(call.argument);
    emitToolResult(emit, tool.name, call.argument, result.ok, result.content, result.data);
    conversation.push({ role: "assistant", content: buffer.trim() });
    conversation.push({
      role: "system",
      content: `Result of ${tool.name}(${call.argument}):\n${result.content}\nNow answer the user. Do not call another tool unless it is essential.`,
    });
  }

  // Every step ran a tool and none produced an answer: ask once more, tool-free.
  if (!(await retryWithoutTools(provider, modelId, conversation, systemWithoutTools, emit, signal))) {
    emit({ type: "status", text: "The model returned an empty response." });
  }
}

/**
 * Last resort when a tool-enabled turn produced no visible text: ask again with
 * the tool protocol removed, so the user always gets an answer.
 * Returns true when some text was streamed.
 */
async function retryWithoutTools(
  provider: ChatProvider,
  modelId: string,
  conversation: ChatMessage[],
  systemWithoutTools: string,
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<boolean> {
  const messages: ChatMessage[] = conversation.map((message, index) =>
    index === 0 && message.role === "system" ? { role: "system", content: systemWithoutTools } : message,
  );
  if (signal.aborted) return true;
  emit({ type: "status", text: "Answering without tools..." });
  let emitted = false;
  try {
    for await (const chunk of provider.stream({ model: modelId, messages, signal })) {
      emitted = true;
      emit({ type: "delta", text: chunk });
    }
  } catch (error) {
    if (!emitted) {
      emit({ type: "error", message: (error as Error).message });
      return true;
    }
  }
  return emitted;
}
