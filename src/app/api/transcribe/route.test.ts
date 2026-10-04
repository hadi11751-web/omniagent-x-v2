import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { auth, acquire, getPlan, checkQuota, checkCap, refundCap } = vi.hoisted(() => ({
  auth: vi.fn(),
  acquire: vi.fn(),
  getPlan: vi.fn(async () => "free" as const),
  checkQuota: vi.fn(),
  checkCap: vi.fn(),
  refundCap: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth }));
vi.mock("@/lib/concurrency", () => ({ acquireConcurrency: acquire }));
vi.mock("@/lib/quota", () => ({
  getPlan,
  checkAndConsumeQuota: checkQuota,
  refundQuota: vi.fn(),
  checkDailyCap: checkCap,
  refundDailyCap: refundCap,
}));

import { POST } from "@/app/api/transcribe/route";

function request(
  form: FormData | null,
  contentLength?: string,
  signal?: AbortSignal,
) {
  const headers = new Headers();

  if (contentLength !== undefined) {
    headers.set("content-length", contentLength);
  }

  // A FormData body gets its boundary from the Request itself; setting the
  // content-type here would not match the serialized body.
  return new Request("https://app.test/api/transcribe", {
    method: "POST",
    headers,
    body: form ?? "",
    signal,
  });
}

function audioForm(mime = "audio/webm", name = "voice.webm") {
  const form = new FormData();

  form.append(
    "audio",
    new File([new Uint8Array(2048)], name, { type: mime }),
  );

  return form;
}

describe("POST /api/transcribe", () => {
  beforeEach(() => {
    auth.mockReset().mockResolvedValue({ userId: "user-1" });
    acquire.mockReset();
    checkQuota.mockReset();
    checkCap.mockReset().mockResolvedValue({ allowed: true, remaining: 39, limit: 40 });
    refundCap.mockReset().mockResolvedValue(undefined);
    vi.stubEnv("GROQ_API_KEY", "gq-test");
    // Tests that expect an upstream response replace this; the rest fail here
    // rather than reaching the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("upstream unavailable");
      }),
    );
    acquire.mockResolvedValue({
      acquired: true,
      limit: 3,
      release: async () => {},
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses an anonymous caller", async () => {
    auth.mockResolvedValue({ userId: null });

    expect((await POST(request(audioForm()))).status).toBe(401);
  });

  it("accepts multipart framing overhead in the early size check", async () => {
    const response = await POST(
      request(audioForm(), String(24 * 1024 * 1024 + 32 * 1024)),
    );

    expect(response.status).toBe(502);
    expect(acquire).toHaveBeenCalled();
  });

  it("refuses an oversized upload before reading it", async () => {
    const response = await POST(
      request(audioForm(), String(64 * 1024 * 1024)),
    );

    expect(response.status).toBe(413);
    expect(acquire).not.toHaveBeenCalled();
  });

  /*
   * The header check above reads a claim the client makes. A chunked upload
   * makes none, so the ceiling has to be applied while the bytes arrive —
   * otherwise `formData()` buffered whatever a script chose to send.
   */
  it("refuses a chunked upload over the ceiling", async () => {
    const encoder = new TextEncoder();
    const chunk = "y".repeat(1024 * 1024);
    let sent = 0;

    const streamed = new Request("https://app.test/api/transcribe", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      body: new ReadableStream({
        pull(controller) {
          if (sent++ < 30) controller.enqueue(encoder.encode(chunk));
          else controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);

    expect(streamed.headers.get("content-length")).toBeNull();

    const response = await POST(streamed);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "recording too large" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses when every concurrent slot is busy", async () => {
    acquire.mockResolvedValue({
      acquired: false,
      limit: 3,
      release: async () => {},
    });

    const response = await POST(request(audioForm()));

    expect(response.status).toBe(429);
    expect(checkQuota).not.toHaveBeenCalled();
  });

  it("holds a slot but never charges the chat allowance", async () => {
    const fetchMock = vi.fn<
      (_url: string | URL, _init: RequestInit) => Promise<Response>
    >();
    fetchMock.mockImplementation(async () =>
      Response.json({ text: "  hello out loud  " }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(audioForm()));

    expect(await response.json()).toEqual({ text: "hello out loud" });
    expect(checkQuota).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reports a missing audio part as the client error it is", async () => {
    const response = await POST(request(null));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "no audio file received" });
  });

  it("refunds today's transcription ceiling when the upstream fails", async () => {
    const response = await POST(request(audioForm()));

    expect(response.status).toBe(502);
    expect(checkCap).toHaveBeenCalledWith("user-1", "transcribe", "free");
    expect(refundCap).toHaveBeenCalledWith("user-1", "transcribe", "free");
  });

  it("stops at today's transcription ceiling before calling anyone", async () => {
    checkCap.mockResolvedValue({ allowed: false, remaining: 0, limit: 40 });

    const response = await POST(request(audioForm()));

    expect(response.status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names the upload after the container the browser recorded", async () => {
    const fetchMock = vi.fn<
      (_url: string | URL, _init: RequestInit) => Promise<Response>
    >();
    fetchMock.mockImplementation(async () => Response.json({ text: "hello" }));
    vi.stubGlobal("fetch", fetchMock);

    // Safari's MediaRecorder produces mp4; naming it webm made Whisper guess.
    await POST(request(audioForm("audio/mp4", "recording.webm")));

    const body = fetchMock.mock.calls[0][1].body as FormData;

    expect((body.get("file") as File).name).toBe("voice-message.m4a");
  });

  it("falls back to the recorded name when the blob has no type", async () => {
    const fetchMock = vi.fn<
      (_url: string | URL, _init: RequestInit) => Promise<Response>
    >();
    fetchMock.mockImplementation(async () => Response.json({ text: "hello" }));
    vi.stubGlobal("fetch", fetchMock);

    await POST(request(audioForm("", "take.ogg")));

    const body = fetchMock.mock.calls[0][1].body as FormData;

    expect((body.get("file") as File).name).toBe("voice-message.ogg");
  });

  /*
   * The upstream call used to carry only its own timeout, so closing the tab
   * mid-upload left a minute-long Whisper request running and billed. The
   * visitor's cancellation now has to reach it.
   */
  it("forwards the visitor's cancellation to the upstream call", async () => {
    const controller = new AbortController();
    const captured: { signal: AbortSignal | null } = { signal: null };

    let started!: () => void;
    const startedUpstream = new Promise<void>((resolve) => {
      started = resolve;
    });

    const fetchMock = vi.fn<
      (_url: string | URL, _init: RequestInit) => Promise<Response>
    >();

    fetchMock.mockImplementation(
      (_url, init) => {
        captured.signal = (init?.signal as AbortSignal | null) ?? null;
        started();

        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    const pending = POST(request(audioForm(), undefined, controller.signal));

    await startedUpstream;
    controller.abort();

    const response = await pending;

    expect(captured.signal?.aborted).toBe(true);
    expect(response.status).toBe(502);
  });
});
