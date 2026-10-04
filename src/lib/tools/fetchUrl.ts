import { UpstreamError } from "@/lib/http";
import {
  isBlockedHostname,
  isPrivateIp,
  pinnedFetch,
} from "@/lib/tools/pinnedFetch";
import type { ToolDefinition } from "@/lib/types";

const MAX_CHARS = 8_000;
const MAX_RESPONSE_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;

/*
 * End-to-end per hop, not time-to-headers: `pinnedFetch` keeps this deadline
 * armed until the response body closes, so a server that sends headers and then
 * stalls cannot hold the request open. That is what the value now buys, and it
 * is also what it costs - the body of a page slower than ~75 KB/s has to arrive
 * inside the same 20s it used to spend only on the headers.
 */
const FETCH_TIMEOUT_MS = 20_000;
/*
 * A crawler identifier is conventionally paired with a reachable contact URL.
 * Which URL that is belongs to the deployment, not to the source, so it is
 * supplied by `FETCH_USER_AGENT` when the operator wants the fuller form and
 * this stays a plain product token otherwise.
 */
const USER_AGENT = process.env.FETCH_USER_AGENT?.trim() || "OmniAgent/1.0";

/** Blocks private/loopback targets before network access. */
export function assertPublicHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http(s) URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host) || isPrivateIp(host)) {
    throw new Error("refusing to fetch a private or loopback address");
  }

  /*
   * Checked after the host test so `http://localhost:3000` is reported as the
   * loopback target it is rather than as a port problem.
   */
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("only ports 80 and 443 are allowed");
  }

  return url;
}

/** Very small HTML → text conversion; keeps the payload sent to the model small. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    /*
     * `&amp;` is decoded last and on its own. Decoding it first turns the
     * escaped spelling of another entity into that entity, so a page saying
     * `&amp;lt;` reaches the model as `<` — one decode step more than the page
     * asked for, and a double-decode is how escaped text starts looking like
     * markup to whatever reads the answer.
     */
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = maxBytes - bytesRead;
      if (remaining <= 0) break;

      const chunk = value.byteLength <= remaining ? value : value.slice(0, remaining);
      bytesRead += chunk.byteLength;
      text += decoder.decode(chunk, { stream: bytesRead < maxBytes });

      if (bytesRead >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return text + decoder.decode();
}

/**
 * Follows redirects by hand because automatic following would let a public
 * URL point the request at an internal address without re-checking it.
 */
async function fetchWithSafeRedirects(
  start: URL,
  signal?: AbortSignal,
): Promise<{ response: Response; url: URL }> {
  let current = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await pinnedFetch(current.toString(), {
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: { "user-agent": USER_AGENT },
      signal,
    });

    if (response.status < 300 || response.status >= 400) {
      return { response, url: current };
    }

    const location = response.headers.get("location");
    if (!location) return { response, url: current };

    void response.body?.cancel().catch(() => undefined);
    current = assertPublicHttpUrl(new URL(location, current).toString());
  }

  throw new Error(`too many redirects from ${start.toString()}`);
}

export async function fetchReadableText(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<{ url: string; text: string }> {
  const start = assertPublicHttpUrl(rawUrl.trim());
  const { response, url } = await fetchWithSafeRedirects(start, signal);
  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    const detail = (await readTextLimited(response, 20_000)).slice(0, 300);
    throw new UpstreamError(
      "fetch_url",
      response.status,
      detail || response.statusText,
    );
  }

  if (
    contentType &&
    !/(?:text\/|application\/(?:json|xml|javascript|xhtml\+xml))/i.test(
      contentType,
    )
  ) {
    throw new Error(`unsupported content type: ${contentType.split(";")[0]}`);
  }

  const body = await readTextLimited(response, MAX_RESPONSE_BYTES);
  const text = contentType.includes("html") ? htmlToText(body) : body.trim();
  return {
    url: url.toString(),
    text: text.slice(0, MAX_CHARS),
  };
}

export const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  description: "Download a public web page and return its readable text.",
  argument: "the absolute URL to fetch",
  async run(input, signal) {
    try {
      const { url, text } = await fetchReadableText(input, signal);
      if (!text) {
        return {
          ok: false,
          content: `fetch_url: ${url} returned no readable text`,
        };
      }
      return {
        ok: true,
        content: `Content of ${url}:\n${text}`,
        data: { sources: [{ title: url, url }] },
      };
    } catch (error) {
      return {
        ok: false,
        content: `fetch_url error: ${(error as Error).message}`,
      };
    }
  },
};
