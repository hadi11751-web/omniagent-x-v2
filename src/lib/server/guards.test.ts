import { beforeEach, describe, expect, it, vi } from "vitest";

const { acquire, getPlan, checkQuota, refund, checkCap, refundCap } = vi.hoisted(() => ({
  acquire: vi.fn(),
  getPlan: vi.fn(),
  checkQuota: vi.fn(),
  refund: vi.fn(),
  checkCap: vi.fn(),
  refundCap: vi.fn(),
}));

vi.mock("@/lib/concurrency", () => ({ acquireConcurrency: acquire }));
vi.mock("@/lib/quota", () => ({
  getPlan,
  checkAndConsumeQuota: checkQuota,
  refundQuota: refund,
  checkDailyCap: checkCap,
  refundDailyCap: refundCap,
}));

import {
  beginRun,
  bodyAsRecord,
  decodeJsonBody,
  endRun,
  optionalText,
  oversizedBody,
  readCappedBody,
  trimHistory,
} from "@/lib/server/guards";
import type { ChatMessage } from "@/lib/types";

function turn(role: "user" | "assistant", content: string): ChatMessage {
  return { role, content };
}

/** A 1:1 transcript: the user opens it, and the turns strictly alternate. */
function dialogue(length: number): ChatMessage[] {
  return Array.from({ length }, (_, index) =>
    turn(index % 2 === 0 ? "user" : "assistant", `message ${index}`),
  );
}

function lease(acquired: boolean) {
  const release = vi.fn(async () => {});

  return { lease: { acquired, limit: 3, release }, release };
}

