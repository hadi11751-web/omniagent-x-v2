import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, generateImage, available, acquire, getPlan, checkQuota, refund } =
  vi.hoisted(() => ({
    auth: vi.fn(),
    generateImage: vi.fn(),
    available: vi.fn(() => true),
    acquire: vi.fn(),
    getPlan: vi.fn(async () => "free" as const),
    checkQuota: vi.fn(),
    refund: vi.fn(),
  }));

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/lib/tools/generateImage", () => ({
  generateImage,
  imageGenerationAvailable: available,
}));
vi.mock("@/lib/concurrency", () => ({ acquireConcurrency: acquire }));
vi.mock("@/lib/quota", () => ({
  getPlan,
  checkAndConsumeQuota: checkQuota,
  refundQuota: refund,
}));

import { POST } from "@/app/api/image/route";

function request(body: unknown, contentLength?: string) {
  const headers = new Headers({ "content-type": "application/json" });

  if (contentLength !== undefined) {
    headers.set("content-length", contentLength);
  }

  return new Request("https://app.test/api/image", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function holdsSlot() {
  const release = vi.fn(async () => {});

  acquire.mockResolvedValue({ acquired: true, limit: 3, release });

  return release;
}

describe("POST /api/image", () => {
  beforeEach(() => {
    auth.mockReset().mockResolvedValue({ userId: "user-1" });
    generateImage.mockReset();
    available.mockReset().mockReturnValue(true);
    acquire.mockReset();
    checkQuota.mockReset();
    refund.mockReset();
  });

  it("refuses an anonymous caller before doing any work", async () => {
    auth.mockResolvedValue({ userId: null });

    const response = await POST(request({ prompt: "a cat" }));

    expect(response.status).toBe(401);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("refuses an oversized body without parsing or billing it", async () => {
    const response = await POST(
      request({ prompt: "a cat" }, String(16 * 1024 * 1024)),
    );

    expect(response.status).toBe(413);
    expect(acquire).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  /*
   * `null` is valid JSON and not a body this route can read. It used to answer
   * 400 only because the property access fell inside the parse `catch`, which
   * described it as broken JSON; now the object check is its own branch.
   */
  it("refuses a JSON null instead of reading a prompt out of it", async () => {
    const response = await POST(request(null));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "request body must be a JSON object",
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("refuses a prompt that is not text", async () => {
    const response = await POST(request({ prompt: 42 }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "prompt is required",
    });
    expect(generateImage).not.toHaveBeenCalled();
  });

  /*
   * The size limit has to hold for the bytes, not for the `content-length` the
   * client claims: a streamed body carries no usable header at all.
   */
  it("refuses a chunked body over the ceiling", async () => {
    const encoder = new TextEncoder();
    const chunk = "y".repeat(1024);
    let sent = 0;

    const streamed = new Request("https://app.test/api/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        pull(controller) {
          if (sent++ < 40) controller.enqueue(encoder.encode(chunk));
          else controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);

    expect(streamed.headers.get("content-length")).toBeNull();

    const response = await POST(streamed);

    expect(response.status).toBe(413);
    expect(acquire).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("refuses when every concurrent slot is busy", async () => {
    acquire.mockResolvedValue({
      acquired: false,
      limit: 3,
      release: async () => {},
    });

    const response = await POST(request({ prompt: "a cat" }));

    expect(response.status).toBe(429);
    expect(checkQuota).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("refuses and frees the slot once the daily allowance is gone", async () => {
    const release = holdsSlot();
    checkQuota.mockResolvedValue({ allowed: false, remaining: 0, limit: 20 });

    const response = await POST(request({ prompt: "a cat" }));

    expect(response.status).toBe(429);
    expect(release).toHaveBeenCalledTimes(1);
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("charges a message, returns the image and frees the slot", async () => {
    const release = holdsSlot();
    checkQuota.mockResolvedValue({ allowed: true, remaining: 19, limit: 20 });
    generateImage.mockResolvedValue("data:image/png;base64,AAA");

    const response = await POST(request({ prompt: "a cat" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ image: "data:image/png;base64,AAA" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();
  });

  it("gives the message back when the provider fails", async () => {
    const release = holdsSlot();
    checkQuota.mockResolvedValue({ allowed: true, remaining: 19, limit: 20 });
    generateImage.mockRejectedValue(new Error("provider exploded"));

    const response = await POST(request({ prompt: "a cat" }));

    expect(response.status).toBe(502);
    expect(refund).toHaveBeenCalledWith("user-1", "free");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
