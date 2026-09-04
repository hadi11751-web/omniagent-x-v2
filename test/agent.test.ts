import { beforeEach, describe, expect, it, vi } from "vitest";

const { collectTextMock, calculatorRunMock } = vi.hoisted(() => ({
  collectTextMock: vi.fn(),
  calculatorRunMock: vi.fn(),
}));

vi.mock("@/lib/stream", () => ({
  collectText: collectTextMock,
}));

vi.mock("@/lib/tools", () => {
  const calculator = {
    name: "calculator",
    description: "Calculates mathematical expressions.",
    argument: "expression",
    run: calculatorRunMock,
  };

  return {
    availableTools: () => [calculator],
    findTool: (name: string) =>
      name === "calculator" ? calculator : undefined,
  };
});

import { runAgentPlan } from "@/lib/agent";

function makeEmit() {
  const events: unknown[] = [];

  return {
    emit: (event: unknown) => events.push(event),
    events,
  };
}

function provider() {
  return {
    id: "anthropic",
    label: "Anthropic",
    execution: "cloud",
    isConfigured: () => true,
    stream: async function* () {},
  } as never;
}

const model = {
  id: "claude-opus-5",
  label: "Claude Opus 5",
  provider: "anthropic",
  execution: "cloud",
  capabilities: ["reasoning", "coding", "research"],
} as never;

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

    await runAgentPlan(
      provider(),
      model,
      "Calculate 2 + 2",
      conversation,
      emit,
      new AbortController().signal,
    );

    expect(calculatorRunMock).toHaveBeenCalledWith("2 + 2");

    const statuses = events
      .filter((event) => (event as { type?: string }).type === "status")
      .map((event) => (event as { text?: string }).text);

    expect(statuses).toContain("Planning with Claude Opus...");
    expect(statuses).toContain("Verifying agent work with Claude Opus...");
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
      provider(),
      model,
      "Calculate 2 + 2",
      conversation,
      emit,
      new AbortController().signal,
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
      provider(),
      model,
      "Do the required calculations",
      conversation,
      emit,
      new AbortController().signal,
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
      provider(),
      model,
      "Keep working",
      conversation,
      emit,
      new AbortController().signal,
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
});
