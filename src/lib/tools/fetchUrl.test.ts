import { afterEach, describe, expect, it, vi } from "vitest";
import type { PinnedFetchInit } from "@/lib/tools/pinnedFetch";

/*
 * The transport seam is pinnedFetch, so these tests stub it instead of global
 * fetch. DNS and both Node transports are stubbed too: the one case that still
 * runs the real transport (a public name whose answer is loopback) has to be
 * refused before a socket exists, and "socket opened" failing loudly is how
 * that stays provable without network access.
 */
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => [
    {
      address: hostname.startsWith("rebind") ? "127.0.0.1" : "93.184.216.34",
      family: 4,
    },
  ]),
}));

vi.mock("node:http", () => ({
  request: () => {
    throw new Error("socket opened");
  },
}));

vi.mock("node:https", () => ({
  request: () => {
    throw new Error("socket opened");
  },
}));

const { transport } = vi.hoisted(() => ({
  transport: {
    sent: [] as Array<{ url: string; init?: PinnedFetchInit }>,
    send: (async () => {
      throw new Error("no transport stub configured");
    }) as (url: string, init?: PinnedFetchInit) => Promise<Response>,
  },
}));

vi.mock("@/lib/tools/pinnedFetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tools/pinnedFetch")>();

  return {
    ...actual,
    pinnedFetch: (url: string | URL, init?: PinnedFetchInit): Promise<Response> => {
      const target = String(url);
      transport.sent.push({ url: target, init });
      return transport.send(target, init);
    },
  };
});

import {
  assertPublicHttpUrl,
  fetchReadableText,
  fetchUrlTool,
  htmlToText,
} from "@/lib/tools/fetchUrl";

describe("assertPublicHttpUrl", () => {
  it("accepts public http(s) URLs", () => {
    expect(assertPublicHttpUrl("https://example.com/a").hostname).toBe(
      "example.com",
    );
  });

  it("rejects non-http schemes", () => {
    expect(() => assertPublicHttpUrl("file:///etc/passwd")).toThrow(
      /only http/,
    );
    expect(() => assertPublicHttpUrl("ftp://example.com")).toThrow(/only http/);
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1/admin",
    "http://10.1.2.3/",
    "http://192.168.0.1/",
    "http://172.16.5.4/",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://2130706433/",
    "http://db.internal/",
  ])("blocks %s", (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow(/private or loopback/);
  });

  it.each([
    "http://example.com:3000/",
    "https://example.com:8443/admin",
  ])("blocks off-port target %s", (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow(/only ports 80 and 443/);
  });

  it("blocks URLs carrying embedded credentials", () => {
    expect(() => assertPublicHttpUrl("https://admin:hunter2@example.com/")).toThrow(
      /credentials/,
    );
  });

  it("accepts the default http and https ports", () => {
    expect(assertPublicHttpUrl("https://example.com:443/a").hostname).toBe(
      "example.com",
    );
    expect(assertPublicHttpUrl("http://example.com:80/a").hostname).toBe(
      "example.com",
    );
  });
});

