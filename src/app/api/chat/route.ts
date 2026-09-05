import { StreamAbortedError } from "@/lib/http";
import { runAgentPlan } from "@/lib/agent";
import { getRelevantMemories } from "@/lib/server/memory";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/models";
import { availableModels, providerFor, PROVIDERS } from "@/lib/providers";
import { checkAndConsumeQuota } from "@/lib/quota";
import { acquireConcurrency } from "@/lib/concurrency";
import { classify, routeModel } from "@/lib/router";
import {
  rankFailoverCandidates,
  streamWithFailover,
} from "@/lib/provider-resilience";
import { collectText, createEventStream, type StreamEvent } from "@/lib/stream";
import {
  availableTools,
  findTool,
  parseNativeToolCall,
  parseToolCall,
  toolInstructions,
} from "@/lib/tools";
import { searchWeb } from "@/lib/tools/webSearch";
import { isDirectImageRequest, extractImagePrompt } from "@/lib/imageRequest";
import type { ChatMessage, ChatProvider, ModelInfo, Source } from "@/lib/types";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";
export const maxDuration = 120;

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
  const payload = (data ?? {}) as {
    sources?: Source[];
    image?: string;
    file?: { dataUrl: string; filename: string };
  };
  return payload;
}

export async function POST(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return badRequest("request body must be JSON");
  }

  const history = (body.messages ?? []).filter(
    (message) =>
      typeof message?.content === "string" &&
      (message.content.trim().length > 0 ||
        (message.images?.length ?? 0) > 0),
  );

  if (!history.length) {
    return badRequest("messages must contain at least one entry");
  }

  const quota = await checkAndConsumeQuota(userId);
  if (!quota.allowed) {
    return Response.json(
      {
        error: `You've used today's ${quota.limit} free messages. Upgrade for unlimited access, or come back tomorrow.`,
        upgradeRequired: true,
      },
      { status: 429 },
    );
  }

  const directUserMessage = [...history]
    .reverse()
    .find((message) => message.role === "user");

  const directUserText = directUserMessage?.content ?? "";

  /*
   * Direct image requests have their own provider and must not depend on
   * Gemini, Groq, Hugging Face, or another chat provider being available.
   */
  if (
    body.mode !== "blend" &&
    body.mode !== "agent" &&
    body.toolsEnabled !== false &&
    isDirectImageRequest(directUserText)
  ) {
    const imageTool = findTool("generate_image");

    if (!imageTool) {
      return Response.json(
        {
          error:
            "Image generation is currently unavailable. The image provider is not configured.",
        },
        { status: 503 },
      );
    }

    const concurrency = await acquireConcurrency(userId);

    if (!concurrency.acquired) {
      return Response.json(
        {
          error:
            "Too many requests are already running for this account. Please wait for one to finish before starting another.",
          concurrencyLimit: concurrency.limit,
        },
        { status: 429 },
      );
    }

    return createEventStream(async (emit) => {
      try {
        emit({
          type: "meta",
          model: "direct-tool",
          provider: "Pollinations",
          execution: "cloud",
          capability: "image",
          mode: body.mode ?? "chat",
        });

        emit({
          type: "status",
          text: "Generating image...",
        });

        const prompt = extractImagePrompt(directUserText);

        if (!prompt) {
          emit({
            type: "error",
            message: "Image prompt is empty.",
          });
          return;
        }

        const result = await imageTool.run(prompt);

        emitToolResult(
          emit,
          imageTool.name,
          prompt,
          result.ok,
          result.content,
          result.data,
        );

        if (!result.ok) {
          emit({
            type: "error",
            message: result.content,
          });
          return;
        }

        emit({
          type: "status",
          text: "Image generated successfully.",
        });
      } finally {
        await concurrency.release();
      }
    });
  }

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
  const lastUserMessage = [...history]
    .reverse()
    .find((message) => message.role === "user");

  const lastUser = lastUserMessage?.content ?? "";
  const hasImages = Boolean(lastUserMessage?.images?.length);

  let model: ModelInfo | undefined;
  let capability: string | undefined;

  if (body.autoRoute) {
    const routed = routeModel(lastUser, models);
    model = routed.model;
    capability = routed.capability;
  } else {
    model =
      models.find((candidate) => candidate.id === body.model) ??
      models[0];
  }

  let switchedForVision = false;

  if (hasImages && !model?.vision) {
    const visionModel = models.find((candidate) => candidate.vision);

    if (visionModel) {
      model = visionModel;
      switchedForVision = true;
    } else {
      return badRequest(
        "no vision-capable model is configured (add GROQ_API_KEY to enable image understanding)",
      );
    }
  }

  if (!model) {
    return badRequest("no usable model");
  }

  const provider = providerFor(model.id);

  if (!provider) {
    return badRequest(`no provider for model ${model.id}`);
  }

  const concurrency = await acquireConcurrency(userId);

  if (!concurrency.acquired) {
    return Response.json(
      {
        error: `Too many requests are already running for this account. Please wait for one to finish before starting another.`,
        concurrencyLimit: concurrency.limit,
      },
      { status: 429 },
    );
  }

  let streamOwnsConcurrency = false;

  try {
    const toolsEnabled = body.toolsEnabled !== false && mode !== "blend";
  const tools = toolsEnabled ? availableTools() : [];

  const systemParts = [DEFAULT_SYSTEM_PROMPT];

  if (body.projectContext?.trim()) {
    systemParts.push(
      `Project context:\n${body.projectContext.trim()}`,
    );
  }

  if (body.memory?.trim()) {
    systemParts.push(
      `Long-term memory the user saved:\n${body.memory.trim()}`,
    );
  }

  try {
    const automaticMemories = await getRelevantMemories(
      userId,
      lastUser,
    );

    if (automaticMemories.length) {
      systemParts.push(
        `Automatically remembered from previous chats:\n${automaticMemories
          .map((memory) => `- ${memory.fact}`)
          .join("\n")}`,
      );
    }
  } catch (error) {
    console.error("automatic_memory_retrieval_failed", error);
  }

  const systemWithoutTools = systemParts.join("\n\n");

  if (tools.length) {
    systemParts.push(toolInstructions(tools));
  }

  const baseMessages: ChatMessage[] = [
    {
      role: "system",
      content: systemParts.join("\n\n"),
    },
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.images?.length
        ? { images: message.images }
        : {}),
    })),
  ];

  const response = createEventStream(async (emit) => {
    try {
    emit({
      type: "meta",
      model: model.label,
      provider: provider.label,
      execution: model.execution,
      capability,
      mode,
    });

    if (switchedForVision) {
      emit({
        type: "status",
        text: `Switched to ${model.label} to read the attached image.`,
      });
    }

    const signal = request.signal;
    const conversation = [...baseMessages];

    if (mode === "research") {
      await runResearch(
        lastUser,
        conversation,
        emit,
        signal,
      );
    }

    if (mode === "blend") {
      await runBlend(
        model,
        provider,
        conversation,
        emit,
        signal,
      );
      return;
    }

    if (mode === "agent") {
      await runAgentPlan(
        provider,
        model,
        lastUser,
        conversation,
        emit,
        signal,
      );
    }

    await streamWithTools(
      provider,
      model,
      conversation,
      mode === "agent" ? false : tools.length > 0,
      systemWithoutTools,
      emit,
      signal,
      models,
    );
    } finally {
      await concurrency.release();
    }
  });

  streamOwnsConcurrency = true;
  return response;
  } finally {
    if (!streamOwnsConcurrency) {
      await concurrency.release();
    }
  }
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
      emit({
        type: "status",
        text: `${engine} returned no results; answering from model knowledge only.`,
      });
      return;
    }

    emit({ type: "sources", sources });

    emit({
      type: "tool",
      name: "web_search",
      argument: query,
      ok: true,
      summary: `${sources.length} results via ${engine}`,
    });

    conversation.push({
      role: "system",
      content: [
        `Search results from ${engine}. Use them and cite with [n] markers.`,
        ...sources.map(
          (source, index) =>
            `[${index + 1}] ${source.title} - ${source.url}\n${source.snippet ?? ""}`,
        ),
      ].join("\n"),
    });
  } catch (error) {
    emit({
      type: "status",
      text: `Search unavailable: ${(error as Error).message}`,
    });
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

    emit({
      type: "status",
      text: `Asking ${participant.label}...`,
    });

    try {
      const text = await collectText(
        participantProvider,
        participant.id,
        conversation,
        signal,
      );

      if (text) {
        answers.push({
          label: `${participant.label} (${participantProvider.label})`,
          text,
        });
      }
    } catch (error) {
      emit({
        type: "status",
        text: `${participant.label} failed: ${(error as Error).message}`,
      });
    }
  }

  if (!answers.length) {
    emit({
      type: "error",
      message: "every provider in the blend failed",
    });
    return;
  }

  if (answers.length === 1) {
    emit({
      type: "status",
      text: "Only one provider is configured, showing its answer directly.",
    });

    emit({
      type: "delta",
      text: answers[0].text,
    });

    return;
  }

  emit({
    type: "status",
    text: `Synthesising ${answers.length} answers...`,
  });

  const synthesis: ChatMessage[] = [
    {
      role: "system",
      content:
        "You merge several draft answers into one. Keep what is correct, drop contradictions, and note disagreements briefly.",
    },
    ...conversation.filter((message) => message.role !== "system"),
    {
      role: "user",
      content: answers
        .map(
          (answer) =>
            `### ${answer.label}\n${answer.text}`,
        )
        .join("\n\n"),
    },
  ];

  for await (
    const chunk of streamWithFailover(
      {
        model: primary,
        provider: primaryProvider,
      },
      {
        model: primary.id,
        messages: synthesis,
        signal,
      },
      rankFailoverCandidates(
        {
          model: primary,
          provider: primaryProvider,
        },
        models,
        PROVIDERS,
        "reasoning",
        false,
        false,
      ),
    )
  ) {
    emit({
      type: "delta",
      text: chunk.text,
    });
  }
}

