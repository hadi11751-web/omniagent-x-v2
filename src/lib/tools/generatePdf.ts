import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { ToolDefinition } from "@/lib/types";

const PAGE_WIDTH = 595.28; // A4 at 72dpi
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const BODY_SIZE = 11;
const TITLE_SIZE = 18;
const LINE_HEIGHT = 16;

/** Greedy word-wrap so lines never overflow the page width. */
function wrapLine(
  text: string,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  size: number,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Builds a simple, readable PDF from plain text (paragraphs separated by
 * blank lines). No external API or key required — this runs entirely
 * server-side. Returns a data URL so the browser can render/download it
 * without any extra storage or upload step.
 */
export async function generatePdf(rawText: string, title = "Document"): Promise<string> {
  const text = rawText.trim();
  if (!text) throw new Error("nothing to put in the PDF");

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const maxWidth = PAGE_WIDTH - MARGIN * 2;

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let cursorY = PAGE_HEIGHT - MARGIN;

  const ensureSpace = (needed: number) => {
    if (cursorY - needed < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      cursorY = PAGE_HEIGHT - MARGIN;
    }
  };

  ensureSpace(TITLE_SIZE + LINE_HEIGHT);
  page.drawText(title.slice(0, 90), {
    x: MARGIN,
    y: cursorY,
    size: TITLE_SIZE,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.1),
  });
  cursorY -= TITLE_SIZE + LINE_HEIGHT;

  const paragraphs = text.split(/\n{2,}/);
  for (const paragraph of paragraphs) {
    const rawLines = paragraph.split("\n");
    for (const rawLine of rawLines) {
      for (const line of wrapLine(rawLine, font, BODY_SIZE, maxWidth)) {
        ensureSpace(LINE_HEIGHT);
        page.drawText(line, { x: MARGIN, y: cursorY, size: BODY_SIZE, font, color: rgb(0, 0, 0) });
        cursorY -= LINE_HEIGHT;
      }
    }
    cursorY -= LINE_HEIGHT * 0.5; // paragraph gap
  }

  const bytes = await doc.save();
  return `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`;
}

function deriveTitle(input: string): { title: string; body: string } {
  const firstLine = input.split("\n")[0]?.trim() ?? "";
  if (firstLine && firstLine.length <= 80 && input.includes("\n")) {
    return { title: firstLine, body: input.slice(firstLine.length).trim() || firstLine };
  }
  return { title: "Document", body: input };
}

export const generatePdfTool: ToolDefinition = {
  name: "generate_pdf",
  description:
    "Create a downloadable PDF file from text content the user wants saved or exported. Use it when the user asks to turn something into a PDF, save a document, or export a report. Put an optional short title as the first line.",
  argument: "the content to put in the PDF (optionally starting with a title line)",
  async run(input) {
    try {
      const { title, body } = deriveTitle(input.trim());
      const dataUrl = await generatePdf(body, title);
      return {
        ok: true,
        content: `Generated a PDF titled "${title}". It is shown to the user as a download.`,
        data: { file: { dataUrl, filename: `${title.replace(/[^a-z0-9-_ ]/gi, "").trim() || "document"}.pdf` } },
      };
    } catch (error) {
      return { ok: false, content: `generate_pdf error: ${(error as Error).message}` };
    }
  },
};

