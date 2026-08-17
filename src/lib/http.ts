export class UpstreamError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${provider} request failed (${status}): ${detail}`);
    this.name = "UpstreamError";
  }
}

/**
 * Some providers (Groq with gpt-oss models) abort a stream with an error object
 * inside the event stream instead of an HTTP error. `failedGeneration` holds the
 * generation the provider refused, which may contain a native tool call.
 */
export class StreamAbortedError extends Error {
  constructor(
    readonly provider: string,
    readonly detail: string,
    readonly code?: string,
    readonly failedGeneration?: string,
  ) {
    super(`${provider} stopped the stream: ${detail}`);
    this.name = "StreamAbortedError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function requestJson(
  label: string,
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    if (!response.ok) {
      const raw = (await response.text().catch(() => "")).slice(0, 2000);
      throw new UpstreamError(label, response.status, readableDetail(raw) || response.statusText);
    }
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/** Parses an OpenAI-style `text/event-stream` body into text deltas. */
export async function* parseSseDeltas(
  response: Response,
  pick: (payload: unknown) => string | undefined,
  label = "provider",
): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      const failure = streamError(payload);
      if (failure) {
        throw new StreamAbortedError(label, failure.message, failure.code, failure.failedGeneration);
      }
      const delta = pick(payload);
      if (delta) yield delta;
    }
  }
}

/** Turns a provider error body into a single readable sentence. */
function readableDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    const error = parsed.error;
    const message =
      typeof error === "string" ? error : error?.message ?? parsed.message ?? undefined;
    if (message) return message.slice(0, 300);
  } catch {
    // not JSON, fall through
  }
  return raw.slice(0, 300);
}

function streamError(payload: unknown) {
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const detail = error as { message?: string; code?: string; failed_generation?: string };
  return {
    message: detail.message ?? "unknown provider error",
    code: detail.code,
    failedGeneration: detail.failed_generation,
  };
}
