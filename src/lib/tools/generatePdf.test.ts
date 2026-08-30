import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { generatePdf } from "@/lib/tools/generatePdf";

describe("generatePdf", () => {
  it("produces a data URL with a structurally valid PDF inside it", async () => {
    const dataUrl = await generatePdf("Hello from a test.", "Test Doc");
    expect(dataUrl.startsWith("data:application/pdf;base64,")).toBe(true);

    const base64 = dataUrl.split(",")[1];
    const bytes = Buffer.from(base64, "base64");
    expect(bytes.subarray(0, 4).toString()).toBe("%PDF");

    // Round-trip it through a real PDF parser, not just a header check.
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("rejects empty input instead of silently producing a blank file", async () => {
    await expect(generatePdf("   ")).rejects.toThrow();
  });

  it("wraps long lines onto multiple pages without throwing", async () => {
    const longText = "word ".repeat(2000);
    const dataUrl = await generatePdf(longText, "Long Doc");
    const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

