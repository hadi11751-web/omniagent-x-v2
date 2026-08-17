import { requestJson } from "@/lib/http";
import { htmlToText } from "./fetchUrl";
import type { Source, ToolDefinition } from "@/lib/types";

interface TavilyResponse {
  results?: { title?: string; url?: string; content?: string }[];
}

interface BraveResponse {
  web?: { results?: { title?: string; url?: string; description?: string }[] };
}

async function tavily(query: string, key: string): Promise<Source[]> {
  const response = await requestJson("Tavily", "https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query, max_results: 5, search_depth: "basic" }),
    timeoutMs: 25_000,
  });
  const payload = (await response.json()) as TavilyResponse;
  return (payload.results ?? [])
    .filter((result): result is { title: string; url: string; content?: string } => Boolean(result.url))
    .map((result) => ({ title: result.title ?? result.url, url: result.url, snippet: result.content }));
}

async function brave(query: string, key: string): Promise<Source[]> {
  const response = await requestJson(
    "Brave Search",
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
    { headers: { accept: "application/json", "x-subscription-token": key }, timeoutMs: 25_000 },
  );
  const payload = (await response.json()) as BraveResponse;
  return (payload.web?.results ?? [])
    .filter((result): result is { title: string; url: string; description?: string } => Boolean(result.url))
    .map((result) => ({ title: result.title ?? result.url, url: result.url, snippet: result.description }));
}

/** Keyless fallback. Fewer and noisier results, but keeps research usable. */
async function duckDuckGo(query: string): Promise<Source[]> {
  const response = await requestJson(
    "DuckDuckGo",
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { "user-agent": "Mozilla/5.0 (compatible; OmniAgent/1.0)" }, timeoutMs: 25_000 },
  );
  const html = await response.text();
  const sources: Source[] = [];
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) && sources.length < 5) {
    const href = match[1].startsWith("//duckduckgo.com/l/?uddg=")
      ? decodeURIComponent(new URL(`https:${match[1]}`).searchParams.get("uddg") ?? "")
      : match[1];
    if (!href.startsWith("http")) continue;
    sources.push({ title: htmlToText(match[2]) || href, url: href });
  }
  return sources;
}

export async function searchWeb(query: string): Promise<{ sources: Source[]; engine: string }> {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (tavilyKey) return { sources: await tavily(query, tavilyKey), engine: "Tavily" };
  const braveKey = process.env.BRAVE_API_KEY;
  if (braveKey) return { sources: await brave(query, braveKey), engine: "Brave Search" };
  return { sources: await duckDuckGo(query), engine: "DuckDuckGo (keyless fallback)" };
}

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description: "Search the web and return titles, URLs and snippets. Use it for anything recent or factual.",
  argument: "the search query",
  async run(input) {
    try {
      const { sources, engine } = await searchWeb(input.trim());
      if (!sources.length) return { ok: false, content: `web_search: ${engine} returned no results` };
      const content = [
        `Search results from ${engine}:`,
        ...sources.map((source, index) => `[${index + 1}] ${source.title}\n${source.url}\n${source.snippet ?? ""}`),
      ].join("\n");
      return { ok: true, content, data: { sources, engine } };
    } catch (error) {
      return { ok: false, content: `web_search error: ${(error as Error).message}` };
    }
  },
};
