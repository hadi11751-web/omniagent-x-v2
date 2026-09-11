import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPublicHttpUrl,
  fetchReadableText,
  htmlToText,
} from "./fetchUrl";

describe("fetchUrl security", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects localhost", async () => {
    await expect(
      assertPublicHttpUrl("http://localhost/test"),
    ).rejects.toThrow("private or loopback");
  });

  it("rejects loopback IPv4", async () => {
    await expect(
      assertPublicHttpUrl("http://127.0.0.1/test"),
    ).rejects.toThrow("private or loopback");
  });

  it("rejects private IPv4 ranges", async () => {
    const addresses = [
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.1.1",
    ];

    for (const address of addresses) {
      await expect(
        assertPublicHttpUrl(`http://${address}/test`),
      ).rejects.toThrow("private or loopback");
    }
  });

  it("rejects IPv6 loopback", async () => {
    await expect(
      assertPublicHttpUrl("http://[::1]/test"),
    ).rejects.toThrow("private or loopback");
  });

  it("rejects IPv4-mapped IPv6 loopback", async () => {
    await expect(
      assertPublicHttpUrl("http://[::ffff:127.0.0.1]/test"),
    ).rejects.toThrow("private or loopback");
  });

  it("rejects IPv4-mapped IPv6 private addresses", async () => {
    await expect(
      assertPublicHttpUrl("http://[::ffff:192.168.1.1]/test"),
    ).rejects.toThrow("private or loopback");
  });

  it("rejects URL credentials", async () => {
    await expect(
      assertPublicHttpUrl("https://user:password@93.184.216.34/test"),
    ).rejects.toThrow("credentials");
  });

  it("rejects non-standard ports", async () => {
    await expect(
      assertPublicHttpUrl("https://93.184.216.34:8080/test"),
    ).rejects.toThrow("ports 80 and 443");
  });

  it("rejects non-http protocols", async () => {
    await expect(
      assertPublicHttpUrl("ftp://93.184.216.34/test"),
    ).rejects.toThrow("only http(s)");
  });

  it("rejects excessively long URLs", async () => {
    const longUrl = `https://93.184.216.34/${"a".repeat(2_049)}`;

    await expect(fetchReadableText(longUrl)).rejects.toThrow(
      "URL is too long",
    );
  });

  it("rejects redirects to private addresses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: {
            location: "http://127.0.0.1/internal",
          },
        }),
      ),
    );

    await expect(
      fetchReadableText("https://93.184.216.34/start"),
    ).rejects.toThrow("private or loopback");

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects excessive redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://93.184.216.34/next",
        },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchReadableText("https://93.184.216.34/start"),
    ).rejects.toThrow("too many redirects");

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects unsupported binary content types", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("binary data", {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
          },
        }),
      ),
    );

    await expect(
      fetchReadableText("https://93.184.216.34/file"),
    ).rejects.toThrow("unsupported content type");
  });

  it("rejects responses larger than 1 MB", async () => {
    const oversized = new Uint8Array(1_000_001);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(oversized, {
          status: 200,
          headers: {
            "content-type": "text/plain",
          },
        }),
      ),
    );

    await expect(
      fetchReadableText("https://93.184.216.34/large"),
    ).rejects.toThrow("response is too large");
  });

  it("rejects oversized Content-Length before reading the body", async () => {
    const response = new Response("small body", {
      status: 200,
      headers: {
        "content-type": "text/plain",
        "content-length": "1000001",
      },
    });

    const cancel = vi.spyOn(response.body!, "cancel");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(
      fetchReadableText("https://93.184.216.34/large"),
    ).rejects.toThrow("response is too large");
  });

  it("extracts readable text from HTML", () => {
    expect(
      htmlToText(`
        <html>
          <head>
            <style>body { display: none }</style>
            <script>alert("ignore")</script>
          </head>
          <body>
            <h1>Hello</h1>
            <p>World &amp; friends</p>
          </body>
        </html>
      `),
    ).toBe("Hello World & friends");
  });

  it("bounds returned readable text to 8000 characters", async () => {
    const body = "x".repeat(10_000);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/plain",
          },
        }),
      ),
    );

    const result = await fetchReadableText(
      "https://93.184.216.34/text",
    );

    expect(result.text).toHaveLength(8_000);
  });
});