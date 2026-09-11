import { afterEach, describe, expect, it, vi } from "vitest";
import { searchWeb, validateSearchQuery, webSearchTool } from "./webSearch";

const originalEnv = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

function mockJsonResponse(payload: unknown, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(payload),
    text: vi.fn().mockResolvedValue(""),
  } as unknown as Response;
}

function mockTextResponse(text: string, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(text),
  } as unknown as Response;
}

describe("validateSearchQuery", () => {
  it("trims surrounding whitespace", () => {
    expect(validateSearchQuery("  latest AI news  ")).toBe("latest AI news");
  });

  it("rejects an empty query", () => {
    expect(() => validateSearchQuery("   ")).toThrow(
      "search query is required",
    );
  });

  it("rejects queries longer than 500 characters", () => {
    expect(() => validateSearchQuery("a".repeat(501))).toThrow(
      "search query is too long",
    );
  });

  it("accepts a query exactly 500 characters long", () => {
    const query = "a".repeat(500);
    expect(validateSearchQuery(query)).toBe(query);
  });
});

describe("searchWeb", () => {
  it("uses Tavily first when a Tavily key is configured", async () => {
    process.env.TAVILY_API_KEY = "tavily-test-key";
    delete process.env.BRAVE_API_KEY;

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        mockJsonResponse({
          results: [
            {
              title: "Example result",
              url: "https://example.com/page#section",
              content: "Example snippet",
            },
          ],
        }),
      );

    const result = await searchWeb("test query");

    expect(result.engine).toBe("Tavily");
    expect(result.sources).toEqual([
      {
        title: "Example result",
        url: "https://example.com/page",
        snippet: "Example snippet",
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect((init as RequestInit).method).toBe("POST");

    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("content-type")).toBe("application/json");

    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({
      api_key: "tavily-test-key",
      query: "test query",
      max_results: 5,
      search_depth: "basic",
    });
  });

  it("falls back from Tavily to Brave when Tavily fails", async () => {
    process.env.TAVILY_API_KEY = "tavily-test-key";
    process.env.BRAVE_API_KEY = "brave-test-key";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("Tavily unavailable"))
      .mockResolvedValueOnce(
        mockJsonResponse({
          web: {
            results: [
              {
                title: "Brave result",
                url: "https://example.com/brave",
                description: "Brave snippet",
              },
            ],
          },
        }),
      );

    const result = await searchWeb("test query");

    expect(result.engine).toBe("Brave Search");
    expect(result.sources[0]).toEqual({
      title: "Brave result",
      url: "https://example.com/brave",
      snippet: "Brave snippet",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain(
      "https://api.search.brave.com/res/v1/web/search",
    );

    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("x-subscription-token")).toBe("brave-test-key");
  });

  it("falls back from Tavily and Brave to DuckDuckGo", async () => {
    process.env.TAVILY_API_KEY = "tavily-test-key";
    process.env.BRAVE_API_KEY = "brave-test-key";

    const duckHtml = `
      <a class="result__a" href="https://example.com/direct">
        Direct result
      </a>
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.org%2Fredirected">
        Redirected result
      </a>
    `;

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("Tavily unavailable"))
      .mockRejectedValueOnce(new Error("Brave unavailable"))
      .mockResolvedValueOnce(mockTextResponse(duckHtml));

    const result = await searchWeb("fallback test");

    expect(result.engine).toBe("DuckDuckGo (keyless fallback)");
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].url).toBe("https://example.com/direct");
    expect(result.sources[1].url).toBe("https://example.org/redirected");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses DuckDuckGo when no API keys are configured", async () => {
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_API_KEY;

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        mockTextResponse(`
          <a class="result__a" href="https://example.com/a">Result A</a>
        `),
      );

    const result = await searchWeb("no keys");

    expect(result.engine).toBe("DuckDuckGo (keyless fallback)");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe("https://example.com/a");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes URLs by removing fragments", async () => {
    process.env.TAVILY_API_KEY = "test-key";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockJsonResponse({
        results: [
          {
            title: "Fragmented",
            url: "https://example.com/page#one",
            content: "first",
          },
        ],
      }),
    );

    const result = await searchWeb("fragment test");

    expect(result.sources[0].url).toBe("https://example.com/page");
  });

  it("deduplicates equivalent normalized URLs", async () => {
    process.env.TAVILY_API_KEY = "test-key";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockJsonResponse({
        results: [
          {
            title: "First",
            url: "https://example.com/page#one",
            content: "one",
          },
          {
            title: "Second",
            url: "https://example.com/page#two",
            content: "two",
          },
          {
            title: "Third",
            url: "https://example.org/other",
            content: "three",
          },
        ],
      }),
    );

    const result = await searchWeb("dedupe test");

    expect(result.sources).toHaveLength(2);
    expect(result.sources.map((source) => source.url)).toEqual([
      "https://example.com/page",
      "https://example.org/other",
    ]);
  });

  it("caps results at five", async () => {
    process.env.TAVILY_API_KEY = "test-key";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockJsonResponse({
        results: Array.from({ length: 10 }, (_, index) => ({
          title: `Result ${index + 1}`,
          url: `https://example.com/${index + 1}`,
          content: `Snippet ${index + 1}`,
        })),
      }),
    );

    const result = await searchWeb("limit test");

    expect(result.sources).toHaveLength(5);
    expect(result.sources.map((source) => source.title)).toEqual([
      "Result 1",
      "Result 2",
      "Result 3",
      "Result 4",
      "Result 5",
    ]);
  });

  it("ignores malformed Tavily results", async () => {
    process.env.TAVILY_API_KEY = "test-key";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockJsonResponse({
        results: [
          { title: "Missing URL" },
          { title: "Bad URL", url: "not a valid url" },
          {
            title: "Valid",
            url: "https://example.com/valid",
            content: "Valid result",
          },
        ],
      }),
    );

    const result = await searchWeb("malformed test");

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].title).toBe("Valid");
  });

  it("rejects search-result URLs containing credentials", async () => {
    process.env.TAVILY_API_KEY = "test-key";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockJsonResponse({
        results: [
          {
            title: "Credential URL",
            url: "https://user:password@example.com/private",
            content: "should be rejected",
          },
          {
            title: "Safe",
            url: "https://example.com/safe",
            content: "safe result",
          },
        ],
      }),
    );

    const result = await searchWeb("credential URL test");

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].title).toBe("Safe");
  });

  it("ignores non-http search-result URLs", async () => {
    process.env.TAVILY_API_KEY = "test-key";

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockJsonResponse({
        results: [
          {
            title: "FTP",
            url: "ftp://example.com/file",
            content: "should be rejected",
          },
          {
            title: "JavaScript",
            url: "javascript:alert(1)",
            content: "should be rejected",
          },
          {
            title: "Safe",
            url: "https://example.com/safe",
            content: "safe result",
          },
        ],
      }),
    );

    const result = await searchWeb("protocol test");

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].title).toBe("Safe");
  });

  it("returns a generic error when every provider fails", async () => {
    process.env.TAVILY_API_KEY = "tavily-test-key";
    process.env.BRAVE_API_KEY = "brave-test-key";

    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("SECRET PROVIDER ERROR SHOULD NOT LEAK"),
    );

    await expect(searchWeb("failure test")).rejects.toThrow(
      "web search is temporarily unavailable",
    );

    await expect(webSearchTool.run("failure test")).resolves.toEqual({
      ok: false,
      content: "web_search error: search is temporarily unavailable",
    });
  });

  it("trims whitespace in tool input before searching", async () => {
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_API_KEY;

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockTextResponse(`
        <a class="result__a" href="https://example.com/result">Result</a>
      `),
    );

    const result = await webSearchTool.run("   trimmed query   ");

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Search results from DuckDuckGo");
    expect(result.content).toContain("https://example.com/result");
  });

  it("returns no-results when every provider returns an empty result set", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    delete process.env.BRAVE_API_KEY;

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        mockJsonResponse({ results: [] }),
      )
      .mockResolvedValueOnce(
        mockTextResponse(""),
      );

    const result = await webSearchTool.run("empty results");

    expect(result.ok).toBe(false);
    expect(result.content).toBe(
      "web_search error: search is temporarily unavailable",
    );
  });
});