function getRequestedCapability(
  conversation: ChatMessage[],
): string | undefined {
  const lastUserMessage = [...conversation]
    .reverse()
    .find((message) => message.role === "user");

  if (!lastUserMessage?.content?.trim()) {
    return undefined;
  }

  return classify(lastUserMessage.content);
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

  if (payload.sources?.length) {
    emit({
      type: "sources",
      sources: payload.sources,
    });
  }

  if (payload.image) {
    emit({
      type: "image",
      dataUrl: payload.image,
    });
  }

  if (payload.file) {
    emit({
      type: "file",
      dataUrl: payload.file.dataUrl,
      filename: payload.file.filename,
    });
  }
}

async function streamWithTools(
  provider: ChatProvider,
  primaryModel: ModelInfo,
  conversation: ChatMessage[],
  toolsEnabled: boolean,
  systemWithoutTools: string,
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
  models: ModelInfo[],
) {
  let toolsAllowed = toolsEnabled;

  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const isLastStep = step === MAX_TOOL_STEPS - 1;
    const allowTools = toolsAllowed && !isLastStep;

    let held = allowTools;
    let buffer = "";
    let emitted = false;
    let call: { name: string; argument: string } | undefined;

    const primary = {
      model: primaryModel,
      provider,
    };

    const alternatives = rankFailoverCandidates(
      primary,
      models,
      PROVIDERS,
      getRequestedCapability(conversation),
      Boolean(
        conversation.some(
          (message) =>
            message.images && message.images.length > 0,
        ),
      ),
      false,
    );

    try {
      for await (
        const chunk of streamWithFailover(
          primary,
          {
            model: primaryModel.id,
            messages: conversation,
            signal,
          },
          alternatives,
        )
      ) {
        if (chunk.provider.id !== provider.id) {
          emit({
            type: "status",
            text: `Switched to ${chunk.model.label} because ${provider.label} was unavailable.`,
          });
        }

        if (!held) {
          emitted = true;
          emit({
            type: "delta",
            text: chunk.text,
          });
          continue;
        }

        buffer += chunk.text;

        const cleaned = buffer
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .trimStart();

        const hasOpenThink =
          /<think>/i.test(buffer) && !/<\/think>/i.test(buffer);

        const looksLikeTool =
          /^(?:TOOL\s*:|generate_image\b|generate\s+image\b)/i.test(
            cleaned,
          );

        if (looksLikeTool) {
          const parsed = parseToolCall(cleaned);

          if (parsed) {
            call = parsed;
            buffer = cleaned;
            break;
          }

          continue;
        }

        if (hasOpenThink) continue;
        if (!cleaned) continue;
        if (cleaned.length < 5) continue;

        held = false;
        emitted = true;

        emit({
          type: "delta",
          text: cleaned,
        });

        buffer = "";
      }

    } catch (error) {
      if (signal.aborted) return;

      const aborted =
        error instanceof StreamAbortedError
          ? error
          : undefined;

      const native = aborted
        ? parseNativeToolCall(aborted.failedGeneration)
        : undefined;

      if (!native || emitted) {
        if (emitted) {
          emit({
            type: "error",
            message: (error as Error).message,
          });
        } else if (
          !(await retryWithoutTools(
            provider,
            primaryModel.id,
            conversation,
            systemWithoutTools,
            emit,
            signal,
            models,
          ))
        ) {
          emit({
            type: "error",
            message: (error as Error).message,
          });
        }

        return;
      }

      call = native;
      buffer = `TOOL: ${native.name} | ${native.argument}`;
    }

    if (!call && !held) {
      if (buffer) {
        emit({
          type: "delta",
          text: buffer,
        });
      } else if (
        !emitted &&
        !(await retryWithoutTools(
          provider,
          primaryModel.id,
          conversation,
          systemWithoutTools,
          emit,
          signal,
          models,
        ))
      ) {
        emit({
          type: "status",
          text: "The model returned an empty response.",
        });
      }

      return;
    }

    if (!call) {
      call = parseToolCall(buffer);

      if (!call) {
        if (buffer.trim()) {
          emit({
            type: "delta",
            text: buffer,
          });
        } else if (
          !(await retryWithoutTools(
            provider,
            primaryModel.id,
            conversation,
            systemWithoutTools,
            emit,
            signal,
            models,
          ))
        ) {
          emit({
            type: "status",
            text: "The model returned an empty response.",
          });
        }

        return;
      }
    }

    const tool = findTool(call.name);

    if (!tool) {
      conversation.push({
        role: "assistant",
        content: buffer.trim(),
      });

      conversation.push({
        role: "system",
        content: `Tool "${call.name}" does not exist. Answer without tools.`,
      });

      toolsAllowed = false;
      continue;
    }

    emit({
      type: "status",
      text: `Running ${tool.name}...`,
    });

    const result = await tool.run(call.argument);

    emitToolResult(
      emit,
      tool.name,
      call.argument,
      result.ok,
      result.content,
      result.data,
    );

    conversation.push({
      role: "assistant",
      content: buffer.trim(),
    });

    conversation.push({
      role: "system",
      content: `Result of ${tool.name}(${call.argument}):\n${result.content}\nNow answer the user. Do not call another tool unless it is essential.`,
    });
  }

  if (
    !(await retryWithoutTools(
      provider,
      primaryModel.id,
      conversation,
      systemWithoutTools,
      emit,
      signal,
      models,
    ))
  ) {
    emit({
      type: "status",
      text: "The model returned an empty response.",
    });
  }
}