describe("fetchReadableText", () => {
  afterEach(() => {
    transport.sent.length = 0;
    transport.send = async () => {
      throw new Error("no transport stub configured");
    };
  });

  it("re-checks the target of each redirect hop", async () => {
    transport.send = async (url) => {
      if (url.startsWith("https://good.example")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      }

      throw new Error(`unexpected request to ${url}`);
    };

    await expect(
      fetchReadableText("https://good.example/redirect"),
    ).rejects.toThrow(/private or loopback/);

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.url).toBe("https://good.example/redirect");
  });

  it("refuses a public hostname whose DNS answer points at loopback", async () => {
    const { pinnedFetch } =
      await vi.importActual<typeof import("@/lib/tools/pinnedFetch")>(
        "@/lib/tools/pinnedFetch",
      );

    transport.send = (url, init) => pinnedFetch(url, init);

    await expect(
      fetchReadableText("https://rebind.example/"),
    ).rejects.toThrow(/private or loopback/);

    expect(transport.sent).toHaveLength(1);
  });

  it("returns text from the final hop and stops after the limit", async () => {
    const body = "<html><body><p>hello</p></body></html>";

    transport.send = async (url) =>
      url.endsWith("/redirect")
        ? new Response(null, { status: 302, headers: { location: "/page" } })
        : new Response(body, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });

    const result = await fetchReadableText("https://example.com/redirect");

    expect(result.text).toBe("hello");
    expect(result.url).toBe("https://example.com/page");
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]?.init?.headers?.["user-agent"]).toMatch(/^OmniAgent/);
    expect(transport.sent[1]?.init?.timeoutMs).toBe(20_000);
  });

  /*
   * The token used to carry a personal repository URL, which every site this
   * tool visits saw. A deployment that wants a contact URL adds it through
   * FETCH_USER_AGENT; the shipped default names the product and nobody else.
   */
  it("sends a product token, not a person's URL", async () => {
    transport.send = async () =>
      new Response("plain text", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });

    await fetchReadableText("https://example.com/page");

    const agent = transport.sent[0]?.init?.headers?.["user-agent"];

    expect(agent).toBe("OmniAgent/1.0");
    expect(agent).not.toMatch(/https?:|github\.com|@/);
  });

  it("takes the operator's own token when FETCH_USER_AGENT is set", async () => {
    vi.stubEnv("FETCH_USER_AGENT", "OmniAgent/1.0 (+https://ops.example.test)");

    try {
      vi.resetModules();
      const reimported = await import("@/lib/tools/fetchUrl");

      transport.sent.length = 0;
      transport.send = async () =>
        new Response("plain text", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });

      await reimported.fetchReadableText("https://example.com/page");

      expect(transport.sent[0]?.init?.headers?.["user-agent"]).toBe(
        "OmniAgent/1.0 (+https://ops.example.test)",
      );
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("surfaces a non-2xx status as an error", async () => {
    transport.send = async () => new Response("missing", { status: 404 });

    await expect(fetchReadableText("https://example.com/gone")).rejects.toThrow(
      /404/,
    );
  });

  it("gives up instead of looping on endless redirects", async () => {
    transport.send = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "/again" },
      });

    await expect(
      fetchReadableText("https://example.com/loop"),
    ).rejects.toThrow(/too many redirects/);

    expect(transport.sent).toHaveLength(6);
  });
});

/*
 * The tool is what a cancelled turn aborts. It used to call the fetch helper
 * without the signal it had been handed, so pressing Stop left the download
 * running to its own timeout.
 */
describe("fetchUrlTool", () => {
  afterEach(() => {
    transport.sent.length = 0;
    transport.send = async () => {
      throw new Error("no transport stub configured");
    };
  });

  it("hands the caller's signal to the transport that opens the connection", async () => {
    transport.send = async () =>
      new Response("<html><body>hello</body></html>", {
        headers: { "content-type": "text/html" },
      });

    const controller = new AbortController();

    const result = await fetchUrlTool.run(
      "https://example.com/page",
      controller.signal,
    );

    expect(result.ok).toBe(true);
    expect(transport.sent[0].init?.signal).toBe(controller.signal);
  });
});

describe("htmlToText", () => {
  it("drops markup, scripts and entities", () => {
    expect(
      htmlToText(
        "<script>var a = 1;</script><style>p{}</style><h1>R&amp;D</h1><p>ok</p>",
      ),
    ).toBe("R&D ok");
  });

  it("decodes an escaped entity once, not twice", () => {
    expect(htmlToText("<p>&amp;lt;b&amp;gt;</p>")).toBe("&lt;b&gt;");
    expect(htmlToText("<p>5 &amp;lt; 6 in the docs</p>")).toBe(
      "5 &lt; 6 in the docs",
    );
  });

  it("decodes a plain entity normally", () => {
    expect(htmlToText("<p>a &lt; b &gt; c</p>")).toBe("a < b > c");
  });
});
