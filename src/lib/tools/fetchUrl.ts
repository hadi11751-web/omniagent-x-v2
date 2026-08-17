import { requestJson } from "@/lib/http";
import type { ToolDefinition } from "@/lib/types";

const MAX_CHARS = 8_000;

/** Blocks private/loopback hosts so a prompt cannot probe the internal network. */
export function assertPublicHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http(s) URLs are allowed");
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === "[::1]" ||
    host === "::1";
  if (blocked) throw new Error("refusing to fetch a private or loopback address");
  return url;
}

/** Very small HTML → text conversion; keeps the payload sent to the model small. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchReadableText(rawUrl: string): Promise<{ url: string; text: string }> {
  const url = assertPublicHttpUrl(rawUrl.trim());
  const response = await requestJson("fetch_url", url.toString(), {
    headers: { "user-agent": "OmniAgent/1.0 (+https://github.com/musharib11701-afk/omniagent-x-v2)" },
    timeoutMs: 20_000,
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();
  const text = contentType.includes("html") ? htmlToText(body) : body.trim();
  return { url: url.toString(), text: text.slice(0, MAX_CHARS) };
}

export const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  description: "Download a public web page and return its readable text.",
  argument: "the absolute URL to fetch",
  async run(input) {
    try {
      const { url, text } = await fetchReadableText(input);
      if (!text) return { ok: false, content: `fetch_url: ${url} returned no readable text` };
      return { ok: true, content: `Content of ${url}:\n${text}`, data: { sources: [{ title: url, url }] } };
    } catch (error) {
      return { ok: false, content: `fetch_url error: ${(error as Error).message}` };
    }
  },
};
