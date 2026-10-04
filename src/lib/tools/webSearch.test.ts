import { afterEach, describe, expect, it, vi } from "vitest";
import { searchWeb, webSearchTool } from "./webSearch";

describe("searchWeb failover", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_API_KEY;
  });

  it("falls back from Tavily to Brave when Tavily fails", async () => {
    process.env.TAVILY_API_KEY = "tavily-test";
    process.env.BRAVE_API_KEY = "brave-test";

    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("api.tavily.com")) {
        return new Response("tavily unavailable", { status: 503 });
      }

      if (input.includes("api.search.brave.com")) {
        return Response.json({
          web: {
            results: [
              {
                title: "Brave result",
                url: "https://example.com",
                description: "ok",
              },
            ],
          },
        });
      }

      throw new Error(`unexpected request: ${input}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(searchWeb("test query")).resolves.toEqual({
      engine: "Brave Search",
      sources: [
        {
          title: "Brave result",
          url: "https://example.com",
          snippet: "ok",
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to DuckDuckGo when every configured keyed provider fails", async () => {
    process.env.TAVILY_API_KEY = "tavily-test";
    process.env.BRAVE_API_KEY = "brave-test";

    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("api.tavily.com")) {
        return new Response("tavily unavailable", { status: 503 });
      }

      if (input.includes("api.search.brave.com")) {
        return new Response("brave unavailable", { status: 503 });
      }

      return new Response(
        '<a class="result__a" href="https://example.com/a">Example</a>',
        { status: 200 },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(searchWeb("test query")).resolves.toEqual({
      engine: "DuckDuckGo (keyless fallback)",
      sources: [{ title: "Example", url: "https://example.com/a" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  /*
   * A source list is rendered as clickable links, so a provider that hands back
   * a `javascript:` URL is handing the reader a script that runs on this page.
   * Only the keyless scraper used to look at the scheme at all.
   */
  it("keeps only the results a reader can be linked to", async () => {
    process.env.TAVILY_API_KEY = "tavily-test";

    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes("api.tavily.com")) {
        return Response.json({
          results: [
            { title: "Not a link", url: "javascript:alert(1)" },
            { title: "Real", url: "https://example.com/safe" },
            { title: "Relative", url: "/just/a/path" },
          ],
        });
      }

      throw new Error(`unexpected request: ${input}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(searchWeb("test query")).resolves.toEqual({
      engine: "Tavily",
      sources: [{ title: "Real", url: "https://example.com/safe" }],
    });
  });

  it("treats a page of unusable links as no results rather than a clickable list", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        '<a class="result__a" href="javascript:alert(1)">Example</a>',
        { status: 200 },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(searchWeb("test query")).rejects.toThrow(
      /all search providers failed/,
    );
  });

  /*
   * DuckDuckGo wraps its result links in a redirect, and `searchParams.get()`
   * already decodes that layer once. The extra decode turned "%25" into "%" and
   * threw a URIError on a target whose escaping is not valid UTF-8 - which took
   * the whole search down with it, for one row.
   */
  it("decodes a DuckDuckGo redirect once, so one odd target cannot sink the search", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        [
          '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffr.example.com%2Fcaf%25232&rut=a">Percent</a>',
          '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flat1.example.com%2F%25E9&rut=b">Latin one</a>',
          '<a class="result__a" href="https://plain.example.com/x">Plain</a>',
        ].join("\n"),
        { status: 200 },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(searchWeb("escaping query")).resolves.toEqual({
      engine: "DuckDuckGo (keyless fallback)",
      sources: [
        { title: "Percent", url: "https://fr.example.com/caf%232" },
        { title: "Latin one", url: "https://lat1.example.com/%E9" },
        { title: "Plain", url: "https://plain.example.com/x" },
      ],
    });
  });

  it("forwards an AbortSignal so cancelling it aborts the underlying request", async () => {
    // Regression test: searchWeb used to ignore any caller-provided signal,
    // so cancelling a research request never actually cancelled the
    // in-flight search. requestJson wires the caller's signal into its own
    // internal AbortController, so the request-level signal aborting in sync
    // with the caller's signal is what matters here, not reference equality.
    const controller = new AbortController();

    const fetchMock = vi.fn((_input: string, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const pending = searchWeb("test query", controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalled();
  });

  /*
   * The wrapper is what the agent loop and the research path call, and it used
   * to drop the signal it had been handed: stopping a research turn stopped the
   * reply but left the search running, on every engine in the chain after the
   * one already in flight.
   */
  it("cancels the in-flight search when the tool's caller aborts", async () => {
    const controller = new AbortController();
    const captured: { signal: AbortSignal | null } = { signal: null };

    const fetchMock = vi.fn(
      (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          captured.signal = init?.signal ?? null;

          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const pending = webSearchTool.run("test query", controller.signal);
    controller.abort();

    const result = await pending;

    expect(fetchMock).toHaveBeenCalled();
    expect(captured.signal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });
});
