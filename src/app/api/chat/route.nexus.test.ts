import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * End to end through the real route: real Nexus adapter, real HTTP to a mock
 * upstream, real tool loop and the real calculator. Only auth, quota, storage
 * and the live-web call are stubbed. The language model's replies are scripted;
 * everything about how Nexus is called, how its output is read and what the
 * user sees is the application's own code.
 */
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  searchWeb: vi.fn(),
  getRelevantMemories: vi.fn(async () => [] as unknown[]),
  checkAndConsumeQuota: vi.fn(async () => ({ allowed: true, remaining: 9, limit: 10 })),
  refundQuota: vi.fn(async () => {}),
  release: vi.fn(async () => {}),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: h.auth }));
vi.mock("@/lib/server/memory", () => ({
  getRelevantMemories: h.getRelevantMemories,
  listMemories: vi.fn(async () => []),
  saveMemories: vi.fn(async () => []),
}));
vi.mock("@/lib/quota", () => ({
  getPlan: vi.fn(async () => "free" as const),
  checkAndConsumeQuota: h.checkAndConsumeQuota,
  refundQuota: h.refundQuota,
  checkDailyCap: vi.fn(async () => ({ allowed: true })),
  refundDailyCap: vi.fn(async () => {}),
}));
vi.mock("@/lib/concurrency", () => ({
  acquireConcurrency: vi.fn(async () => ({ acquired: true, limit: 3, release: h.release })),
}));
vi.mock("@/lib/tools/webSearch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tools/webSearch")>();
  return { ...actual, searchWeb: h.searchWeb };
});

import { POST } from "@/app/api/chat/route";
import { startMockNexusUpstream, type MockNexusUpstream } from "../../../../test/helpers/mockNexusUpstream";

type Event = Record<string, unknown> & { type: string };

