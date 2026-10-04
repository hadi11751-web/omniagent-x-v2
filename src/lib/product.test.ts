import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  FAQ,
  INCLUDED_ON_BOTH,
  MODE_DETAILS,
  DECISION_PIPELINE,
  MODEL_SUMMARY,
  OMNI_CAPABILITIES,
  PLAN_ROWS,
  REALTIME_SEARCH,
} from "@/lib/product";
import {
  FREE_DAILY_LIMIT,
  FREE_DAILY_MEMORY_RUNS,
  FREE_DAILY_TRANSCRIPTIONS,
  MAX_AGENT_STEPS,
  MAX_CONCURRENT_PER_USER,
  MAX_CONVERSATIONS,
  MAX_HISTORY_MESSAGES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MEMORIES,
  MAX_REQUEST_SECONDS,
  MAX_TOOL_CALLS_PER_ANSWER,
} from "@/lib/limits";
import { ALL_TOOLS } from "@/lib/tools";

function row(label: string) {
  const found = PLAN_ROWS.find((entry) => entry.label === label);

  if (!found) {
    throw new Error(`no plan row labelled ${label}`);
  }

  return found;
}

describe("PLAN_ROWS", () => {
  it("quotes the same numbers the server enforces", () => {
    expect(row("Messages per day").free).toBe(String(FREE_DAILY_LIMIT));
    expect(row("Messages per day").paid).toBe("Unlimited");
    expect(row("Simultaneous requests").free).toBe(String(MAX_CONCURRENT_PER_USER));
    expect(row("Tool calls per chat answer").free).toBe(String(MAX_TOOL_CALLS_PER_ANSWER));
    expect(row("Agent tool steps per run").free).toBe(String(MAX_AGENT_STEPS));
    expect(row("Conversation window sent to the model").free).toBe(
      `${MAX_HISTORY_MESSAGES} messages`,
    );
    expect(row("Saved conversations").free).toBe(String(MAX_CONVERSATIONS));
    expect(row("Memories").free).toBe(String(MAX_MEMORIES));
    expect(row("Images per message").free).toBe(String(MAX_IMAGES_PER_MESSAGE));
    expect(row("Memory saves per day").free).toBe(String(FREE_DAILY_MEMORY_RUNS));
    expect(row("Voice transcriptions per day").free).toBe(
      String(FREE_DAILY_TRANSCRIPTIONS),
    );
  });

  /*
   * checkDailyCap returns "allowed" for a paid account before it counts
   * anything, so the two backstop ceilings are paid-side "Unlimited" too. A
   * row that claimed the free number for both plans advertised a limit no code
   * enforces.
   */
  it("marks the daily ceilings as the only thing the plans differ on", () => {
    expect(PLAN_ROWS.filter((entry) => entry.differs).map((entry) => entry.label)).toEqual([
      "Messages per day",
      "Memory saves per day",
      "Voice transcriptions per day",
    ]);
  });

  it("says unlimited anywhere the server lifts a ceiling for a paid account", () => {
    for (const label of [
      "Messages per day",
      "Memory saves per day",
      "Voice transcriptions per day",
    ]) {
      expect(row(label).paid).toBe("Unlimited");
    }
  });

  it("keeps identical limits identical on both sides of the row", () => {
    for (const entry of PLAN_ROWS.filter((candidate) => !candidate.differs)) {
      expect(entry.paid).toBe(entry.free);
    }
  });
});

