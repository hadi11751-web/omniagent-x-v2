import { collectText, type StreamEvent } from "@/lib/stream";
import {
  availableTools,
  findTool,
} from "@/lib/tools";
import type {
  ChatMessage,
  ChatProvider,
  ModelInfo,
} from "@/lib/types";

const MAX_AGENT_STEPS = 8;
const MAX_AGENT_RETRIES = 2;
function toolData(data: unknown) {
  const payload = (data ?? {}) as {
    sources?: Array<{
      title: string;
      url: string;
      snippet?: string;
    }>;
    image?: string;
    file?: {
      dataUrl: string;
      filename: string;
    };
  };

  return payload;
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
export async function runAgentPlan(
  provider: ChatProvider,
  model: ModelInfo,
  goal: string,
  conversation: ChatMessage[],
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
) {
  const tools = availableTools();
  if (!tools.length) {
    emit({ type: "status", text: "No tools are available; answering directly." });
    return;
  }

  type AgentState = {
    step: number;
    tool: string;
    argument: string;
    status: "pending" | "running" | "succeeded" | "failed" | "recovered" | "skipped";
    attempts: number;
    result?: string;
  };

  const toolNames = tools.map((tool) => tool.name);
  const state: AgentState[] = [];

  const parseJsonArray = (text: string): unknown[] => {
    const cleaned = text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");

    if (start < 0 || end <= start) {
      throw new Error("planner did not return a JSON array");
    }

    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) {
      throw new Error("planner response was not an array");
    }

    return parsed;
  };

  const normalizePlan = (raw: unknown[]): AgentState[] => {
    const normalized: AgentState[] = [];

    for (const item of raw) {
      const value = item as {
        tool?: unknown;
        argument?: unknown;
      };

      if (
        typeof value?.tool !== "string" ||
        typeof value?.argument !== "string"
      ) {
        continue;
      }

      const toolName = value.tool.trim().toLowerCase();
      const tool = findTool(toolName);

      if (!tool) continue;

      normalized.push({
        step: normalized.length + 1,
        tool: tool.name,
        argument: value.argument.trim(),
        status: "pending",
        attempts: 0,
      });

      if (normalized.length >= MAX_AGENT_STEPS) break;
    }

    return normalized;
  };
  const createPlan = async (
    task: string,
    previousState: AgentState[],
  ): Promise<AgentState[]> => {
    emit({
      type: "status",
      text: previousState.length ? "Re-planning..." : "Planning with Claude Opus...",
    });

    const plannerContext = previousState.length
      ? [
          "Previous execution state:",
          JSON.stringify(previousState),
          "",
          "Create only the additional steps needed to finish the user's goal.",
        ].join("\n")
      : "Create the initial execution plan.";

    const planPrompt: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You are OmniAgent's execution planner.",
          "Plan real, necessary tool work for the user's goal.",
          `Available tools: ${toolNames.join(", ")}.`,
          `Return JSON only: [{"tool":"tool_name","argument":"exact argument"}]`,
          `Use no more than ${MAX_AGENT_STEPS} total steps in a planning round.`,
          "Never invent a tool.",
          "Never plan destructive or irreversible actions.",
          "Do not include explanations outside the JSON array.",
          plannerContext,
        ].join("\n"),
      },
      { role: "user", content: task },
    ];

    const planText = await collectText(provider, model.id, planPrompt, signal);
    return normalizePlan(parseJsonArray(planText));
  };

  const executeStep = async (item: AgentState): Promise<boolean> => {
    const tool = findTool(item.tool);

    if (!tool) {
      item.status = "failed";
      item.result = `Tool "${item.tool}" does not exist.`;
      return false;
    }

    for (let attempt = 1; attempt <= MAX_AGENT_RETRIES + 1; attempt += 1) {
      if (signal.aborted) return false;

      item.attempts = attempt;
      item.status = "running";

      emit({
        type: "status",
        text: `Agent step ${item.step}: ${tool.name} (attempt ${attempt})...`,
      });

      try {
        const result = await tool.run(item.argument);

        emitToolResult(
          emit,
          tool.name,
          item.argument,
          result.ok,
          result.content,
          result.data,
        );

        conversation.push({
          role: "assistant",
          content: `Agent executed ${tool.name}(${item.argument}).`,
        });

        conversation.push({
          role: "system",
          content: [
            `Agent result for ${tool.name}(${item.argument}):`,
            result.content,
          ].join("\n"),
        });

        item.result = result.content;

        if (result.ok) {
          item.status = attempt === 1 ? "succeeded" : "recovered";
          return true;
        }

        item.status = "failed";

        if (attempt <= MAX_AGENT_RETRIES) {
          emit({
            type: "status",
            text: `${tool.name} failed; retrying...`,
          });
        }
      } catch (error) {
        item.status = "failed";
        item.result = (error as Error).message;

        conversation.push({
          role: "system",
          content: `Agent tool error from ${tool.name}(${item.argument}): ${(error as Error).message}`,
        });

        if (attempt <= MAX_AGENT_RETRIES) {
          emit({
            type: "status",
            text: `${tool.name} threw an error; retrying...`,
          });
        }
      }
    }

    return false;
  };

  const recoverStep = async (failed: AgentState): Promise<AgentState | undefined> => {
    emit({
      type: "status",
      text: `Recovering from failed ${failed.tool} step...`,
    });

    try {
      const recoveryPrompt: ChatMessage[] = [
        {
          role: "system",
          content: [
            "You are OmniAgent's recovery planner.",
            "A tool execution failed after retries.",
            `Available tools: ${toolNames.join(", ")}.`,
            'Return JSON only: {"action":"retry"|"replace"|"skip","tool":"tool_name","argument":"exact argument"}',
            "Choose retry only when the same tool has a realistic chance to work.",
            "Choose replace when another available tool can accomplish the same subtask.",
            "Choose skip only when the failed step is unnecessary.",
            "Never invent a tool.",
            "Never plan destructive or irreversible actions.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Original goal: ${goal}`,
            `Failed tool: ${failed.tool}`,
            `Argument: ${failed.argument}`,
            `Attempts: ${failed.attempts}`,
            `Failure: ${failed.result ?? "unknown failure"}`,
            `Execution state: ${JSON.stringify(state)}`,
          ].join("\n"),
        },
      ];

      const raw = await collectText(provider, model.id, recoveryPrompt, signal);
      const cleaned = raw
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      const parsed = JSON.parse(cleaned) as {
        action?: string;
        tool?: string;
        argument?: string;
      };

      if (parsed.action === "skip") {
        failed.status = "skipped";
        return undefined;
      }

      if (
        (parsed.action === "retry" || parsed.action === "replace") &&
        typeof parsed.tool === "string" &&
        typeof parsed.argument === "string" &&
        findTool(parsed.tool)
      ) {
        return {
          step: state.length + 1,
          tool: parsed.tool,
          argument: parsed.argument.trim(),
          status: "pending",
          attempts: 0,
        };
      }
    } catch {
      /* recovery failure is handled by the bounded stop condition */
    }

    return undefined;
  };

  const verify = async (): Promise<"verified" | "needs_more"> => {
    emit({ type: "status", text: "Verifying agent work with Claude Opus..." });

    const verificationPrompt: ChatMessage[] = [
      {
        role: "system",
        content: [
          "You are OmniAgent's verification stage.",
          "Check whether the user's goal has actually been satisfied by the execution evidence.",
          'Return exactly one word: VERIFIED or NEEDS_MORE.',
          "Use NEEDS_MORE only when additional work is genuinely required.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Goal: ${goal}`,
          `Execution state: ${JSON.stringify(state)}`,
          "Collected tool evidence:",
          conversation
            .filter((message) => message.role === "system")
            .slice(-MAX_AGENT_STEPS * 2)
            .map((message) => message.content)
            .join("\n\n"),
        ].join("\n"),
      },
    ];

    const result = (await collectText(
      provider,
      model.id,
      verificationPrompt,
      signal,
    )).trim().toUpperCase();

    return result.includes("NEEDS_MORE") ? "needs_more" : "verified";
  };

  try {
    let plan = await createPlan(goal, state);

    if (!plan.length) {
      emit({
        type: "status",
        text: "Planner produced no executable steps; answering directly.",
      });
      return;
    }

    while (state.length < MAX_AGENT_STEPS && plan.length) {
      for (const step of plan) {
        if (state.length >= MAX_AGENT_STEPS) break;

        step.step = state.length + 1;
        state.push(step);

        const ok = await executeStep(step);

        if (!ok) {
          const recovery = await recoverStep(step);

          if (recovery && state.length < MAX_AGENT_STEPS) {
            recovery.step = state.length + 1;
            state.push(recovery);
            await executeStep(recovery);
          }
        }
      }

      const verification = await verify();

      if (verification === "verified") {
        emit({
          type: "status",
          text: `Agent verified its work after ${state.length} step(s).`,
        });
        return;
      }

      if (state.length >= MAX_AGENT_STEPS) {
        emit({
          type: "status",
          text: `Agent reached its ${MAX_AGENT_STEPS}-step safety limit.`,
        });
        return;
      }

      const remaining = MAX_AGENT_STEPS - state.length;

      emit({
        type: "status",
        text: `Verification requested more work; ${remaining} step(s) remain.`,
      });

      const recoveryPlan = await createPlan(
        [
          goal,
          "",
          "The first execution round was not sufficient.",
          `Remaining step budget: ${remaining}.`,
          `Execution state: ${JSON.stringify(state)}`,
        ].join("\n"),
        state,
      );

      if (!recoveryPlan.length) {
        emit({
          type: "status",
          text: "No safe recovery steps were available.",
        });
        return;
      }

      plan = recoveryPlan;
    }
  } catch (error) {
    if (signal.aborted) return;

    emit({
      type: "status",
      text: `Agent execution stopped safely: ${(error as Error).message}`,
    });
  }
}
