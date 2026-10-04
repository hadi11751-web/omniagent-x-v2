import { StreamAbortedError, UpstreamError } from "@/lib/http";
import { runAgentPlan } from "@/lib/agent";
import { getRelevantMemories } from "@/lib/server/memory";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/models";
import {
  nexusModel,
  nexusProvider,
  NEXUS_NOT_CONFIGURED_MESSAGE,
} from "@/lib/nexus";
import {
  checkAndConsumeQuota,
  getPlan,
  refundQuota,
  type Plan,
} from "@/lib/quota";
import { acquireConcurrency, type ConcurrencyLease } from "@/lib/concurrency";
import { classify } from "@/lib/intent";
import {
  attachEvidence,
  evidenceTurn,
  privacyNotice,
  privacyPolicy,
  type PrivacyPolicy,
} from "@/lib/privacy";
import { streamWithRetry } from "@/lib/provider-resilience";
import { createEventStream, type StreamEvent } from "@/lib/stream";
import {
  availableTools,
  findTool,
  parseNativeToolCall,
  parseToolCall,
  runToolSafely,
  stripThinking,
  toolInstructions,
} from "@/lib/tools";
import { searchWeb } from "@/lib/tools/webSearch";
import {
  MAX_CHAT_BODY_BYTES,
  MAX_CONTEXT_FIELD_CHARS,
  MAX_HISTORY_MESSAGES,
  MAX_IMAGE_DATA_CHARS,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MESSAGE_CHARS,
  MAX_REQUEST_IMAGE_DATA_CHARS,
  MAX_TOOL_STEPS,
  isImageDataUrl,
} from "@/lib/limits";
import { isDirectImageRequest, extractImagePrompt } from "@/lib/imageRequest";
import {
  bodyAsRecord,
  decodeJsonBody,
  optionalText,
  readCappedBody,
  trimHistory,
} from "@/lib/server/guards";
import type { ChatMessage, Source } from "@/lib/types";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";
export const maxDuration = 120;

type Mode = "chat" | "research" | "agent";

interface Body {
  messages?: ChatMessage[];

  /**
   * "blend" is what older clients stored before there was only one model. It
   * is accepted and answered as plain chat; nothing else about the shape of
   * the request says which model to use, because there is only Nexus.
   */
  mode?: Mode | "blend";
  toolsEnabled?: boolean;

  /**
   * The notes the user wrote for themselves in settings, sent only while memory
   * is switched on. Kept as a separate field from `memoryEnabled` because the
   * flag is what governs the facts the server remembers on its own, which never
   * travel through here.
   */
  memory?: string;

  /** The settings switch, as this request is concerned with it. */
  memoryEnabled?: boolean;
  projectContext?: string;
}

function validateHistory(history: ChatMessage[]): string | undefined {
  let imageChars = 0;

  for (const message of history) {
    if (message.content.length > MAX_MESSAGE_CHARS) {
      return "message content is too large";
    }

    if (message.images === undefined) continue;

    if (!Array.isArray(message.images)) {
      return "invalid image payload";
    }

    if (message.images.length > MAX_IMAGES_PER_MESSAGE) {
      return "too many images in one message";
    }

    for (const image of message.images) {
      if (typeof image !== "string" || !isImageDataUrl(image)) {
        return "images must be base64 image data URLs";
      }

      if (image.length > MAX_IMAGE_DATA_CHARS) {
        return "one or more images are too large";
      }

      imageChars += image.length;
    }
  }

  if (imageChars > MAX_REQUEST_IMAGE_DATA_CHARS) {
    return "total image payload is too large";
  }

  return undefined;
}

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

/**
 * Consumes one unit of the daily allowance. Returns undefined when the
 * request may proceed, or the 429 response when it may not. Called only once
 * every other validation has passed, so rejected requests do not burn quota.
 */
async function quotaRejection(
  userId: string,
  plan: Plan,
): Promise<Response | undefined> {
  const quota = await checkAndConsumeQuota(userId, plan);

  if (quota.allowed) return undefined;

  return Response.json(
    {
      error: `You've used today's ${quota.limit} free messages. Upgrade for unlimited access, or come back tomorrow.`,
      upgradeRequired: true,
    },
    { status: 429 },
  );
}

