import type { IncomingMessage, RequestOptions } from "node:http";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface UpstreamSpec {
  status?: number;
  statusText?: string;
  headers?: Record<string, string | string[]>;
  body?: string;
  hangs?: boolean;
  bodyHangs?: boolean;
}

const { dnsLookup, requestSpy, state } = vi.hoisted(() => ({
  dnsLookup: vi.fn(),
  requestSpy: vi.fn(),
  state: {
    upstream: { status: 200, statusText: "OK", body: "public page" } as UpstreamSpec,
    issued: [] as FakeClientRequest[],
  },
}));

/*
 * The transports are stubbed so the assertions can read the options the module
 * handed Node, which is the only place the pinned address is observable. The
 * call-count checks are what prove no connection was attempted for a refused
 * target.
 */
vi.mock("node:dns/promises", () => ({ lookup: dnsLookup }));
vi.mock("node:http", () => ({ request: requestSpy }));
vi.mock("node:https", () => ({ request: requestSpy }));

import { isBlockedHostname, isPrivateIp, pinnedFetch } from "@/lib/tools/pinnedFetch";

class FakeClientRequest {
  private readonly handlers = new Map<
    "response" | "error",
    (payload: IncomingMessage | Error) => void
  >();

  private response?: IncomingMessage;

  constructor(
    readonly options: RequestOptions,
    private readonly upstream: UpstreamSpec,
  ) {}

  once(
    event: "response" | "error",
    handler: (payload: IncomingMessage | Error) => void,
  ): this {
    this.handlers.set(event, handler);
    return this;
  }

  end(): void {
    this.options.signal?.addEventListener(
      "abort",
      () => {
        if (this.response) {
          (this.response as Readable).destroy(new Error("aborted by signal"));
        }
        this.emit("error", new Error("aborted by signal"));
      },
      { once: true },
    );

    if (this.upstream.hangs) return;

    queueMicrotask(() => {
      this.response = toIncomingMessage(this.upstream);
      this.emit("response", this.response);
    });
  }

  private emit(event: "response" | "error", payload: IncomingMessage | Error): void {
    this.handlers.get(event)?.(payload);
  }
}

function toIncomingMessage(upstream: UpstreamSpec): IncomingMessage {
  const stream = new Readable({ read() {} });
  if (upstream.body) stream.push(Buffer.from(upstream.body, "utf8"));
  if (!upstream.bodyHangs) stream.push(null);

  return Object.assign(stream, {
    statusCode: upstream.status ?? 200,
    statusMessage: upstream.statusText ?? "OK",
    headers: upstream.headers ?? {},
  }) as unknown as IncomingMessage;
}

function runLookup(
  lookup: RequestOptions["lookup"],
  options: LookupOptions,
): Promise<string | LookupAddress[]> {
  if (!lookup) return Promise.reject(new Error("no lookup handed to the transport"));

  return new Promise((resolve, reject) => {
    lookup("example.com", options, (error, address) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(address);
    });
  });
}

beforeEach(() => {
  state.upstream = { status: 200, statusText: "OK", body: "public page" };

  dnsLookup.mockImplementation(async () => [
    { address: "93.184.216.34", family: 4 },
  ]);

  requestSpy.mockImplementation((options: RequestOptions) => {
    const client = new FakeClientRequest(options, state.upstream);
    state.issued.push(client);
    return client;
  });
});

afterEach(() => {
  state.issued.length = 0;
  dnsLookup.mockReset();
  requestSpy.mockReset();
});

