import { requestJson } from "@/lib/http";
import { followableSources } from "@/lib/sources";
import { htmlToText } from "./fetchUrl";
import type { Source, ToolDefinition } from "@/lib/types";

const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 5;

interface TavilyResponse {
  results?: { title?: string; url?: string; content?: string }[];
}

interface BraveResponse {
  web?: { results?: { title?: string; url?: string; description?: string }[] };
}

async function tavily(query: string, key: string, signal?: AbortSignal): Promise<Source[]> {
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
      signal,
    },
  );
  const payload = (await response.json()) as TavilyResponse;
  return (payload.results ?? [])
    .filter(
      (result): result is {
        title: string;
        url: string;
        content?: string;
      } => Boolean(result.url),
    )
    .map((result) => ({
      title: result.title ?? result.url,
      url: result.url,
      snippet: result.content,
    }));
}

async function brave(query: string, key: string, signal?: AbortSignal): Promise<Source[]> {
  const response = await requestJson(
    "Brave Search",
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`,
    {
      headers: {
        accept: "application/json",
        "x-subscription-token": key,
      },
      timeoutMs: 25_000,
      signal,
    },
  );
  const payload = (await response.json()) as BraveResponse;
  return (payload.web?.results ?? [])
    .filter(
      (result): result is {
        title: string;
        url: string;
        description?: string;
      } => Boolean(result.url),
    )
    .map((result) => ({
      title: result.title ?? result.url,
      url: result.url,
      snippet: result.description,
    }));
}

/** Keyless fallback. Fewer and noisier results, but keeps research usable. */
async function duckDuckGo(query: string, signal?: AbortSignal): Promise<Source[]> {
  const response = await requestJson(
    "DuckDuckGo",
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; OmniAgent/1.0)",
      },
      timeoutMs: 25_000,
      signal,
    },
  );
  const html = await response.text();
  const sources: Source[] = [];
  const linkPattern =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) && sources.length < MAX_RESULTS) {
    /*
     * `searchParams.get()` already percent-decodes the value once. A second
     * `decodeURIComponent` on the result turned "%25" into "%" - and threw a
     * URIError on any target whose own escaping is not valid UTF-8, like a
     * Latin-1 `%E9`, which used to fail the whole search over one row.
     */
    const href = match[1].startsWith("//duckduckgo.com/l/?uddg=")
      ? new URL(`https:${match[1]}`).searchParams.get("uddg") ?? ""
      : match[1];
    if (!href.startsWith("http")) continue;
    sources.push({
      title: htmlToText(match[2]) || href,
      url: href,
    });
  }
  return sources;
}

interface SearchAttempt {
  engine: string;
  run: () => Promise<Source[]>;
}

/**
 * Search providers are intentionally failover ordered. A configured provider
 * is only considered successful when it returns at least one usable result.
 */
export async function searchWeb(
  rawQuery: string,
  signal?: AbortSignal,
): Promise<{ sources: Source[]; engine: string }> {
  const query = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
  if (!query) throw new Error("search query is empty");

  const attempts: SearchAttempt[] = [];
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  const braveKey = process.env.BRAVE_API_KEY?.trim();

  if (tavilyKey) {
    attempts.push({ engine: "Tavily", run: () => tavily(query, tavilyKey, signal) });
  }
  if (braveKey) {
    attempts.push({ engine: "Brave Search", run: () => brave(query, braveKey, signal) });
  }

  attempts.push({
    engine: "DuckDuckGo (keyless fallback)",
    run: () => duckDuckGo(query, signal),
  });

  const failures: string[] = [];

  for (const attempt of attempts) {
    /*
     * Every engine is tried in order, so without this a cancelled turn still
     * reached the next provider on the way to the aggregate error.
     */
    if (signal?.aborted) {
      throw new Error("search aborted");
    }

    try {
      /*
       * One filter for every engine: an href the reader clicks has to be a link
       * the browser may follow, and only the DuckDuckGo path checked the scheme
       * on its own.
       */
      const sources = followableSources(await attempt.run());
      if (sources.length) {
        return { sources, engine: attempt.engine };
      }
      failures.push(`${attempt.engine}: no results`);
    } catch (error) {
      failures.push(`${attempt.engine}: ${(error as Error).message}`);
    }
  }

  throw new Error(`all search providers failed: ${failures.join("; ")}`);
}

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "Search the web and return titles, URLs and snippets. Use it for anything recent or factual.",
  argument: "the search query",
  async run(input, signal) {
    try {
      const { sources, engine } = await searchWeb(input, signal);
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
        data: { sources, engine },
      };
    } catch (error) {
      return {
        ok: false,
        content: `web_search error: ${(error as Error).message}`,
      };
    }
  },
};
