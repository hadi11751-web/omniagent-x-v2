import { beforeEach, describe, expect, it, vi } from "vitest";

const { collectTextMock, calculatorRunMock } = vi.hoisted(() => ({
  collectTextMock: vi.fn(),
  calculatorRunMock: vi.fn(),
}));

vi.mock("@/lib/stream", () => ({
  collectText: collectTextMock,
}));

import { runAgentPlan } from "@/lib/agent";

function makeEmit() {
  const events: unknown[] = [];

  return {
    emit: (event: unknown) => events.push(event),
    events,
  };
}

/**
 * The caller hands the planner its tool list, so these tests control what the
 * agent may reach by changing this rather than by mocking the registry.
 */
const calculator = {
  name: "calculator",
  description: "Calculates mathematical expressions.",
  argument: "expression",
  run: calculatorRunMock,
} as never;

const tools = [calculator];

describe("Agent execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    calculatorRunMock.mockResolvedValue({
      ok: true,
      content: "4",
      data: undefined,
    });
  });

  it("plans, executes, verifies, and stops when complete", async () => {
    collectTextMock
      .mockResolvedValueOnce(
        '[{"tool":"calculator","argument":"2 + 2"}]',
      )
      .mockResolvedValueOnce("VERIFIED");

    const conversation = [
      { role: "system", content: "system" },
      { role: "user", content: "Calculate 2 + 2" },
    ] as never;

    const { emit, events } = makeEmit();

    const signal = new AbortController().signal;

    await runAgentPlan(
      "Calculate 2 + 2",
      conversation,
      emit,
      signal,
      tools,
    );

    // The turn's abort reaches the tools, not only the model.
    expect(calculatorRunMock).toHaveBeenCalledWith("2 + 2", signal);

    const statuses = events
      .filter((event) => (event as { type?: string }).type === "status")
      .map((event) => (event as { text?: string }).text);

    expect(statuses).toContain("Planning with Nexus...");
    expect(statuses).toContain(
      "Verifying agent work with Nexus...",
    );
    expect(statuses).toContain(
      "Agent verified its work after 1 step(s).",
    );
  });

  it("retries a failed tool and recovers", async () => {
    calculatorRunMock
      .mockResolvedValueOnce({
        ok: false,
        content: "temporary failure",
        data: undefined,
      })
      .mockResolvedValueOnce({
        ok: false,
        content: "temporary failure",
        data: undefined,
      })
      .mockResolvedValueOnce({
        ok: false,
        content: "temporary failure",
        data: undefined,
      })
      .mockResolvedValueOnce({
        ok: true,
        content: "4",
        data: undefined,
      });

    collectTextMock
      .mockResolvedValueOnce(
        '[{"tool":"calculator","argument":"2 + 2"}]',
      )
      .mockResolvedValueOnce(
        '{"action":"retry","tool":"calculator","argument":"2 + 2"}',
      )
      .mockResolvedValueOnce("VERIFIED");

    const conversation = [
      { role: "system", content: "system" },
      { role: "user", content: "Calculate 2 + 2" },
    ] as never;

    const { emit, events } = makeEmit();

    await runAgentPlan(
      "Calculate 2 + 2",
      conversation,
      emit,
      new AbortController().signal,
      tools,
    );

    expect(calculatorRunMock).toHaveBeenCalledTimes(4);

    const text = events
      .filter((event) => (event as { type?: string }).type === "status")
      .map((event) => (event as { text?: string }).text)
      .join("\n");

    expect(text).toContain("retrying...");
    expect(text).toContain(
      "Recovering from failed calculator step...",
    );
    expect(text).toContain(
      "Agent verified its work after 2 step(s).",
    );
  });

  it("does more work when verification says NEEDS_MORE", async () => {
    collectTextMock
      .mockResolvedValueOnce(
        '[{"tool":"calculator","argument":"10 + 5"}]',
      )
      .mockResolvedValueOnce("NEEDS_MORE")
      .mockResolvedValueOnce(
        '[{"tool":"calculator","argument":"20 + 5"}]',
      )
      .mockResolvedValueOnce("VERIFIED");

    const conversation = [
      { role: "system", content: "system" },
      { role: "user", content: "Do the required calculations" },
    ] as never;

    const { emit, events } = makeEmit();

    await runAgentPlan(
      "Do the required calculations",
      conversation,
      emit,
      new AbortController().signal,
      tools,
    );

    expect(calculatorRunMock).toHaveBeenCalledTimes(2);

    const text = events
      .filter((event) => (event as { type?: string }).type === "status")
      .map((event) => (event as { text?: string }).text)
      .join("\n");

    expect(text).toContain(
      "Verification requested more work",
    );
    expect(text).toContain(
      "Agent verified its work after 2 step(s).",
    );
  });

  it("never exceeds the eight-step safety limit", async () => {
    collectTextMock.mockImplementation(
      async (
        _provider: unknown,
        _model: string,
        prompt: Array<{ content?: unknown }>,
      ) => {
        const system = String(prompt?.[0]?.content ?? "");

        if (system.includes("verification stage")) {
          return "NEEDS_MORE";
        }

        return '[{"tool":"calculator","argument":"1 + 1"}]';
      },
    );

    const conversation = [
      { role: "system", content: "system" },
      { role: "user", content: "Keep working" },
    ] as never;

    const { emit, events } = makeEmit();

    await runAgentPlan(
      "Keep working",
      conversation,
      emit,
      new AbortController().signal,
      tools,
    );

    expect(calculatorRunMock).toHaveBeenCalledTimes(8);

    const text = events
      .filter((event) => (event as { type?: string }).type === "status")
      .map((event) => (event as { text?: string }).text)
      .join("\n");

    expect(text).toContain(
      "Agent reached its 8-step safety limit.",
    );
  });

  /*
   * The Tools switch and the privacy boundary are both expressed by handing the
   * planner a smaller list. It used to build its own from the registry, so
   * turning tools off in the UI still let an agent turn call out.
   */
  it("answers directly when the turn was given no tools", async () => {
    const { emit, events } = makeEmit();

    await runAgentPlan(
      "Calculate 2 + 2",
      [
        { role: "system", content: "system" },
        { role: "user", content: "Calculate 2 + 2" },
      ] as never,
      emit,
      new AbortController().signal,
      [],
    );

    expect(calculatorRunMock).not.toHaveBeenCalled();
    expect(collectTextMock).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "status",
      text: "No tools are available; answering directly.",
    });
  });

  it("will not run a tool the caller did not offer", async () => {
    collectTextMock
      .mockResolvedValueOnce(
        '[{"tool":"web_search","argument":"my private notes"}]',
      )
      .mockResolvedValueOnce("VERIFIED");

    const { emit, events } = makeEmit();

    await runAgentPlan(
      "Look something up",
      [
        { role: "system", content: "system" },
        { role: "user", content: "Look something up" },
      ] as never,
      emit,
      new AbortController().signal,
      tools,
    );

    expect(calculatorRunMock).not.toHaveBeenCalled();

    const text = events
      .filter((event) => (event as { type?: string }).type === "status")
      .map((event) => (event as { text?: string }).text)
      .join("\n");

    expect(text).toContain(
      "Planner produced no executable steps; answering directly.",
    );
  });
});
