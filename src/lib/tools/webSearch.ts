import { requestJson } from "@/lib/http";
import { htmlToText } from "./fetchUrl";
import type { Source, ToolDefinition } from "@/lib/types";

const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 5;

interface TavilyResponse {
  results?: {
    title?: string;
    url?: string;
    content?: string;
  }[];
}

interface BraveResponse {
  web?: {
    results?: {
      title?: string;
      url?: string;
      description?: string;
    }[];
  };
}

function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    if (url.username || url.password) {
      return null;
    }

    url.hash = "";

    return url.toString();
  } catch {
    return null;
  }
}

function normalizeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  const normalized: Source[] = [];

  for (const source of sources) {
    const url = normalizeUrl(source.url);

    if (!url || seen.has(url)) continue;

    seen.add(url);

    normalized.push({
      title: source.title?.trim() || url,
      url,
      snippet: source.snippet?.trim() || undefined,
    });

    if (normalized.length >= MAX_RESULTS) break;
  }

  return normalized;
}

async function tavily(query: string, key: string): Promise<Source[]> {
  const response = await requestJson(
    "Tavily",
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: MAX_RESULTS,
        search_depth: "basic",
      }),
      timeoutMs: 25_000,
    },
  );

  const payload = (await response.json()) as TavilyResponse;

  return normalizeSources(
    (payload.results ?? [])
      .filter((result): result is { title?: string; url: string; content?: string } =>
        typeof result.url === "string" && result.url.length > 0,
      )
      .map((result) => ({
        title: result.title ?? result.url,
        url: result.url,
        snippet: result.content,
      })),
  );
}

async function brave(query: string, key: string): Promise<Source[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(MAX_RESULTS));

  const response = await requestJson(
    "Brave Search",
    url.toString(),
    {
      headers: {
        accept: "application/json",
        "x-subscription-token": key,
      },
      timeoutMs: 25_000,
    },
  );

  const payload = (await response.json()) as BraveResponse;

  return normalizeSources(
    (payload.web?.results ?? [])
      .filter((result): result is { title?: string; url: string; description?: string } =>
        typeof result.url === "string" && result.url.length > 0,
      )
      .map((result) => ({
        title: result.title ?? result.url,
        url: result.url,
        snippet: result.description,
      })),
  );
}

/** Keyless fallback. */
async function duckDuckGo(query: string): Promise<Source[]> {
  const response = await requestJson(
    "DuckDuckGo",
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; OmniAgent/1.0)",
        accept: "text/html",
      },
      timeoutMs: 25_000,
    },
  );

  const html = await response.text();
  const sources: Source[] = [];

  const linkPattern =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  let match: RegExpExecArray | null;

  while (
    (match = linkPattern.exec(html)) &&
    sources.length < MAX_RESULTS * 2
  ) {
    let href: string;

    try {
      const parsed = new URL(match[1], "https://html.duckduckgo.com");

      const uddg = parsed.searchParams.get("uddg");

      href = uddg
        ? decodeURIComponent(uddg)
        : parsed.toString();
    } catch {
      continue;
    }

    const normalizedUrl = normalizeUrl(href);

    if (!normalizedUrl) continue;

    sources.push({
      title: htmlToText(match[2]) || normalizedUrl,
      url: normalizedUrl,
    });
  }

  return normalizeSources(sources);
}

export function validateSearchQuery(query: string): string {
  const normalized = query.trim();

  if (!normalized) {
    throw new Error("search query is required");
  }

  if (normalized.length > MAX_QUERY_LENGTH) {
    throw new Error("search query is too long");
  }

  return normalized;
}

export async function searchWeb(
  query: string,
): Promise<{ sources: Source[]; engine: string }> {
  const normalizedQuery = validateSearchQuery(query);

  const tavilyKey = process.env.TAVILY_API_KEY;

  if (tavilyKey) {
    try {
      const sources = await tavily(normalizedQuery, tavilyKey);

      if (sources.length) {
        return { sources, engine: "Tavily" };
      }
    } catch {
      // Fall through to the next configured provider.
    }
  }

  const braveKey = process.env.BRAVE_API_KEY;

  if (braveKey) {
    try {
      const sources = await brave(normalizedQuery, braveKey);

      if (sources.length) {
        return { sources, engine: "Brave Search" };
      }
    } catch {
      // Fall through to the keyless provider.
    }
  }

  try {
    const sources = await duckDuckGo(normalizedQuery);

    if (sources.length) {
      return {
        sources,
        engine: "DuckDuckGo (keyless fallback)",
      };
    }
  } catch {
    // Keep the public error below generic.
  }

  throw new Error("web search is temporarily unavailable");
}

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web and return titles, URLs and snippets. Use it for anything recent or factual.",
  argument: "the search query",

  async run(input) {
    try {
      const { sources, engine } = await searchWeb(input);

      if (!sources.length) {
        return {
          ok: false,
          content: "web_search: no results found",
        };
      }

      const content = [
        `Search results from ${engine}:`,
        ...sources.map(
          (source, index) =>
            `[${index + 1}] ${source.title}\n${source.url}\n${source.snippet ?? ""}`,
        ),
      ].join("\n");

      return {
        ok: true,
        content,
        data: {
          sources,
          engine,
        },
      };
    } catch {
      return {
        ok: false,
        content: "web_search error: search is temporarily unavailable",
      };
    }
  },
};
