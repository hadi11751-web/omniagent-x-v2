import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { MAX_PDF_INPUT_CHARS } from "@/lib/limits";
import type { ToolDefinition } from "@/lib/types";

/** A4 at 72dpi. Exported so the layout test measures the same page it draws. */
export const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
export const MARGIN = 56;
const BODY_SIZE = 11;
export const TITLE_SIZE = 18;
const LINE_HEIGHT = 16;

/** WinAnsi maps bytes 0x80-0x9F onto these Unicode code points. */
const WINANSI_SUPPLEMENT =
  "\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152" +
  "\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a" +
  "\u0153\u017e\u0178";

const TRANSLITERABLE: Record<string, string> = {
  "\u00a0": " ",
  "\u2007": " ",
  "\u202f": " ",
  "\u200b": "",
  "\ufeff": "",
  "\u2010": "-",
  "\u2011": "-",
  "\u2012": "-",
  "\u2015": "-",
  "\u2212": "-",
  "\u2192": "->",
  "\u2190": "<-",
  "\u2194": "<->",
  "\u2260": "!=",
  "\u2264": "<=",
  "\u2265": ">=",
  "\u2248": "~=",
  "\u221e": "inf",
  "\u00b5": "u",
  "\u2713": "v",
};

function isWinAnsiChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;

  if (code >= 0x20 && code <= 0x7e) return true;
  if (code >= 0xa0 && code <= 0xff) return true;

  return WINANSI_SUPPLEMENT.includes(char);
}

/**
 * pdf-lib's standard fonts are WinAnsi-encoded and throw on any other glyph,
 * which would fail the whole document for a single emoji or CJK character.
 *
 * Windows line endings go through as one break, not as a glyph: `\r` is not in
 * the font's printable range, so a CRLF document ended every line with the
 * "?" this function uses for a character it had to drop.
 */
export function toWinAnsi(text: string): {
  text: string;
  dropped: number;
} {
  let out = "";
  let dropped = 0;

  for (const char of text.replace(/\r\n?/g, "\n")) {
    if (isWinAnsiChar(char)) {
      out += char;
      continue;
    }

    const mapped = TRANSLITERABLE[char];

    if (mapped !== undefined) {
      out += mapped;
      continue;
    }

    if (char === "\n" || char === "\t") {
      out += char;
      continue;
    }

    dropped += 1;
    out += "?";
  }

  return { text: out, dropped };
}

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
 * Shorten a single line until it fits, because nothing here wraps the title.
 *
 * A character count used to stand in for a measurement: 90 glyphs at the 18pt
 * bold title size are about 743pt wide, and the page leaves 483pt, so a long
 * title ran off the right edge instead of onto the next line.
 */
export function fitToWidth(
  text: string,
  maxWidth: number,
  widthOf: (value: string) => number,
): string {
  const ELLIPSIS = "…";

  let value = text.slice(0, 300);

  if (widthOf(value) <= maxWidth) return value;

  while (value.length > 1 && widthOf(`${value}${ELLIPSIS}`) > maxWidth) {
    value = value.slice(0, -1);
  }

  return `${value.trimEnd()}${ELLIPSIS}`;
}

/**
 * Builds a simple, readable PDF from plain text (paragraphs separated by
 * blank lines). No external API or key required — this runs entirely
 * server-side. Returns a data URL so the browser can render/download it
 * without any extra storage or upload step.
 */
export async function generatePdf(rawText: string, title = "Document"): Promise<string> {
  /*
   * Every line is measured glyph-by-glyph on the request thread, so an unbounded
   * argument is CPU the caller controls. Beyond this the model has to split the
   * document into more than one file.
   */
  if (rawText.length > MAX_PDF_INPUT_CHARS) {
    throw new Error(
      `content is longer than the ${MAX_PDF_INPUT_CHARS} characters one PDF accepts`,
    );
  }

  const text = toWinAnsi(rawText).text.trim();
  if (!text) throw new Error("nothing to put in the PDF");

  const safeTitle = toWinAnsi(title).text.trim() || "Document";
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
  page.drawText(
    fitToWidth(safeTitle, maxWidth, (value) =>
      boldFont.widthOfTextAtSize(value, TITLE_SIZE),
    ),
    {
      x: MARGIN,
      y: cursorY,
      size: TITLE_SIZE,
      font: boldFont,
      color: rgb(0.1, 0.1, 0.1),
    },
  );
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

export function deriveTitle(input: string): { title: string; body: string } {
  const newlineIndex = input.indexOf("\n");
  const firstLine = (newlineIndex < 0 ? input : input.slice(0, newlineIndex)).trim();
  if (firstLine && firstLine.length <= 80 && newlineIndex >= 0) {
    return { title: firstLine, body: input.slice(newlineIndex + 1).trim() || firstLine };
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
      const { dropped } = toWinAnsi(body);

      return {
        ok: true,
        content: [
          `Generated a PDF titled "${title}". It is shown to the user as a download.`,
          dropped
            ? `${dropped} character(s) outside the PDF's built-in Latin font were replaced with "?".`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        data: { file: { dataUrl, filename: `${title.replace(/[^a-z0-9-_ ]/gi, "").trim() || "document"}.pdf` } },
      };
    } catch (error) {
      return { ok: false, content: `generate_pdf error: ${(error as Error).message}` };
    }
  },
};