async function chat(body: Record<string, unknown>): Promise<{ status: number; events: Event[]; text: string; json?: unknown }> {
  const response = await POST(
    new Request("https://app.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  if (!(response.headers.get("content-type") ?? "").includes("json") || response.status !== 200) {
    return { status: response.status, events: [], text: "", json: await response.json().catch(() => undefined) };
  }

  const raw = await response.text();
  const events = raw.trim().split("\n").map((line) => JSON.parse(line) as Event);
  const text = events.filter((e) => e.type === "delta").map((e) => e.text as string).join("");

  return { status: 200, events, text };
}

const ask = (content: string, extra: Record<string, unknown> = {}) =>
  chat({ messages: [{ role: "user", content }], ...extra });

describe("POST /api/chat with Nexus as the only model", () => {
  let up: MockNexusUpstream;

  beforeAll(async () => {
    up = await startMockNexusUpstream();
  });
  afterAll(() => up.close());

  beforeEach(() => {
    up.reset();
    h.auth.mockReset().mockResolvedValue({ userId: "user-1" });
    h.searchWeb.mockReset();
    h.release.mockClear();
    h.refundQuota.mockClear();
    vi.stubEnv("NEXUS_BASE_URL", up.url);
    vi.stubEnv("NEXUS_MODEL", "engine-under-test");
    vi.stubEnv("NEXUS_API_KEY", "k");
    vi.stubEnv("NEXUS_EXECUTION", "cloud");
    vi.stubEnv("NEXUS_VISION", "true");
    vi.stubEnv("NEXUS_NATIVE_TOOLS", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const system = () => {
    const first = up.calls[0].body.messages[0];
    return typeof first.content === "string" ? first.content : "";
  };

  it("answers as Nexus, announces only Nexus, and makes exactly one backend call", async () => {
    up.enqueue({ kind: "text", chunks: ["Paris ", "is the capital."] });

    const { status, events, text } = await ask("capital of France?", { toolsEnabled: false });

    expect(status).toBe(200);
    expect(text).toBe("Paris is the capital.");
    expect(events[0]).toEqual({ type: "meta", model: "Nexus", execution: "cloud", mode: "chat" });
    expect(JSON.stringify(events)).not.toMatch(/engine-under-test|provider/i);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(up.calls).toHaveLength(1);
    expect(system()).toMatch(/You are Nexus/);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("ignores a client-supplied model, autoRoute, or the retired blend mode", async () => {
    up.enqueue({ kind: "text", chunks: ["a"] }, { kind: "text", chunks: ["b"] });

    const named = await ask("hi", { model: "gpt-5", autoRoute: true, toolsEnabled: false });
    const blend = await ask("hi", { mode: "blend", toolsEnabled: false });

    expect(named.text).toBe("a");
    expect(blend.text).toBe("b");
    expect(blend.events[0]).toMatchObject({ mode: "chat" });
    expect(up.calls.map((c) => c.body.model)).toEqual(["engine-under-test", "engine-under-test"]);
  });

  it("rejects a mode that does not exist", async () => {
    const { status } = await ask("hi", { mode: "council" });
    expect(status).toBe(400);
    expect(up.calls).toHaveLength(0);
  });

  describe("tools are Nexus's capabilities", () => {
    it("runs a tool Nexus asks for, feeds the result back, and returns the final answer", async () => {
      up.enqueue(
        { kind: "text", chunks: ["TOOL: calculator | 17 * 23"] },
        { kind: "text", chunks: ["17 × 23 = 391."] },
      );

      const { events, text } = await ask("what is 17 * 23?");

      expect(events.find((e) => e.type === "tool")).toMatchObject({ name: "calculator", ok: true });
      expect(text).toBe("17 × 23 = 391.");
      expect(text).not.toMatch(/TOOL:/);
      expect(up.calls).toHaveLength(2);
      expect(JSON.stringify(up.calls[1].body.messages)).toContain("391");
    });

    it("lists the real tools in the prompt Nexus sees, so it cannot promise ones that do not exist", async () => {
      await ask("hello");
      for (const tool of ["web_search", "fetch_url", "calculator", "analyze_text", "generate_pdf", "inspect_pdf"]) {
        expect(system()).toContain(tool);
      }
      // No image key configured in this test, so the prompt must not offer it.
      expect(system()).not.toContain("generate_image |");
    });

    it("sends no tool protocol and runs nothing when Tools is off, even if Nexus writes a TOOL line", async () => {
      up.enqueue({ kind: "text", chunks: ["TOOL: calculator | 1+1"] });

      const { events, text } = await ask("hello", { toolsEnabled: false });

      expect(system()).not.toMatch(/TOOL: <name>/);
      expect(events.some((e) => e.type === "tool")).toBe(false);
      expect(text).toBe("TOOL: calculator | 1+1");
      expect(up.calls[0].body.tools).toBeUndefined();
    });

    it("searches the live web first in research mode and gives Nexus the sources", async () => {
      h.searchWeb.mockResolvedValue({
        provider: "test",
        sources: [{ title: "Report", url: "https://example.org/r", snippet: "Fact about the topic." }],
      });
      up.enqueue({ kind: "text", chunks: ["Per the report [1], yes."] });

      const { events, text } = await ask("latest news on topic X", { mode: "research" });

      expect(h.searchWeb).toHaveBeenCalled();
      expect(events.find((e) => e.type === "sources")).toBeDefined();
      expect(text).toContain("[1]");
      expect(JSON.stringify(up.calls[0].body.messages)).toContain("Fact about the topic.");
    });

    it("will not search the web in research mode when Tools is off", async () => {
      up.enqueue({ kind: "text", chunks: ["From memory only."] });
      await ask("latest news on topic X", { mode: "research", toolsEnabled: false });
      expect(h.searchWeb).not.toHaveBeenCalled();
    });

    it("withholds a reasoning block instead of showing it to the user", async () => {
      up.enqueue({ kind: "text", chunks: ["<think>secret chain of thought</think>", "The answer is 4."] });
      const { text } = await ask("2+2?");
      expect(text).toContain("The answer is 4.");
      expect(text).not.toMatch(/secret chain of thought|<think>/);
    });
  });

  describe("image understanding", () => {
    const img = "data:image/png;base64,iVBORw0KGgo=";
    const withImage = { messages: [{ role: "user", content: "what is in this?", images: [img] }], toolsEnabled: false };

    it("hands the attachment to Nexus itself", async () => {
      up.enqueue({ kind: "text", chunks: ["A tiny image."] });
      const { text } = await chat(withImage);

      expect(text).toBe("A tiny image.");
      const user = up.calls[0].body.messages.at(-1)!;
      expect(JSON.stringify(user.content)).toContain(img);
      expect(up.calls).toHaveLength(1);
    });

    it("says so, and sends nothing anywhere, when this deployment's Nexus cannot see images", async () => {
      vi.stubEnv("NEXUS_VISION", "false");
      const { status, json } = await chat(withImage);

      expect(status).toBe(400);
      expect(JSON.stringify(json)).toMatch(/Nexus .*cannot read images/);
      expect(up.calls).toHaveLength(0);
    });
  });

  describe("the privacy boundary", () => {
    it("turns external tools off for a private request and says the backend is cloud", async () => {
      const { events } = await ask("keep this private: summarise my diary entry");

      for (const tool of ["web_search", "fetch_url", "generate_image"]) {
        expect(system()).not.toContain(`${tool} |`);
      }
      expect(JSON.stringify(events)).toMatch(/cloud backend/);
    });

    it("keeps local honest: private turn on a local Nexus says so and still answers", async () => {
      vi.stubEnv("NEXUS_EXECUTION", "local");
      up.enqueue({ kind: "text", chunks: ["Done."] });

      const { events, text } = await ask("keep this private: summarise my diary entry");

      expect(text).toBe("Done.");
      expect(events[0]).toMatchObject({ execution: "local" });
      expect(JSON.stringify(events)).toMatch(/local backend/);
      expect(h.searchWeb).not.toHaveBeenCalled();
    });

    it("does not search in research mode on a private turn", async () => {
      await ask("keep this private: latest news on my condition", { mode: "research" });
      expect(h.searchWeb).not.toHaveBeenCalled();
    });
  });

  describe("failure handling", () => {
    it("is a clear 503 when Nexus is not configured, with no backend call and no quota spent", async () => {
      vi.stubEnv("NEXUS_MODEL", "");
      h.checkAndConsumeQuota.mockClear();

      const { status, json } = await ask("hi");

      expect(status).toBe(503);
      expect(JSON.stringify(json)).toMatch(/Nexus is not configured/);
      expect(up.calls).toHaveLength(0);
      expect(h.checkAndConsumeQuota).not.toHaveBeenCalled();
    });

    it("retries a transient backend error and the user just gets the answer", async () => {
      up.enqueue({ kind: "http", status: 503, body: "{}" }, { kind: "text", chunks: ["Recovered."] });
      const { text, events } = await ask("hi", { toolsEnabled: false });

      expect(text).toBe("Recovered.");
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(up.calls).toHaveLength(2);
    });

    it("ends with an honest error and refunds the quota when the backend keeps failing", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      up.enqueue(
        { kind: "http", status: 503, body: "{}" },
        { kind: "http", status: 503, body: "{}" },
        { kind: "http", status: 503, body: "{}" },
      );

      const promise = ask("hi", { toolsEnabled: false });
      await vi.advanceTimersByTimeAsync(20_000);
      const { events, text } = await promise;
      vi.useRealTimers();

      expect(text).toBe("");
      const error = events.find((e) => e.type === "error");
      expect(error).toBeDefined();
      expect(String(error!.message)).toMatch(/Nexus/);
      expect(String(error!.message)).not.toContain("engine-under-test");
      expect(up.calls).toHaveLength(3);
      expect(h.refundQuota).toHaveBeenCalled();
      expect(h.release).toHaveBeenCalledTimes(1);
    });

    it("never leaks the engine's own error text for a bad key", async () => {
      up.enqueue({ kind: "http", status: 401, body: JSON.stringify({ error: { message: "bad key for engine-under-test at VendorCo" } }) });
      const { events } = await ask("hi", { toolsEnabled: false });
      const blob = JSON.stringify(events);

      expect(blob).toMatch(/credentials/);
      expect(blob).not.toMatch(/VendorCo|engine-under-test/);
    });
  });

  it("injects remembered facts into Nexus's prompt only when Memory is on", async () => {
    h.getRelevantMemories.mockResolvedValue([{ id: "m1", fact: "User prefers TypeScript", createdAt: 1 }] as never);

    await ask("hi", { toolsEnabled: false, memoryEnabled: true });
    await ask("hi", { toolsEnabled: false, memoryEnabled: false });

    const sys = (i: number) => JSON.stringify(up.calls[i].body.messages[0].content);
    expect(sys(0)).toContain("User prefers TypeScript");
    expect(sys(1)).not.toContain("User prefers TypeScript");
  });
});
