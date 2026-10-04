import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";

const DEFAULT_TIMEOUT_MS = 20_000;

export interface PinnedFetchInit {
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const type = isIP(normalized);

  if (type === 4) {
    const octets = normalized.split(".").map(Number);
    const [a, b, c] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a >= 224) ||
      (a === 198 && (b === 18 || b === 19)) ||
      /*
       * The reserved documentation and anycast ranges. None of them routes to a
       * real server, so an address in one is either a typo or a way of naming a
       * tunnel endpoint; a filter that only knows the private ranges lets a
       * `2002:`-wrapped target reach the socket layer looking public.
       */
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 192 && b === 88 && c === 99)
    );
  }

  if (type === 6) {
    const value = normalized;
    if (value === "::" || value === "::1") return true;

    // fe80::/10 is the link-local range, so `fe80:` alone misses fe81-febf.
    if (/^fe[89ab]/i.test(value)) return true;
    if (value.startsWith("fc") || value.startsWith("fd")) return true;

    /*
     * fec0::/10 is the obsolete site-local range. Nothing public is numbered
     * from it, but it is still inside the first-blocked neighborhood, and the
     * link-local test above deliberately stops at febf.
     */
    if (isSiteLocal(value)) return true;

    // ff00::/12, the multicast ranges a link-local listener answers to.
    if (value.startsWith("ff")) return true;

    /*
     * `2001:db8::/32` is the IPv6 documentation range, the counterpart of the
     * TEST-NET v4 ranges above.
     */
    if (isDocumentationV6(value)) return true;

    const embedded = embeddedIpv4(value);

    if (embedded) return isPrivateIp(embedded);
  }

  return false;
}

/** The second hextet is matched numerically: `db8` and `0db8` are one hextet. */
function isDocumentationV6(value: string): boolean {
  const [head, second] = value.split(":");

  return (
    head?.toLowerCase() === "2001" &&
    Number.parseInt(second ?? "", 16) === 0x0db8
  );
}

/** The first hextet of a pure-hex IPv6 address, or `undefined` for `::`. */
function firstHextet(value: string): number | undefined {
  const text = value.split(":")[0];

  if (!text || !/^[0-9a-f]{1,4}$/i.test(text)) return undefined;

  return Number.parseInt(text, 16);
}

function isSiteLocal(value: string): boolean {
  const head = firstHextet(value);

  return head !== undefined && head >= 0xfec0 && head <= 0xfeff;
}

/**
 * An IPv6 address that names an IPv4 target from inside itself. `::ffff:` and
 * the NAT64 well-known prefix both do, and a WHATWG URL rewrites
 * `::ffff:127.0.0.1` into the `::ffff:7f00:1` form, so both spellings have to
 * reach the same verdict as the dotted address they carry. Matching on text
 * alone is not enough either: the same low-order 32 bits arrive written with
 * one, two or four leading colons depending on who formatted the address.
 *
 * 6to4 and Teredo are the other two spellings. Neither puts the IPv4 in the low
 * 32 bits: 6to4 carries it in the second and third groups, and Teredo carries
 * the one's complement of it there, so both have to be read out of their own
 * groups rather than trusted to the tail of the address.
 */
function embeddedIpv4(value: string): string | undefined {
  const dotted = value.match(/(?:^|:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);

  if (dotted) return dotted[1];

  const groups = expandIpv6(value);

  if (!groups) return undefined;

  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const nat64 =
    groups[0] === 0x0064 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0);

  if (mapped || nat64) return fromGroups(groups[6], groups[7]);

  if (groups[0] === 0x2002) return fromGroups(groups[1], groups[2]);

  if (groups[0] === 0x2001 && groups[1] === 0x0000) {
    return [
      ~(groups[3] >> 8) & 255,
      ~(groups[3] & 255) & 255,
      ~(groups[4] >> 8) & 255,
      ~(groups[4] & 255) & 255,
    ].join(".");
  }

  return undefined;
}

function fromGroups(high: number, low: number): string {
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** The eight 16-bit groups of a pure-hex IPv6 address, `::` expanded. */
function expandIpv6(value: string): number[] | undefined {
  if (!/^[0-9a-f:]+$/i.test(value)) return undefined;

  const halves = value.split("::");

  if (halves.length > 2) return undefined;

  const sides: number[][] = [];

  for (const half of halves) {
    if (half === "") {
      sides.push([]);
      continue;
    }

    const groups: number[] = [];

    for (const group of half.split(":")) {
      if (!group || group.length > 4) return undefined;
      groups.push(Number.parseInt(group, 16));
    }

    sides.push(groups);
  }

  if (halves.length === 1) return sides[0].length === 8 ? sides[0] : undefined;

  const missing = 8 - sides[0].length - sides[1].length;

  if (missing < 1) return undefined;

  return [...sides[0], ...Array.from({ length: missing }, () => 0), ...sides[1]];
}

export function isBlockedHostname(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, "");

  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".local") ||
    lower.endsWith(".localdomain") ||
    lower.endsWith(".corp") ||
    lower.endsWith(".home.arpa") ||
    lower === "0.0.0.0" ||
    lower === "0" ||
    /^\d+$/.test(lower)
  );
}

