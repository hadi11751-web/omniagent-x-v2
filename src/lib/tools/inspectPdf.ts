import { PDFDocument } from "pdf-lib";
import type { ToolDefinition } from "@/lib/types";

const MAX_INPUT_CHARS = 12_000_000;

function decodePdfInput(input: string): Uint8Array {
  const value = input.trim();

  if (!value) {
    throw new Error("PDF input is required");
  }

  if (value.length > MAX_INPUT_CHARS) {
    throw new Error("PDF input is too large");
  }

  const dataUrlMatch = value.match(
    /^data:application\/pdf;base64,([A-Za-z0-9+/=\s]+)$/i,
  );

  const base64 = dataUrlMatch ? dataUrlMatch[1] : value;

  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) {
    throw new Error("expected a PDF data URL or base64-encoded PDF");
  }

  const normalized = base64.replace(/\s+/g, "");
  const bytes = Buffer.from(normalized, "base64");

  if (
    bytes.length < 5 ||
    bytes.subarray(0, 5).toString("ascii") !== "%PDF-"
  ) {
    throw new Error("input is not a valid PDF file");
  }

  return new Uint8Array(bytes);
}

function getPageSize(
  page: ReturnType<PDFDocument["getPages"]>[number],
) {
  const { width, height } = page.getSize();

  return {
    width: Math.round(width * 100) / 100,
    height: Math.round(height * 100) / 100,
  };
}

/**
 * Inspect a PDF without modifying it.
 *
 * Reports structural metadata such as:
 * - page count
 * - file size
 * - document metadata
 * - page dimensions
 *
 * This tool does NOT claim to extract the actual text from the PDF.
 */
export async function inspectPdf(input: string) {
  const bytes = decodePdfInput(input);

  const document = await PDFDocument.load(bytes, {
    ignoreEncryption: false,
  });

  const pages = document.getPages();

  return {
    pageCount: pages.length,
    fileSizeBytes: bytes.byteLength,
    title: document.getTitle() ?? null,
    author: document.getAuthor() ?? null,
    subject: document.getSubject() ?? null,
    keywords: document.getKeywords() ?? null,
    creator: document.getCreator() ?? null,
    producer: document.getProducer() ?? null,
    creationDate: document.getCreationDate()?.toISOString() ?? null,
    modificationDate:
      document.getModificationDate()?.toISOString() ?? null,
    pages: pages.map((page, index) => ({
      page: index + 1,
      ...getPageSize(page),
    })),
  };
}

export const inspectPdfTool: ToolDefinition = {
  name: "inspect_pdf",

  description:
    "Inspect a PDF supplied as a base64 data URL or base64 string and report its page count, file size, document metadata, and page dimensions. Do not claim to have read PDF text with this tool.",

  argument: "a PDF data URL or base64-encoded PDF",

  async run(input) {
    try {
      const info = await inspectPdf(input);

      return {
        ok: true,
        content: JSON.stringify(info, null, 2),
        data: {
          pdfInspection: info,
        },
      };
    } catch (error) {
      return {
        ok: false,
        content: `inspect_pdf error: ${(error as Error).message}`,
      };
    }
  },
};