describe("OMNI_CAPABILITIES", () => {
  it("has unique keys and something real to say", () => {
    const keys = OMNI_CAPABILITIES.map((capability) => capability.key);

    expect(new Set(keys).size).toBe(keys.length);
    expect(OMNI_CAPABILITIES.length).toBe(10);

    for (const capability of OMNI_CAPABILITIES) {
      expect(capability.title.length).toBeGreaterThan(0);
      expect(capability.tagline.length).toBeGreaterThan(0);
      expect(capability.bullets.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("describes shipped behaviour instead of promising future work", () => {
    const copy = [
      ...OMNI_CAPABILITIES.flatMap((capability) => [
        capability.title,
        capability.tagline,
        ...capability.bullets,
      ]),
      ...INCLUDED_ON_BOTH,
      ...MODE_DETAILS.flatMap((mode) => [mode.label, mode.hint]),
      ...FAQ.flatMap((item) => [item.question, item.answer]),
      ...REALTIME_SEARCH.steps,
    ].join(" ");

    expect(copy).not.toMatch(/coming soon|roadmap|on our roadmap|will be added|planned/i);
  });

  /*
   * The private bullets must not promise more than the code does: a private
   * turn drops the external tools either way, but whether the reply itself
   * stays on the deployment depends on where Nexus runs, and the copy has to
   * admit a cloud backend cannot keep it.
   */
  it("states the boundary the code enforces for a private turn", () => {
    const privacy = OMNI_CAPABILITIES.find(
      (capability) => capability.key === "private",
    );

    if (!privacy) {
      throw new Error("the private capability is missing");
    }

    const copy = privacy.bullets.join(" ");

    expect(copy).not.toMatch(/instead of sending your text to a cloud model/i);
    expect(copy).toMatch(/cloud backend/i);
    expect(copy).toMatch(/web_search, fetch_url and generate_image/i);

    // Chat history is stored by this deployment, and a private turn is saved
    // there like any other.
    expect(copy).toMatch(/saving chat history is a separate choice/i);
  });

  it("never advertises more than one model, a picker, routing or Blend", () => {
    const everything = [
      ...OMNI_CAPABILITIES.flatMap((capability) => [
        capability.title,
        capability.tagline,
        ...capability.bullets,
      ]),
      ...INCLUDED_ON_BOTH,
      ...DECISION_PIPELINE,
      ...FAQ.flatMap((item) => [item.question, item.answer]),
    ].join(" ");

    expect(everything).not.toMatch(/\bblend\b/i);
    expect(everything).not.toMatch(/model routing|auto-?rout|pinned local|routed to a/i);
    expect(everything).not.toMatch(
      /OpenAI|Anthropic|Claude|GPT|Grok|DeepSeek|Perplexity|Ollama|Llama|Qwen|Gemini/,
    );
  });

  it("lists every tool the server actually registers", () => {
    const tools = OMNI_CAPABILITIES.find(
      (capability) => capability.key === "tools",
    );

    if (!tools) {
      throw new Error("the tools capability is missing");
    }

    // Read from the registry, so a tool added there cannot go unadvertised.
    expect(ALL_TOOLS.length).toBeGreaterThan(0);

    for (const tool of ALL_TOOLS) {
      expect(tools.bullets.join(" ")).toContain(tool.name);
    }
  });
});

describe("MODEL_SUMMARY", () => {
  it("says there is exactly one model and that it is Nexus", () => {
    expect(MODEL_SUMMARY.models).toBe(1);
    expect(MODEL_SUMMARY.name).toBe("Nexus");
  });
});

describe("MODE_DETAILS", () => {
  it("covers the three user-facing modes", () => {
    expect(MODE_DETAILS.map((mode) => mode.id).sort()).toEqual([
      "agent",
      "chat",
      "research",
    ]);
  });
});

/*
 * `maxDuration` is only read by Next when it is a literal, so the seconds the
 * page quotes live in `limits.ts` and the enforced one is written in the route.
 * This is the check that keeps the two in step.
 */
describe("the per-request duration the page quotes", () => {
  it("is the number the chat route exports as maxDuration", () => {
    const route = fileURLToPath(
      new URL("../app/api/chat/route.ts", import.meta.url),
    );

    expect(readFileSync(route, "utf8")).toContain(
      `export const maxDuration = ${MAX_REQUEST_SECONDS};`,
    );
  });

  it("is stated as a bound on both plans rather than as unlimited work", () => {
    const paidCard = fileURLToPath(
      new URL("../app/pricing/page.tsx", import.meta.url),
    );

    const copy = readFileSync(paidCard, "utf8");

    expect(copy).not.toMatch(/never stop|no matter how long|runs without limit/i);
    expect(
      FAQ.some((item) => item.answer.includes(String(MAX_REQUEST_SECONDS))),
    ).toBe(true);
  });
});

/*
 * The settings panel states where history goes in prose inside JSX, so nothing
 * but reading the file can notice it claiming the opposite of the code. It used
 * to say localStorage only on a deployment that uploads conversations.
 */
describe("the history claim in the settings panel", () => {
  it("says the server keeps a copy when persistence is on", () => {
    const panel = fileURLToPath(
      new URL("../components/SettingsPanel.tsx", import.meta.url),
    );

    const copy = readFileSync(panel, "utf8");

    expect(copy).not.toMatch(/stored in localStorage only/i);
    expect(copy).toMatch(/also saved on that server/i);
    expect(copy).toMatch(/Delete all/i);
  });
});