describe("pinnedFetch", () => {
  it("keeps the socket on the validated address after DNS turns over", async () => {
    const response = await pinnedFetch("https://example.com/page", {
      headers: { "user-agent": "OmniAgent/1.0" },
    });

    expect(response.status).toBe(200);

    expect(state.issued).toHaveLength(1);
    const [request] = state.issued;
    expect(request.options.hostname).toBe("example.com");
    expect(request.options.port).toBe(443);
    expect(request.options.agent).toBe(false);
    expect(request.options.headers).toEqual({ "user-agent": "OmniAgent/1.0" });

    dnsLookup.mockImplementation(async () => [
      { address: "169.254.169.254", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);

    expect(await runLookup(request.options.lookup, { hints: 0, all: true })).toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
    expect(await runLookup(request.options.lookup, { family: 4 })).toBe(
      "93.184.216.34",
    );
  });

  it.each([
    ["93.184.216.34", 4],
    ["2606:2800:220:1:248:1893:25c8:1946", 6],
  ])("pins a %s answer", async (address, family) => {
    dnsLookup.mockImplementation(async () => [{ address, family }]);

    await pinnedFetch("https://example.com/page");

    const [request] = state.issued;
    expect(await runLookup(request.options.lookup, { hints: 0, all: true })).toEqual([
      { address, family },
    ]);
  });

  it("refuses a public name that resolves to a private address before any socket", async () => {
    dnsLookup.mockImplementation(async () => [
      { address: "169.254.169.254", family: 4 },
    ]);

    await expect(pinnedFetch("https://metadata.example/")).rejects.toThrow(
      /private or loopback/,
    );

    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to nothing", async () => {
    dnsLookup.mockImplementation(async () => []);

    await expect(pinnedFetch("https://empty.example/")).rejects.toThrow(
      /private or loopback/,
    );

    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("refuses a name resolution that fails", async () => {
    dnsLookup.mockImplementation(async () => {
      throw new Error("ENOTFOUND");
    });

    await expect(pinnedFetch("https://gone.example/")).rejects.toThrow(
      /unable to resolve public host/,
    );

    expect(requestSpy).not.toHaveBeenCalled();
  });

  it.each(["http", "https"])("accepts the default port for %s", async (scheme) => {
    await pinnedFetch(`${scheme}://example.com/page`);

    const [request] = state.issued;
    expect(request.options.protocol).toBe(`${scheme}:`);
    expect(request.options.port).toBe(scheme === "https" ? 443 : 80);
    expect(request.options.path).toBe("/page");
  });

  it("keeps an explicit public IP literal pinned", async () => {
    await pinnedFetch("http://93.184.216.34:80/page");

    const [request] = state.issued;
    expect(dnsLookup).not.toHaveBeenCalled();
    expect(await runLookup(request.options.lookup, { hints: 0, all: true })).toEqual([
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  it.each([
    "localhost",
    "db.internal",
    "printer.local",
    "169.254.169.254",
    "127.0.0.1",
    "[::1]",
    "2130706433",
  ])("refuses the target %s", async (host) => {
    await expect(pinnedFetch(`https://${host}/`)).rejects.toThrow(
      /private or loopback/,
    );

    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("refuses a non-http scheme", async () => {
    await expect(pinnedFetch("file:///etc/passwd")).rejects.toThrow(/only http/);
    await expect(pinnedFetch("ftp://example.com")).rejects.toThrow(/only http/);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("refuses embedded credentials", async () => {
    await expect(
      pinnedFetch("https://admin:hunter2@example.com/"),
    ).rejects.toThrow(/credentials/);

    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("refuses an off-port target", async () => {
    await expect(pinnedFetch("https://example.com:8443/admin")).rejects.toThrow(
      /only ports 80 and 443/,
    );

    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("reports a blocked hostname before resolving it", async () => {
    await expect(pinnedFetch("https://cache.internal/")).rejects.toThrow(
      /private or loopback/,
    );

    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it("returns a non-2xx reply as a Response with the upstream headers", async () => {
    state.upstream = {
      status: 503,
      statusText: "Service Unavailable",
      headers: {
        "content-type": "text/plain",
        "set-cookie": ["a=1", "b=2"],
      },
      body: "temporarily unavailable",
    };

    const response = await pinnedFetch("https://example.com/down");

    expect(response.status).toBe(503);
    expect(response.statusText).toBe("Service Unavailable");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("set-cookie")).toBe("a=1, b=2");
    await expect(response.text()).resolves.toBe("temporarily unavailable");
  });

  it("does not follow a redirect reply", async () => {
    state.upstream = { status: 302, headers: { location: "http://127.0.0.1/" } };

    const response = await pinnedFetch("https://example.com/moved");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://127.0.0.1/");
    expect(state.issued).toHaveLength(1);
  });

  it("also times out a response body that hangs after headers", async () => {
    state.upstream = { body: "headers arrived", bodyHangs: true };

    const response = await pinnedFetch("https://example.com/body-slow", {
      timeoutMs: 5,
    });

    await expect(response.text()).rejects.toThrow();
  });

  it("rejects when the request never answers within the timeout", async () => {
    state.upstream = { hangs: true };

    await expect(
      pinnedFetch("https://example.com/slow", { timeoutMs: 5 }),
    ).rejects.toThrow(/timed out after 5ms/);
  });

  it("rejects when the caller aborts", async () => {
    state.upstream = { hangs: true };
    const controller = new AbortController();
    const pending = pinnedFetch("https://example.com/slow", {
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("rejects a caller signal that is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      pinnedFetch("https://example.com/page", { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);

    expect(requestSpy).not.toHaveBeenCalled();
  });
});

describe("isPrivateIp", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fd00::1",
    "ff02::1",
    /*
     * The same loopback and metadata targets wearing an IPv6 address. A URL
     * writes the first of these as the second, so both spellings have to be
     * refused.
     */
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::127.0.0.1",
    /*
     * Link-local is fe80::/10, not the fe80 hextet alone: the prefix spans
     * fe80-febf, so a check written against the literal "fe80:" lets a
     * metadata-shaped target through wearing any of the other 75% of the range.
     */
    "fe80::1",
    "fe9f::1",
    "feb0::1",
    "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    /*
     * NAT64 forwards the embedded IPv4 literally, so 64:ff9b::/96 carrying
     * loopback or the link-local metadata address is those addresses.
     */
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::127.0.0.1",
    /*
     * 6to4 wraps the IPv4 in the second and third hextets, not the last 32
     * bits, so the NAT64 reading above does not see it: `2002:7f00:1::` is
     * loopback wearing a public-looking prefix. Teredo stores the one's
     * complement of the peer's address in the same place, for the same reason.
     */
    "2002:7f00:1::",
    "2002:7f00:0001::",
    "2002:a9fe:a9fe::1",
    "2002:0a00:0001::",
    "2001:0000:0000:80ff:fffe::",
    /*
     * Site-local is obsolete rather than routed, which is why it can be refused
     * without losing a real target; it sits directly above the link-local range
     * the test above covers, and the earlier version of this file called it
     * public on the strength of that neighbour.
     */
    "fec0::1",
    "fec0:0:0:1::",
    "feff::",
    /*
     * Reserved documentation and anycast ranges: no real server is numbered
     * from them, so naming one is either a mistake or a tunnel endpoint.
     */
    "192.0.2.1",
    "198.51.100.1",
    "203.0.113.1",
    "192.88.99.1",
    "2001:db8::1",
    "2001:0db8:1:2::",
  ])("flags %s", (address) => {
    expect(isPrivateIp(address)).toBe(true);
  });

  it.each([
    "93.184.216.34",
    "2606:2800:220:1:248:1893:25c8:1946",
    "::ffff:93.184.216.34",
    "::ffff:5d98:d822",
    // The 6to4 and NAT64 forms of a public target, and a range outside site-local.
    "64:ff9b::5d98:d822",
    "2002:5d98:d822::1",
    "2001:4860:4860::8888",
    "2001:df00::1",
  ])("allows %s", (address) => {
    expect(isPrivateIp(address)).toBe(false);
  });
});

describe("isBlockedHostname", () => {
  it.each(["localhost", "db.internal", "host.CORP", "0.0.0.0", "2130706433"])(
    "blocks %s",
    (host) => {
      expect(isBlockedHostname(host)).toBe(true);
    },
  );

  it("allows an ordinary public hostname", () => {
    expect(isBlockedHostname("example.com")).toBe(false);
  });
});