async function retryWithoutTools(
  provider: ChatProvider,
  modelId: string,
  conversation: ChatMessage[],
  systemWithoutTools: string,
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
  models: ModelInfo[],
): Promise<boolean> {
  const primaryModel = models.find((model) => model.id === modelId);

  if (!primaryModel) return false;
  if (signal.aborted) return true;

  const messages: ChatMessage[] = conversation.map(
    (message, index) =>
      index === 0 && message.role === "system"
        ? {
            role: "system",
            content: systemWithoutTools,
          }
        : message,
  );

  emit({
    type: "status",
    text: "Answering without tools...",
  });

  let emitted = false;

  const primaryProvider = providerFor(primaryModel.id);

  if (!primaryProvider) return false;

  const alternatives = rankFailoverCandidates(
    {
      model: primaryModel,
      provider: primaryProvider,
    },
    models,
    PROVIDERS,
    getRequestedCapability(conversation),
    Boolean(
      conversation.some(
        (message) =>
          message.images && message.images.length > 0,
      ),
    ),
    false,
  );

  try {
    for await (
      const chunk of streamWithFailover(
        {
          model: primaryModel,
          provider: primaryProvider,
        },
        {
          model: primaryModel.id,
          messages,
          signal,
        },
        alternatives,
      )
    ) {
      emitted = true;

      emit({
        type: "delta",
        text: chunk.text,
      });
    }
  } catch (error) {
    if (!emitted) {
      emit({
        type: "error",
        message: (error as Error).message,
      });
      return false;
    }
  }

  return emitted;
}
