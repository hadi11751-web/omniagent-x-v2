import { describe, expect, it } from "vitest";
import { generatePdf } from "@/lib/tools/generatePdf";
import { inspectPdf } from "@/lib/tools/inspectPdf";

describe("inspectPdf", () => {
  it("inspects a real generated PDF", async () => {
    const dataUrl = await generatePdf("Hello from inspectPdf.", "Inspection Test");
    const info = await inspectPdf(dataUrl);

    expect(info.pageCount).toBeGreaterThanOrEqual(1);
    expect(info.fileSizeBytes).toBeGreaterThan(0);
    expect(info.title).toBeNull();
    expect(info.pages.length).toBe(info.pageCount);
    expect(info.pages[0].page).toBe(1);
  });

  it("rejects empty input", async () => {
    await expect(inspectPdf("   ")).rejects.toThrow("PDF input is required");
  });

  it("rejects malformed base64 or non-PDF input", async () => {
    const nonPdfBase64 = Buffer.from("definitely not a PDF").toString("base64");
    await expect(inspectPdf(nonPdfBase64)).rejects.toThrow(
      "input is not a valid PDF file",
    );
  });

  it("rejects PDFs whose decoded bytes exceed the safety limit", async () => {
    const bytes = Buffer.alloc(9_000_001);
    bytes.write("%PDF-", 0, "ascii");

    const base64 = bytes.toString("base64");

    await expect(inspectPdf(base64)).rejects.toThrow("PDF input is too large");
  });
});

