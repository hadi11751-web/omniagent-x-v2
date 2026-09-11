import dns from "node:dns/promises";
import net from "node:net";
import { requestJson } from "@/lib/http";
import type { ToolDefinition } from "@/lib/types";

const MAX_CHARS = 8_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);

  if (
    parts.length !== 4 ||
    parts.some(
      (part) => !Number.isInteger(part) || part < 0 || part > 255,
    )
  ) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function mappedIpv6ToIpv4(address: string): string | undefined {
  const normalized = address.toLowerCase();

  if (!normalized.startsWith("::ffff:")) {
    return undefined;
  }

  const hex = normalized.slice("::ffff:".length);

  const groups = hex.split(":");

  if (groups.length !== 2) {
    return undefined;
  }

  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);

  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return undefined;
  }

  return [
    high >> 8,
    high & 0xff,
    low >> 8,
    low & 0xff,
  ].join(".");
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();

  const mappedIpv4 = mappedIpv6ToIpv4(normalized);

  if (mappedIpv4) {
    return isPrivateIpv4(mappedIpv4);
  }

  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  ) {
    return true;
  }

  return false;
}

async function assertSafeHost(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal")
  ) {
    throw new Error("refusing to fetch a private or loopback address");
  }

  const ipVersion = net.isIP(host);

  if (ipVersion === 4 && isPrivateIpv4(host)) {
    throw new Error("refusing to fetch a private or loopback address");
  }

  if (ipVersion === 6 && isPrivateIpv6(host)) {
    throw new Error("refusing to fetch a private or loopback address");
  }

  if (ipVersion !== 0) {
    return;
  }

  const addresses = await dns.lookup(host, {
    all: true,
    verbatim: true,
  });

  if (!addresses.length) {
    throw new Error("unable to resolve target host");
  }

  for (const address of addresses) {
    if (
      (address.family === 4 && isPrivateIpv4(address.address)) ||
      (address.family === 6 && isPrivateIpv6(address.address))
    ) {
      throw new Error("refusing to fetch a private or loopback address");
    }
  }
}

/** Blocks private/loopback hosts and unsafe URL forms. */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const url = new URL(raw);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http(s) URLs are allowed");
  }

  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed");
  }

  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("only ports 80 and 443 are allowed");
  }

  await assertSafeHost(url.hostname);

  return url;
}

/** Small HTML ? text conversion that keeps model input bounded. */
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

async function readLimitedBody(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");

  if (contentLength) {
    const length = Number(contentLength);

    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      throw new Error("response is too large");
    }
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let total = 0;
  let result = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > MAX_RESPONSE_BYTES) {
        throw new Error("response is too large");
      }

      result += decoder.decode(value, { stream: true });
    }

    result += decoder.decode();

    return result;
  } finally {
    reader.releaseLock();
  }
}

function isReadableContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();

  return (
    normalized.startsWith("text/") ||
    normalized.includes("application/json") ||
    normalized.includes("application/xml") ||
    normalized.includes("application/xhtml+xml")
  );
}

async function fetchWithSafeRedirects(
  initialUrl: URL,
): Promise<{ response: Response; url: URL }> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; ; redirectCount++) {
    const response = await requestJson(
      "fetch_url",
      currentUrl.toString(),
      {
        headers: {
          "user-agent":
            "OmniAgent/1.0 (+https://github.com/musharib11701-afk/omniagent-x-v2)",
        },
        timeoutMs: 20_000,
        redirect: "manual",
        allowNonOk: true,
      },
    );

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, url: currentUrl };
    }

    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error("too many redirects");
    }

    const location = response.headers.get("location");

    if (!location) {
      throw new Error("redirect response missing location");
    }

    const nextUrl = new URL(location, currentUrl);
    currentUrl = await assertPublicHttpUrl(nextUrl.toString());

    await response.body?.cancel().catch(() => undefined);
  }
}

export async function fetchReadableText(
  rawUrl: string,
): Promise<{ url: string; text: string }> {
  const input = rawUrl.trim();

  if (input.length > 2_048) {
    throw new Error("URL is too long");
  }

  const initialUrl = await assertPublicHttpUrl(input);
  const { response, url } = await fetchWithSafeRedirects(initialUrl);

  const contentType = response.headers.get("content-type") ?? "";

  if (!isReadableContentType(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("unsupported content type");
  }

  const body = await readLimitedBody(response);

  const text = contentType.toLowerCase().includes("html")
    ? htmlToText(body)
    : body.trim();

  return {
    url: url.toString(),
    text: text.slice(0, MAX_CHARS),
  };
}

export const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  description: "Download a public web page and return its readable text.",
  argument: "the absolute URL to fetch",

  async run(input) {
    try {
      const { url, text } = await fetchReadableText(input);

      if (!text) {
        return {
          ok: false,
          content: `fetch_url: ${url} returned no readable text`,
        };
      }

      return {
        ok: true,
        content: `Content of ${url}:\n${text}`,
        data: {
          sources: [{ title: url, url }],
        },
      };
    } catch {
      return {
        ok: false,
        content: "fetch_url error: unable to fetch the requested URL",
      };
    }
  },
};