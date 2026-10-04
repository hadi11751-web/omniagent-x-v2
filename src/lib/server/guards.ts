import { NextResponse } from "next/server";
import { acquireConcurrency, type ConcurrencyLease } from "@/lib/concurrency";
import {
  checkAndConsumeQuota,
  checkDailyCap,
  getPlan,
  refundDailyCap,
  refundQuota,
  type DailyCap,
  type Plan,
} from "@/lib/quota";
import type { ChatMessage } from "@/lib/types";

/**
 * Guards for the non-streaming routes that also cost money upstream (image
 * generation, transcription, memory extraction). `/api/chat` enforces the same
 * two limits inline around its stream; this exists so those cheaper entry
 * points cannot be used to skip them by being called directly.
 */

export interface HeldRun {
  lease: ConcurrencyLease;
  billedQuota: boolean;
  cap?: DailyCap;

  /**
   * The plan this request was charged under, resolved once for the whole run.
   * Every consume and refund below needs it, and each of them asking Clerk for it
   * again is what made one message cost several account lookups.
   */
  plan: Plan;
}

export type RunGuard = { run: HeldRun } | { rejection: Response };

const CAP_NOUNS: Record<DailyCap, string> = {
  memory: "memory saves",
  transcribe: "voice recordings",
};

export interface RunOptions {
  consumesQuota: boolean;

  /**
   * Ceiling for routes that cost money but bill no chat message. Without one,
   * `/api/memory` and `/api/transcribe` could be driven directly far past the
   * daily allowance the pricing page advertises, because neither of them
   * touches it.
   */
  dailyCap?: DailyCap;
}

export async function beginRun(
  userId: string,
  options: RunOptions,
): Promise<RunGuard> {
  const lease = await acquireConcurrency(userId);

  if (!lease.acquired) {
    return {
      rejection: NextResponse.json(
        {
          error:
            "Too many requests are already running for this account. Please wait for one to finish before starting another.",
          concurrencyLimit: lease.limit,
        },
        { status: 429 },
      ),
    };
  }

  /*
   * The lease is held from here on, so anything that throws has to hand it back
   * on the way out. The counters live in a second service the route has no
   * fallback for: a Upstash or Clerk call that fails used to leave the slot
   * counted as busy for a request that had already ended, and with no Redis
   * nothing expires, so three failures of that kind locked an account out of
   * every model route until the server restarted.
   */
  try {
    return await chargeForRun(userId, lease, options);
  } catch (error) {
    await lease.release().catch(() => undefined);

    throw error;
  }
}

async function chargeForRun(
  userId: string,
  lease: ConcurrencyLease,
  options: RunOptions,
): Promise<RunGuard> {
  const plan = await getPlan();

  if (options.dailyCap) {
    const cap = await checkDailyCap(userId, options.dailyCap, plan);

    if (!cap.allowed) {
      await lease.release();

      return {
        rejection: NextResponse.json(
          {
            error: `You've used today's ${cap.limit} ${CAP_NOUNS[options.dailyCap]}. Come back tomorrow.`,
          },
          { status: 429 },
        ),
      };
    }
  }

  if (!options.consumesQuota) {
    return { run: { lease, billedQuota: false, cap: options.dailyCap, plan } };
  }

  const quota = await checkAndConsumeQuota(userId, plan);

  if (quota.allowed) {
    return { run: { lease, billedQuota: true, cap: options.dailyCap, plan } };
  }

  if (options.dailyCap) {
    await refundDailyCap(userId, options.dailyCap, plan);
  }

  await lease.release();

  return {
    rejection: NextResponse.json(
      {
        error: `You've used today's ${quota.limit} free messages. Upgrade for unlimited access, or come back tomorrow.`,
        upgradeRequired: true,
      },
      { status: 429 },
    ),
  };
}

/** Release the slot, and hand back anything charged for if nothing usable came of it. */
export async function endRun(
  userId: string,
  run: HeldRun,
  usableOutput: boolean,
): Promise<void> {
  await run.lease.release();

  if (usableOutput) return;

  if (run.billedQuota) {
    await refundQuota(userId, run.plan);
  }

  if (run.cap) {
    await refundDailyCap(userId, run.cap, run.plan);
  }
}

/**
 * Rejects on the `content-length` header so an oversized body never reaches
 * `request.json()`, which would parse the whole thing into memory first.
 */
export function oversizedBody(request: Request, maxBytes: number): Response | undefined {
  const contentLength = Number(request.headers.get("content-length") ?? "0");

  if (!Number.isFinite(contentLength) || contentLength <= maxBytes) {
    return undefined;
  }

  return NextResponse.json({ error: "request body is too large" }, { status: 413 });
}

export type CappedBody = { bytes: ArrayBuffer } | { tooLarge: true };

/**
 * The same ceiling applied to the bytes that actually arrive.
 *
 * `content-length` is a claim the client makes, not a measurement: a request
 * sent with `Transfer-Encoding: chunked` carries no useful one, so the header
 * check above is only an early exit and never the limit itself. This reads the
 * stream and stops the moment it goes over, so a route cannot be made to buffer
 * more than its documented ceiling before it decides what to do with the body.
 */
export async function readCappedBody(
  request: Request,
  maxBytes: number,
): Promise<CappedBody> {
  const reader = request.body?.getReader();

  if (!reader) return { bytes: new Uint8Array(0).buffer };

  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      received += value.byteLength;

      if (received > maxBytes) {
        await reader.cancel();

        return { tooLarge: true };
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(received);

  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes: bytes.buffer };
}

/** The bytes above decoded as JSON, keeping a legal `null` apart from garbage. */
export type DecodedBody = { parsed: unknown } | { invalidJson: true };

export function decodeJsonBody(bytes: ArrayBuffer): DecodedBody {
  try {
    return { parsed: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { invalidJson: true };
  }
}

/**
 * `await request.json()` is `unknown` no matter what the route casts it to, and
 * a JSON `null` or a bare array used to reach `.messages` / `.trim()` and raise
 * a 500 for what is only a malformed request. This is the check that turns it
 * into a 400 instead.
 */
export function bodyAsRecord(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

/** A body field the route is about to call string methods on: absent unless it really is a string. */
export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The most recent `limit` turns, opened on a human one.
 *
 * `slice(-limit)` keeps whatever happens to sit at that boundary, and once a
 * conversation is longer than the window the boundary is an assistant message:
 * the transcript then starts with the model answering a question nobody asked.
 * Anthropic's Messages API refuses that outright, so every request from message
 * 61 onward failed for a conversation that had nothing wrong with it. A window
 * with no human turn left is refused here rather than sent - an empty result is
 * the route's existing 400, which beats a provider error the reader cannot act
 * on.
 */
export function trimHistory(
  messages: ChatMessage[],
  limit: number,
): ChatMessage[] {
  const window = messages.slice(-limit);
  const firstHuman = window.findIndex((message) => message.role === "user");

  return firstHuman < 0 ? [] : window.slice(firstHuman);
}