describe("beginRun", () => {
  beforeEach(() => {
    acquire.mockReset();
    getPlan.mockReset();
    getPlan.mockResolvedValue("free");
    checkQuota.mockReset();
    refund.mockReset();
    checkCap.mockReset();
    refundCap.mockReset();
  });

  it("holds a slot and charges quota when both allow the run", async () => {
    const held = lease(true);
    acquire.mockResolvedValue(held.lease);
    checkQuota.mockResolvedValue({ allowed: true, remaining: 19, limit: 20 });

    const guard = await beginRun("user-1", { consumesQuota: true });

    expect("run" in guard).toBe(true);
    expect(acquire).toHaveBeenCalledWith("user-1");
    expect(checkQuota).toHaveBeenCalledWith("user-1", "free");
    expect(held.release).not.toHaveBeenCalled();
  });

  it("refuses at the concurrency ceiling without touching quota", async () => {
    const held = lease(false);
    acquire.mockResolvedValue(held.lease);

    const guard = await beginRun("user-1", { consumesQuota: true });

    if (!("rejection" in guard)) throw new Error("expected a rejection");
    expect(guard.rejection.status).toBe(429);
    expect(await guard.rejection.json()).toMatchObject({ concurrencyLimit: 3 });
    expect(checkQuota).not.toHaveBeenCalled();
  });

  it("gives the slot back when quota denies the run", async () => {
    const held = lease(true);
    acquire.mockResolvedValue(held.lease);
    checkQuota.mockResolvedValue({ allowed: false, remaining: 0, limit: 20 });

    const guard = await beginRun("user-1", { consumesQuota: true });

    if (!("rejection" in guard)) throw new Error("expected a rejection");
    expect(guard.rejection.status).toBe(429);
    expect(await guard.rejection.json()).toMatchObject({ upgradeRequired: true });
    expect(held.release).toHaveBeenCalledTimes(1);
  });

  it("skips quota entirely for a run that only needs a slot", async () => {
    acquire.mockResolvedValue(lease(true).lease);

    const guard = await beginRun("user-1", { consumesQuota: false });

    expect("run" in guard).toBe(true);
    expect(checkQuota).not.toHaveBeenCalled();
  });

  it("counts a capped run against its own ceiling, not the message allowance", async () => {
    acquire.mockResolvedValue(lease(true).lease);
    checkCap.mockResolvedValue({ allowed: true, remaining: 59, limit: 60 });

    const guard = await beginRun("user-1", {
      consumesQuota: false,
      dailyCap: "memory",
    });

    expect("run" in guard).toBe(true);
    expect(checkCap).toHaveBeenCalledWith("user-1", "memory", "free");
    expect(checkQuota).not.toHaveBeenCalled();
  });

  it("refuses at the ceiling for that route and names it", async () => {
    const held = lease(true);
    acquire.mockResolvedValue(held.lease);
    checkCap.mockResolvedValue({ allowed: false, remaining: 0, limit: 40 });

    const guard = await beginRun("user-1", {
      consumesQuota: false,
      dailyCap: "transcribe",
    });

    if (!("rejection" in guard)) throw new Error("expected a rejection");
    expect(guard.rejection.status).toBe(429);
    expect(await guard.rejection.json()).toMatchObject({
      error: expect.stringContaining("voice recordings"),
    });
    expect(held.release).toHaveBeenCalledTimes(1);
    expect(checkQuota).not.toHaveBeenCalled();
  });

  it("checks concurrency first so a busy account is not charged a run", async () => {
    const held = lease(false);
    acquire.mockResolvedValue(held.lease);

    await beginRun("user-1", { consumesQuota: true, dailyCap: "memory" });

    expect(checkCap).not.toHaveBeenCalled();
    expect(checkQuota).not.toHaveBeenCalled();
  });

  it("gives a capped run's ceiling back when the message allowance denies it", async () => {
    const held = lease(true);
    acquire.mockResolvedValue(held.lease);
    checkCap.mockResolvedValue({ allowed: true, remaining: 0, limit: 60 });
    checkQuota.mockResolvedValue({ allowed: false, remaining: 0, limit: 20 });

    const guard = await beginRun("user-1", {
      consumesQuota: true,
      dailyCap: "memory",
    });

    expect("rejection" in guard).toBe(true);
    expect(refundCap).toHaveBeenCalledWith("user-1", "memory", "free");
    expect(held.release).toHaveBeenCalledTimes(1);
  });

  it("looks the plan up once and hands it to every charge of the run", async () => {
    acquire.mockResolvedValue(lease(true).lease);
    checkCap.mockResolvedValue({ allowed: true, remaining: 59, limit: 60 });
    checkQuota.mockResolvedValue({ allowed: true, remaining: 19, limit: 20 });

    const guard = await beginRun("user-1", {
      consumesQuota: true,
      dailyCap: "memory",
    });

    if (!("run" in guard)) throw new Error("expected an allowed run");
    expect(getPlan).toHaveBeenCalledTimes(1);
    expect(checkCap).toHaveBeenCalledWith("user-1", "memory", "free");
    expect(checkQuota).toHaveBeenCalledWith("user-1", "free");

    await endRun("user-1", guard.run, false);

    // The refund reuses that answer instead of asking Clerk a second time.
    expect(getPlan).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith("user-1", "free");
    expect(refundCap).toHaveBeenCalledWith("user-1", "memory", "free");
  });

  /*
   * A Clerk or Upstash call that fails mid-charge used to strand the slot: the
   * lease was already taken, the throw skipped past the route's own cleanup, and
   * nothing released it. Three of those and an account with no Redis was locked
   * out of every model route for the rest of the process's life.
   */
  it("gives the slot back when the message allowance call throws", async () => {
    const held = lease(true);
    acquire.mockResolvedValue(held.lease);
    checkQuota.mockRejectedValue(new Error("Upstash is unreachable"));

    await expect(beginRun("user-1", { consumesQuota: true })).rejects.toThrow(
      "Upstash is unreachable",
    );
    expect(held.release).toHaveBeenCalledTimes(1);
  });

  it("gives the slot back when that route's ceiling call throws", async () => {
    const held = lease(true);
    acquire.mockResolvedValue(held.lease);
    checkCap.mockRejectedValue(new Error("Upstash is unreachable"));

    await expect(
      beginRun("user-1", { consumesQuota: false, dailyCap: "memory" }),
    ).rejects.toThrow("Upstash is unreachable");
    expect(held.release).toHaveBeenCalledTimes(1);
  });

  it("gives the slot back when the plan lookup itself throws", async () => {
    const held = lease(true);
    acquire.mockResolvedValue(held.lease);
    getPlan.mockRejectedValue(new Error("Clerk is unreachable"));

    await expect(beginRun("user-1", { consumesQuota: true })).rejects.toThrow(
      "Clerk is unreachable",
    );
    expect(held.release).toHaveBeenCalledTimes(1);
  });
});