interface ChatRun {
  concurrency: ConcurrencyLease;

  /** The plan charged for this message, resolved once for the whole request. */
  plan: Plan;
}

/**
 * The streaming route's copy of `beginRun`, which it cannot use because the
 * guard is written for routes that answer with one response object: the slot
 * here has to outlive the handler call and be released by the stream.
 *
 * What it must not be is laxer about holding that slot. A plan lookup or a quota
 * counter that throws used to leave the account one busy request poorer for the
 * rest of the process's life, because the release sat below the point that
 * failed and nothing else hands a local slot back.
 */
async function holdChatRun(userId: string): Promise<ChatRun | { rejection: Response }> {
  const concurrency = await acquireConcurrency(userId);

  if (!concurrency.acquired) {
    return {
      rejection: Response.json(
        {
          error:
            "Too many requests are already running for this account. Please wait for one to finish before starting another.",
          concurrencyLimit: concurrency.limit,
        },
        { status: 429 },
      ),
    };
  }

  try {
    const plan = await getPlan();
    const exceeded = await quotaRejection(userId, plan);

    if (exceeded) {
      await concurrency.release();

      return { rejection: exceeded };
    }

    return { concurrency, plan };
  } catch (error) {
    await concurrency.release().catch(() => undefined);

    throw error;
  }
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

  /*
   * The ceiling is applied to the bytes that arrive, not to the `content-length`
   * the client claims: a chunked upload carries no useful header, and reading it
   * with `request.json()` would have buffered the whole body first.
   */
  const incoming = await readCappedBody(request, MAX_CHAT_BODY_BYTES);

  if ("tooLarge" in incoming) {
    // 413, the same answer every other route gives for a size refusal; the
    // shapes below it stay 400.
    return Response.json(
      { error: "request body is too large" },
      { status: 413 },
    );
  }

  const decoded = decodeJsonBody(incoming.bytes);

  if ("invalidJson" in decoded) return badRequest("request body must be JSON");

  const record = bodyAsRecord(decoded.parsed);

  if (!record) return badRequest("request body must be a JSON object");

  const body = record as Body;

  /*
   * `Body` is a compile-time claim about JSON that arrived, so anything the
   * route calls string methods on is checked here once. A number in one of
   * these slots used to reach `.trim()` and turn a malformed request into a 500.
   */
  const projectContext = optionalText(body.projectContext);
  const savedMemory = optionalText(body.memory);

  const rawMessages = Array.isArray(body.messages)
    ? body.messages
    : [];

  const history = trimHistory(
    rawMessages.filter(
      (message) =>
        (message?.role === "user" || message?.role === "assistant") &&
        typeof message?.content === "string" &&
        (message.content.trim().length > 0 ||
          (message.images?.length ?? 0) > 0),
    ),
    MAX_HISTORY_MESSAGES,
  );

  if (!history.length) {
    return badRequest("messages must contain at least one entry");
  }

  if (
    body.mode !== undefined &&
    !["chat", "research", "blend", "agent"].includes(body.mode)
  ) {
    return badRequest("invalid mode");
  }

  const validationError = validateHistory(history);
  if (validationError) return badRequest(validationError);

  /*
   * Both fields are appended verbatim to the system prompt, so they are billed
   * as prompt tokens on every request. Capped well above what the app writes
   * (a project's context and the saved-memory block) but not without limit.
   */
  if ((projectContext?.length ?? 0) > MAX_CONTEXT_FIELD_CHARS) {
    return badRequest("project context is too large");
  }

  if ((savedMemory?.length ?? 0) > MAX_CONTEXT_FIELD_CHARS) {
    return badRequest("memory is too large");
  }

  const mode: Mode =
    body.mode === undefined || body.mode === "blend" ? "chat" : body.mode;

  const lastUserMessage = [...history]
    .reverse()
    .find((message) => message.role === "user");

  const lastUser = lastUserMessage?.content ?? "";
  const hasImages = history.some((message) => Boolean(message.images?.length));

  /*
   * There is exactly one model. What is decided per request is only the data
   * boundary: whether this message asked to be private and whether Nexus's
   * backend can honour that. Everything below checks this instead of
   * renegotiating it.
   */
  const model = nexusModel();
  const policy = privacyPolicy(lastUser, model);

  /*
   * A plainly worded image request is handed straight to Nexus's
   * generate_image tool, so drawing works even when the reasoning backend is
   * slow, rate-limited or weak at tool calling. It is still Nexus's tool and is
   * reported as such. Under a privacy request it stops being special:
   * generate_image is an external tool, so the turn is answered as text instead.
   */
  if (
    mode !== "agent" &&
    body.toolsEnabled !== false &&
    !policy.requested &&
    isDirectImageRequest(lastUser)
  ) {
    const imageTool = findTool("generate_image", policy);

    if (!imageTool) {
      return Response.json(
        {
          error:
            "Image generation is currently unavailable. The image provider is not configured.",
        },
        { status: 503 },
      );
    }

    const held = await holdChatRun(userId);

    if ("rejection" in held) return held.rejection;

    const { concurrency, plan } = held;

    let usableOutput = false;

    return createEventStream(async (emit) => {
      const safeEmit = (event: StreamEvent) => {
        if (
          event.type === "image" ||
          event.type === "delta" ||
          event.type === "file"
        ) {
          usableOutput = true;
        }

        emit(event);
      };

      try {
        safeEmit({
          type: "meta",
          model: "Nexus",
          execution: "cloud",
          mode,
        });

        safeEmit({
          type: "status",
          text: "Generating image...",
        });

        const prompt = extractImagePrompt(lastUser);

        if (!prompt) {
          safeEmit({
            type: "error",
            message: "Image prompt is empty.",
          });
          return;
        }

        const result = await runToolSafely(imageTool, prompt, request.signal);

        emitToolResult(
          safeEmit,
          imageTool.name,
          prompt,
          result.ok,
          result.content,
          result.data,
        );

        if (!result.ok) {
          safeEmit({
            type: "error",
            message: result.content,
          });
          return;
        }

        safeEmit({
          type: "status",
          text: "Image generated successfully.",
        });
      } finally {
        if (!usableOutput) {
          try {
            await refundQuota(userId, plan);
          } catch {
            // A quota refund must never hide the original request failure.
          }
        }
        await concurrency.release();
      }
    });
  }

  if (!model) {
    return Response.json(
      { error: NEXUS_NOT_CONFIGURED_MESSAGE },
      { status: 503 },
    );
  }

  /*
   * An attachment is only ever sent to Nexus. If this deployment's Nexus
   * backend cannot read images, the request says so; it is never quietly
   * handed to some other model.
   */
  if (hasImages && !model.vision) {
    return badRequest(
      "Nexus on this deployment cannot read images (the operator set NEXUS_VISION=false)",
    );
  }

  const held = await holdChatRun(userId);

  if ("rejection" in held) return held.rejection;

  const { concurrency, plan } = held;

  let streamOwnsConcurrency = false;

  try {
    const toolsEnabled = body.toolsEnabled !== false;
    const tools = toolsEnabled ? availableTools(policy) : [];

  /*
   * The tool protocol and the live-search decision want to know what the human
   * asked. Taken from the text in hand rather than re-read from the transcript,
   * which gains user-role turns as search results and tool output come back.
   */
  const requestedCapability = lastUser.trim()
    ? classify(lastUser)
    : undefined;

  const systemParts = [DEFAULT_SYSTEM_PROMPT];

  if (projectContext?.trim()) {
    systemParts.push(
      `Project context:\n${projectContext.trim()}`,
    );
  }

  /*
   * The switch means what it says. Turning memory off used to stop new facts
   * being written while every request still read the old ones out of storage and
   * pasted them into the prompt, so the only way to stop the injection was to
   * delete the memories by hand - and there was no way to see or delete them.
   * Off now means neither half happens, and a request that never says is
   * treated as off rather than as consent.
   */
  const useMemory = body.memoryEnabled === true;

  if (useMemory && savedMemory?.trim()) {
    systemParts.push(
      `Long-term memory the user saved:\n${savedMemory.trim()}`,
    );
  }

  if (useMemory) {
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

  let usableOutput = false;

  const response = createEventStream(async (emit) => {
    const safeEmit = (event: StreamEvent) => {
      if (
        event.type === "delta" ||
        event.type === "image" ||
        event.type === "file"
      ) {
        usableOutput = true;
      }
      emit(event);
    };

    try {
    safeEmit({
      type: "meta",
      model: "Nexus",
      execution: model.execution,
      mode,
    });

    const notice = privacyNotice(policy);

    if (notice) {
      safeEmit({ type: "status", text: notice });
    }

    const signal = request.signal;
    const conversation = [...baseMessages];

    /*
     * Research mode always searches first. A chat question that reads as
     * needing current information gets the same live-source treatment, so
     * users don't have to pick a mode to get an up-to-date answer. That
     * speculative search may fail without failing the reply: only an
     * explicit research request stops there.
     *
     * None of it happens inside the boundary: searching is the request sending
     * the question somewhere else. Nor does it happen with Tools switched off,
     * in whichever mode the picker is — the live web is reached by the
     * `web_search` tool, and a mode cannot switch back on what the message
     * switched off.
     */
    const searchFirst =
      !policy.requested &&
      toolsEnabled &&
      (mode === "research" ||
        (mode === "chat" && requestedCapability === "research"));

    if (mode === "research" && policy.requested) {
      safeEmit({
        type: "status",
        text: "Research mode needs the live web, which your privacy request rules out. Answering from the model itself.",
      });
    }

    if (mode === "research" && !toolsEnabled) {
      safeEmit({
        type: "status",
        text: "Research mode reaches the live web through Tools, and Tools are off for this message. Answering from the model itself.",
      });
    }

    if (searchFirst) {
      const researchReady = await runResearch(
        lastUser,
        conversation,
        safeEmit,
        signal,
        mode === "research",
      );

      if (!researchReady) return;
    }

    if (mode === "agent") {
      await runAgentPlan(
        lastUser,
        conversation,
        safeEmit,
        signal,
        tools,
      );
    }

    await streamWithTools(
      conversation,
      mode === "agent" ? false : tools.length > 0,
      systemWithoutTools,
      safeEmit,
      signal,
      tools,
      policy,
    );
    } finally {
      if (!usableOutput) {
        try {
          await refundQuota(userId, plan);
        } catch {
          // A quota refund must never hide the original request failure.
        }
      }
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
  hardFail: boolean,
): Promise<boolean> {
  emit({ type: "status", text: "Searching the web..." });

  try {
    const { sources, engine } = await searchWeb(query, signal);

    if (!sources.length) {
      if (!hardFail) {
        emit({
          type: "status",
          text: "No live results, so answering from what I know.",
        });
        return true;
      }

      emit({
        type: "error",
        message: `${engine} returned no research sources.`,
      });
      return false;
    }

    emit({ type: "sources", sources });

    emit({
      type: "tool",
      name: "web_search",
      argument: query,
      ok: true,
      summary: `${sources.length} results via ${engine}`,
    });

    attachEvidence(
      conversation,
      evidenceTurn(
        `the ${engine} search`,
        [
          "Search results for the question above. Use them and cite with [n] markers.",
          ...sources.map(
            (source, index) =>
              `[${index + 1}] ${source.title} - ${source.url}\n${source.snippet ?? ""}`,
          ),
        ].join("\n"),
      ),
    );
    return true;
  } catch (error) {
    if (!hardFail) {
      emit({
        type: "status",
        text: "Live search is unavailable, so answering from what I know.",
      });
      return true;
    }

    emit({
      type: "error",
      message: `Research search failed: ${(error as Error).message}`,
    });
    return false;
  }
}

function withoutToolInstructions(
  messages: ChatMessage[],
  systemWithoutTools: string,
): ChatMessage[] {
  return messages.map((message, index) =>
    index === 0 && message.role === "system"
      ? {
          role: "system",
          content: systemWithoutTools,
        }
      : message,
  );
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
  conversation: ChatMessage[],
  toolsEnabled: boolean,
  systemWithoutTools: string,
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
  toolDefinitions: Array<{ name: string; description: string }>,
  policy: PrivacyPolicy,
) {
  let toolsAllowed = toolsEnabled;

  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const isLastStep = step === MAX_TOOL_STEPS - 1;
    const allowTools = toolsAllowed && !isLastStep;

    // Tool instructions stay in the system prompt only while tools are
    // actually permitted; otherwise a final "TOOL: ..." line would be
    // streamed to the user verbatim.
    const messages = allowTools
      ? conversation
      : withoutToolInstructions(
          conversation,
          systemWithoutTools,
        );

    let held = allowTools;
    let buffer = "";
    let emitted = false;
    let call: { name: string; argument: string } | undefined;

    try {
      for await (
        const text of streamWithRetry(nexusProvider, {
          messages,
          signal,
          tools: allowTools ? toolDefinitions : undefined,
        })
      ) {
        if (!held) {
          emitted = true;
          emit({
            type: "delta",
            text,
          });
          continue;
        }

        buffer += text;

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

        if (allowTools) {
          const native = parseNativeToolCall(cleaned);
          if (native) {
            call = native;
            buffer = cleaned;
            break;
          }
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

      /*
       * With Tools off the streamed text is never held back, so a `TOOL: ...`
       * line goes out as plain text and nothing is parsed from it. A provider
       * that aborts mid-call is the exception: it leaves its partial native
       * tool payload here instead, and that used to be honoured whatever the
       * client asked for. Nothing runs on a turn that has no tools.
       */
      if (!native || emitted || !allowTools) {
        if (emitted) {
          emit({
            type: "error",
            message: (error as Error).message,
          });
        } else if (
          !worthRetryingWithoutTools(error, allowTools) ||
          !(await retryWithoutTools(conversation, systemWithoutTools, emit, signal))
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
      /*
       * An answer too short to have been released by the hold-back above (see
       * the length check in the loop) still has to go out, and it goes out with
       * its reasoning removed: the raw buffer is what the reader would otherwise
       * see, reasoning block and all.
       */
      const visible = stripThinking(buffer);

      if (visible) {
        emit({
          type: "delta",
          text: visible,
        });
      } else if (
        !emitted &&
        !(await retryWithoutTools(conversation, systemWithoutTools, emit, signal))
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
        // Held to the end without ever reaching the release length: flush what
        // the reader was meant to see, not the reasoning that was held with it.
        const visible = stripThinking(buffer);

        if (visible) {
          emit({
            type: "delta",
            text: visible,
          });
        } else if (
          !(await retryWithoutTools(conversation, systemWithoutTools, emit, signal))
        ) {
          emit({
            type: "status",
            text: "The model returned an empty response.",
          });
        }

        return;
      }
    }

    const tool = findTool(call.name, policy);

    if (!tool) {
      conversation.push({
        role: "assistant",
        // The same text the reader was sent, so the model never sees its own
        // reasoning handed back as an answer it gave.
        content: stripThinking(buffer).trim(),
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

    const result = await runToolSafely(tool, call.argument, signal);

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
      content: stripThinking(buffer).trim(),
    });

    conversation.push(
      evidenceTurn(
        `the ${tool.name} tool`,
        `Result of ${tool.name}(${call.argument}):\n${result.content}`,
      ),
    );

    conversation.push({
      role: "system",
      content: "Now answer the user with the result above. Do not call another tool unless it is essential.",
    });
  }

  if (
    !(await retryWithoutTools(conversation, systemWithoutTools, emit, signal))
  ) {
    emit({
      type: "status",
      text: "The model returned an empty response.",
    });
  }
}

/**
 * The tool-free second attempt exists for one situation: the failed request
 * carried the tool protocol and the backend choked on it. Repeating an
 * identical request (tools were never offered) or one the backend rejected for
 * its credentials or configuration only makes a failing turn take twice as
 * long, because retry already ran against the same single backend.
 */
function worthRetryingWithoutTools(error: unknown, toolsWereOffered: boolean): boolean {
  if (!toolsWereOffered) return false;

  return !(
    error instanceof UpstreamError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

async function retryWithoutTools(
  conversation: ChatMessage[],
  systemWithoutTools: string,
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return true;

  const messages = withoutToolInstructions(
    conversation,
    systemWithoutTools,
  );

  emit({
    type: "status",
    text: "Answering without tools...",
  });

  let emitted = false;

  try {
    for await (
      const text of streamWithRetry(nexusProvider, {
        messages,
        signal,
      })
    ) {
      emitted = true;

      emit({
        type: "delta",
        text,
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
