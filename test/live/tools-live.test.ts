import { describe, expect, it } from "vitest";
import { availableTools, findTool } from "@/lib/tools";

const live = process.env.LIVE_TOOLS_SMOKE === "1";

describe.skipIf(!live)("live Nexus tool smoke", () => {
  it("exposes the complete tool catalog contract", () => {
    const names = availableTools().map((tool) => tool.name);
    expect(names).toContain("calculator");
    expect(names).toContain("analyze_text");
    expect(names).toContain("generate_pdf");
    expect(names).toContain("inspect_pdf");
    expect(names).toContain("fetch_url");
    expect(names).toContain("web_search");
    if (process.env.GEMINI_API_KEY?.trim()) {
      expect(names).toContain("generate_image");
    }
  });

  it("runs calculator and text analysis", async () => {
    const calculator = findTool("calculator");
    const analyze = findTool("analyze_text");
    expect(calculator).toBeDefined();
    expect(analyze).toBeDefined();

    await expect(calculator!.run("17 * 23")).resolves.toMatchObject({ ok: true });
    await expect(analyze!.run("hello hello world")).resolves.toMatchObject({ ok: true });
  });

  it("generates then inspects a real PDF in-process", async () => {
    const generate = findTool("generate_pdf");
    const inspect = findTool("inspect_pdf");
    expect(generate).toBeDefined();
    expect(inspect).toBeDefined();

    const created = await generate!.run("Live tool smoke\nPDF generated successfully.");
    expect(created.ok).toBe(true);

    const dataUrl = (created.data as { file?: { dataUrl?: string } })?.file?.dataUrl;
    expect(dataUrl).toMatch(/^data:application\/pdf;base64,/);

    const inspected = await inspect!.run(dataUrl!);
    expect(inspected.ok).toBe(true);
    expect(inspected.content).toMatch(/pageCount/);
  });

  it("fetches a public HTTPS page", async () => {
    const fetchUrl = findTool("fetch_url");
    expect(fetchUrl).toBeDefined();

    const result = await fetchUrl!.run("https://example.com/");
    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/Example Domain/i);
  });

  it("uses the live search provider chain when one is available", async () => {
    const search = findTool("web_search");
    expect(search).toBeDefined();

    const result = await search!.run("official Vercel Fluid Compute documentation");
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ engine: expect.any(String) });
    expect(result.content).toMatch(/https?:\/\//);
  });

  it("generates a real image when the Gemini image service is configured", async () => {
    if (!process.env.GEMINI_API_KEY?.trim()) return;

    const image = findTool("generate_image");
    expect(image).toBeDefined();

    const result = await image!.run(
      "A simple blue geometric sphere on a plain white background.",
    );
    expect(result.ok).toBe(true);
    expect((result.data as { image?: string })?.image).toMatch(
      /^data:image\//,
    );
  });
});