describe("endRun", () => {
  beforeEach(() => {
    refund.mockReset();
    refundCap.mockReset();
  });

  it("refunds a charged message that produced nothing usable", async () => {
    const release = vi.fn(async () => {});

    await endRun(
      "user-1",
      { lease: { acquired: true, limit: 3, release }, billedQuota: true, plan: "free" },
      false,
    );

    expect(release).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith("user-1", "free");
  });

  it("leaves the charge alone once output reached the user", async () => {
    const release = vi.fn(async () => {});

    await endRun(
      "user-1",
      { lease: { acquired: true, limit: 3, release }, billedQuota: true, plan: "free" },
      true,
    );

    expect(refund).not.toHaveBeenCalled();
  });

  it("never refunds a run that was not charged", async () => {
    const release = vi.fn(async () => {});

    await endRun(
      "user-1",
      { lease: { acquired: true, limit: 3, release }, billedQuota: false, plan: "free" },
      false,
    );

    expect(refund).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("hands a capped route's run back when nothing usable came of it", async () => {
    const release = vi.fn(async () => {});

    await endRun(
      "user-1",
      {
        lease: { acquired: true, limit: 3, release },
        billedQuota: false,
        cap: "memory",
        plan: "paid",
      },
      false,
    );

    expect(refundCap).toHaveBeenCalledWith("user-1", "memory", "paid");
    expect(refund).not.toHaveBeenCalled();
  });

  it("keeps a capped run that produced output", async () => {
    const release = vi.fn(async () => {});

    await endRun(
      "user-1",
      {
        lease: { acquired: true, limit: 3, release },
        billedQuota: false,
        cap: "transcribe",
        plan: "free",
      },
      true,
    );

    expect(refundCap).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("oversizedBody", () => {
  function request(contentLength?: string) {
    const headers = new Headers();

    if (contentLength !== undefined) {
      headers.set("content-length", contentLength);
    }

    return new Request("https://app.test/api/image", { method: "POST", headers });
  }

  it("rejects a body above the ceiling before it is parsed", () => {
    const response = oversizedBody(request("20000"), 16_000);

    expect(response?.status).toBe(413);
  });

  it("accepts a body at the ceiling", () => {
    expect(oversizedBody(request("16000"), 16_000)).toBeUndefined();
  });

  it("accepts a request that sent no content-length", () => {
    expect(oversizedBody(request(), 16_000)).toBeUndefined();
  });

  it("accepts a content-length that is not a number", () => {
    expect(oversizedBody(request("nonsense"), 16_000)).toBeUndefined();
  });
});

/*
 * Both helpers exist because `await request.json()` is `unknown` in practice:
 * `null`, a bare array and a number in a string slot are all valid JSON, and
 * each of them used to reach a `.trim()` or a `.role` and raise a 500.
 */
describe("bodyAsRecord", () => {
  it("keeps an object and refuses everything else", () => {
    expect(bodyAsRecord({ messages: [] })).toEqual({ messages: [] });
    expect(bodyAsRecord(null)).toBeUndefined();
    expect(bodyAsRecord([])).toBeUndefined();
    expect(bodyAsRecord("null")).toBeUndefined();
    expect(bodyAsRecord(7)).toBeUndefined();
  });
});

describe("optionalText", () => {
  it("passes a string through and drops anything else", () => {
    expect(optionalText("gpt-5")).toBe("gpt-5");
    expect(optionalText("")).toBe("");
    expect(optionalText(undefined)).toBeUndefined();
    expect(optionalText(null)).toBeUndefined();
    expect(optionalText(42)).toBeUndefined();
    expect(optionalText({ id: "gpt-5" })).toBeUndefined();
  });
});

function streamedRequest(chunks: string[], headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  let index = 0;

  return new Request("https://app.test/api/chat", {
    method: "POST",
    // A `ReadableStream` body is how a chunked upload arrives: undici sends no
    // `content-length` for it, which is exactly the case the header check misses.
    body: new ReadableStream({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]));
        else controller.close();
      },
    }),
    duplex: "half",
    headers,
  } as RequestInit);
}

describe("readCappedBody", () => {
  it("reassembles a body that fits", async () => {
    const incoming = await readCappedBody(streamedRequest(["ab", "cd"]), 10);

    expect("bytes" in incoming && new TextDecoder().decode(incoming.bytes)).toBe("abcd");
  });

  it("refuses a chunked body the header check could not see", async () => {
    const request = streamedRequest(["x".repeat(1000)]);

    expect(request.headers.get("content-length")).toBeNull();
    expect(oversizedBody(request, 10)).toBeUndefined();
    expect(await readCappedBody(request, 10)).toEqual({ tooLarge: true });
  });

  it("stops reading at the ceiling instead of buffering the whole upload", async () => {
    const encoder = new TextEncoder();
    let sent = 0;
    let stopped = false;

    const request = new Request("https://app.test/api/chat", {
      method: "POST",
      body: new ReadableStream({
        pull(controller) {
          sent += 1;
          controller.enqueue(encoder.encode("x".repeat(1024)));
        },
        cancel() {
          stopped = true;
        },
      }),
      duplex: "half",
    } as RequestInit);

    expect(await readCappedBody(request, 4096)).toEqual({ tooLarge: true });

    // 4096 bytes at 1 kB a chunk is five reads; an uncapped loop would be running
    // until this test timed out.
    expect(sent).toBeLessThanOrEqual(6);
    expect(stopped).toBe(true);
  });

  it("reads an empty body as empty", async () => {
    const incoming = await readCappedBody(
      new Request("https://app.test/api/chat", { method: "POST" }),
      100,
    );

    expect("bytes" in incoming && incoming.bytes.byteLength).toBe(0);
  });
});

describe("decodeJsonBody", () => {
  it("keeps a legal null apart from garbage", () => {
    const encode = (text: string) => new TextEncoder().encode(text).buffer;

    expect(decodeJsonBody(encode("null"))).toEqual({ parsed: null });
    expect(decodeJsonBody(encode('{"a":1}'))).toEqual({ parsed: { a: 1 } });
    expect(decodeJsonBody(encode("<html>"))).toEqual({ invalidJson: true });
    expect(decodeJsonBody(encode(""))).toEqual({ invalidJson: true });
  });
});

/*
 * Anthropic requires the first message of a request to be from the user, and
 * `slice(-60)` says nothing about which role lands at that boundary: in a chat
 * of 61 turns the boundary falls on the assistant. Every request from message
 * 61 onward used to fail on a conversation that had been working fine, so the
 * window has to be opened on a human turn - or not sent at all.
 */
describe("trimHistory", () => {
  it("opens the window on a human turn when the cut lands on an answer", () => {
    const window = trimHistory(dialogue(61), 60);

    expect(window[0]).toMatchObject({ role: "user", content: "message 2" });
    expect(window).toHaveLength(59);
  });

  it("keeps a window that already opens on the user", () => {
    expect(trimHistory(dialogue(60), 60)).toEqual(dialogue(60));
  });

  it("hands back nothing when the window holds no human turn at all", () => {
    expect(
      trimHistory(
        [
          turn("assistant", "one"),
          turn("assistant", "two"),
          turn("assistant", "three"),
        ],
        60,
      ),
    ).toEqual([]);
  });

  it("leaves a short conversation untouched", () => {
    expect(trimHistory(dialogue(3), 60)).toEqual(dialogue(3));
  });
});
