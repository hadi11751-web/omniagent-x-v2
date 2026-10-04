import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_TOOLS, runToolSafely } from "./index";

const names = [
  "web_search",
  "fetch_url",
  "calculator",
  "analyze_text",
  "generate_image",
  "generate_pdf",
  "inspect_pdf",
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.TAVILY_API_KEY;
  delete process.env.BRAVE_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

describe("complete Nexus tool catalog", () => {
  it("contains every shipped tool exactly once", () => {
    expect(ALL_TOOLS.map((tool) => tool.name)).toEqual(names);
  });

  it("every tool has executable metadata", () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.argument.length).toBeGreaterThan(3);
      expect(tool.run).toBeTypeOf("function");
    }
  });

  it("keeps synchronous failures inside the tool protocol", async () => {
    const throwingTool = {
      ...ALL_TOOLS.find((tool) => tool.name === "calculator")!,
      run: async () => {
        throw new Error("synthetic failure");
      },
    };

    await expect(runToolSafely(throwingTool, "anything")).resolves.toEqual({
      ok: false,
      content: "calculator error: synthetic failure",
    });
  });

  it("calculator, text analysis, and PDF generation work without external credentials", async () => {
    const calculator = ALL_TOOLS.find((tool) => tool.name === "calculator")!;
    const analyze = ALL_TOOLS.find((tool) => tool.name === "analyze_text")!;
    const pdf = ALL_TOOLS.find((tool) => tool.name === "generate_pdf")!;

    await expect(calculator.run("2 + 3 * 4")).resolves.toMatchObject({ ok: true });
    await expect(analyze.run("hello world hello")).resolves.toMatchObject({ ok: true });
    const generated = await pdf.run("Test PDF\nHello from Nexus");
    expect(generated.ok).toBe(true);
    expect(generated.data).toMatchObject({ file: { filename: expect.stringMatching(/\.pdf$/) } });
  });

  it("generate_image reports an honest dependency failure instead of throwing", async () => {
    delete process.env.GEMINI_API_KEY;
    const image = ALL_TOOLS.find((tool) => tool.name === "generate_image")!;
    const result = await image.run("a test image");
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/GEMINI_API_KEY is not configured/);
  });
});