function assertSafeTarget(url: URL): void {
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

  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("only ports 80 and 443 are allowed");
  }
}

async function resolvePublicAddresses(hostname: string): Promise<LookupAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host)) {
    throw new Error("refusing to fetch a private or loopback address");
  }

  const literal = isIP(host);
  if (literal) {
    if (isPrivateIp(host)) {
      throw new Error("refusing to fetch a private or loopback address");
    }
    return [{ address: host, family: literal }];
  }

  let records: LookupAddress[];
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`unable to resolve public host ${host}`);
  }

  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw new Error("refusing to fetch a private or loopback address");
  }

  return records;
}

function pinAddresses(records: readonly LookupAddress[]): LookupFunction {
  const pinned = records.map((record) => ({
    address: record.address,
    family: record.family,
  }));

  return (hostname, options, callback) => {
    const wanted = options.family;
    const filtered =
      wanted === 4 || wanted === 6
        ? pinned.filter((record) => record.family === wanted)
        : pinned;
    const candidates = filtered.length ? filtered : pinned;

    if (options.all === true) {
      callback(null, candidates.slice());
      return;
    }

    const [first] = candidates;
    callback(null, first.address, first.family);
  };
}

function toHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
      continue;
    }

    headers.set(name, String(value));
  }

  return headers;
}

function toResponse(message: IncomingMessage): Response {
  const status = message.statusCode;
  const statusText = message.statusMessage;
  const headers = toHeaders(message);

  // The Response constructor rejects a body on the statuses that never carry one.
  if (status === 204 || status === 205 || status === 304) {
    return new Response(null, { status, statusText, headers });
  }

  return new Response(Readable.toWeb(message) as BodyInit, {
    status,
    statusText,
    headers,
  });
}

function openRequest(
  request: (options: RequestOptions) => ClientRequest,
  options: RequestOptions,
  url: URL,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  if (signal?.aborted) {
    return Promise.reject(new Error(`fetch of ${url.href} aborted`));
  }

  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    if (signal) {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const finish = (outcome: () => void): void => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onCallerAbort);
      outcome();
    };

    const req = request({ ...options, signal: controller.signal });

    req.once("response", (message) => {
      /*
       * Keep the timeout alive until the response body closes. `pinnedFetch`
       * returns the Response before callers consume that body, so clearing the
       * timer at headers would let a server send headers and then hold the
       * socket forever. The same controller already handles caller aborts;
       * keeping the timer attached makes the timeout cover headers *and* body.
       */
      message.once("close", () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onCallerAbort);
      });

      resolve(message);
    });

    req.once("error", (error) => {
      if (controller.signal.aborted) {
        finish(() =>
          reject(
            signal?.aborted
              ? new Error(`fetch of ${url.href} aborted`)
              : new Error(`fetch of ${url.href} timed out after ${timeoutMs}ms`),
          ),
        );
        return;
      }

      finish(() => reject(error));
    });

    req.end();
  });
}

/**
 * Fetches one http(s) target over the address it was validated against.
 *
 * Handing the resolved records to the socket layer as the request's own
 * `lookup` is what closes the rebinding window a separate check leaves open,
 * where a short-TTL name answers public on the check and private on the
 * connection. The hostname stays the real one, so the `Host` header, SNI and
 * certificate verification still describe the target, and `agent: false` keeps
 * a pooled socket from an earlier, unchecked resolution out of the path.
 * Redirects are not followed; the caller re-validates every hop.
 */
export async function pinnedFetch(
  raw: string | URL,
  init: PinnedFetchInit = {},
): Promise<Response> {
  const url = typeof raw === "string" ? new URL(raw) : raw;
  assertSafeTarget(url);

  const addresses = await resolvePublicAddresses(url.hostname);
  const isTls = url.protocol === "https:";
  const defaultPort = isTls ? 443 : 80;

  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : defaultPort,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: init.headers,
    agent: false,
    lookup: pinAddresses(addresses),
  };

  const message = await openRequest(
    isTls ? httpsRequest : httpRequest,
    options,
    url,
    init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    init.signal,
  );

  return toResponse(message);
}
