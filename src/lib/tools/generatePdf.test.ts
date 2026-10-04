import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  MARGIN,
  PAGE_WIDTH,
  TITLE_SIZE,
  deriveTitle,
  fitToWidth,
  generatePdf,
  toWinAnsi,
} from "@/lib/tools/generatePdf";
import { MAX_PDF_INPUT_CHARS } from "@/lib/limits";

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

  it("survives glyphs the built-in WinAnsi font cannot encode", async () => {
    const dataUrl = await generatePdf(
      "Revenue 2024→2025 ≈ +12% — 中文 emoji 🎉",
      "Quarterly 中文 🎉",
    );

    const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("wraps long lines onto multiple pages without throwing", async () => {
    const longText = "word ".repeat(2000);
    const dataUrl = await generatePdf(longText, "Long Doc");
    const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("refuses content past the documented ceiling instead of laying it out", async () => {
    await expect(
      generatePdf("a".repeat(MAX_PDF_INPUT_CHARS + 1)),
    ).rejects.toThrow(/longer than the/);
  });
});

describe("what the page owes the reader", () => {
  /*
   * `\r` is not a printable WinAnsi glyph, so a CRLF document - what a Windows
   * clipboard or a model copying a pasted file gives back - ended every line
   * with the "?" this module uses for a character it had to drop.
   */
  it("treats a Windows line ending as one break, not a dropped glyph", () => {
    const { text, dropped } = toWinAnsi("one\r\ntwo\r\n\r\nthree");

    expect(dropped).toBe(0);
    expect(text).toBe("one\ntwo\n\nthree");
  });

  it("keeps a lone carriage return a line break too", () => {
    expect(toWinAnsi("one\rtwo").text).toBe("one\ntwo");
  });

  /*
   * The title used to be cut by a character count instead of measured: 90 glyphs
   * of the 18pt bold title are far wider than the page leaves, and nothing wraps
   * that line, so it ran off the right edge.
   */
  it("draws a long title inside the printable width", async () => {
    const doc = await PDFDocument.create();
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const usable = PAGE_WIDTH - MARGIN * 2;

    const title =
      "Quarterly results for the Americas, EMEA and APAC regions — " +
      "draft for the board meeting next Tuesday morning";

    // The old ceiling of 90 characters was wider than the page.
    expect(bold.widthOfTextAtSize(title.slice(0, 90), TITLE_SIZE)).toBeGreaterThan(
      usable,
    );

    const fitted = fitToWidth(title, usable, (value) =>
      bold.widthOfTextAtSize(value, TITLE_SIZE),
    );

    expect(bold.widthOfTextAtSize(fitted, TITLE_SIZE)).toBeLessThanOrEqual(usable);
    expect(fitted.endsWith("…")).toBe(true);
  });

  it("leaves a title that already fits untouched", () => {
    expect(
      fitToWidth("Short", PAGE_WIDTH - MARGIN * 2, (value) => value.length * 10),
    ).toBe("Short");
  });
});

describe("deriveTitle", () => {  it("splits a clean title line from the body", () => {
    expect(deriveTitle("My Title\nBody text\nMore")).toEqual({
      title: "My Title",
      body: "Body text\nMore",
    });
  });

  it("does not corrupt the body when the title line has surrounding whitespace", () => {
    // Regression test: deriveTitle used to slice the raw input at the
    // *trimmed* title's length instead of the real newline position, which
    // chopped characters off the front of the body whenever the first line
    // had leading or trailing whitespace.
    expect(deriveTitle("  Title  \nBody")).toEqual({
      title: "Title",
      body: "Body",
    });
  });

  it("falls back to a generic title when there is no newline", () => {
    expect(deriveTitle("Just one line")).toEqual({
      title: "Document",
      body: "Just one line",
    });
  });
});

