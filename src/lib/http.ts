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
 * Some providers can abort a stream with an error object inside the event
 * stream instead of returning an HTTP error.
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
  init: RequestInit & {
    timeoutMs?: number;
    allowNonOk?: boolean;
  } = {},
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    allowNonOk = false,
    ...rest
  } = init;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener(
        "abort",
        () => controller.abort(),
        { once: true },
      );
    }
  }

  try {
    const response = await fetch(url, {
      ...rest,
      signal: controller.signal,
    });

    if (!response.ok && !allowNonOk) {
      const raw = (await response.text().catch(() => "")).slice(
        0,
        2000,
      );

      throw new UpstreamError(
        label,
        response.status,
        readableDetail(raw) || response.statusText,
      );
    }

    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses an OpenAI-style `text/event-stream` body into text deltas.
 *
 * Handles:
 * - normal newline-delimited SSE events
 * - CRLF line endings
 * - UTF-8 characters split across network chunks
 * - the final SSE event when the response closes without a trailing newline
 * - [DONE]
 * - provider-side stream errors
 * - malformed JSON frames
 */
export async function* parseSseDeltas(
  response: Response,
  pick: (payload: unknown) => string | undefined,
  label = "provider",
): AsyncGenerator<string> {
  const body = response.body;

  if (!body) {
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";

  const processLine = function* (
    line: string,
  ): Generator<string> {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) {
      return;
    }

    const data = trimmed.slice(5).trim();

    if (!data || data === "[DONE]") {
      return;
    }

    let payload: unknown;

    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    const failure = streamError(payload);

    if (failure) {
      throw new StreamAbortedError(
        label,
        failure.message,
        failure.code,
        failure.failedGeneration,
      );
    }

    const delta = pick(payload);

    if (delta) {
      yield delta;
    }
  };

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split(/\r?\n/);

    buffer = lines.pop() ?? "";

    for (const line of lines) {
      yield* processLine(line);
    }
  }

  /*
   * Flush any UTF-8 bytes still buffered inside TextDecoder.
   */
  buffer += decoder.decode();

  /*
   * Important:
   * Some upstream servers close immediately after the final `data:` payload
   * without appending a newline. The old implementation lost that payload.
   */
  if (buffer.trim()) {
    yield* processLine(buffer);
  }
}

/** Turns a provider error body into a single readable sentence. */
function readableDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };

    const error = parsed.error;

    const message =
      typeof error === "string"
        ? error
        : error?.message ?? parsed.message ?? undefined;

    if (message) {
      return message.slice(0, 300);
    }
  } catch {
    // Not JSON; fall through to raw text.
  }

  return raw.slice(0, 300);
}

function streamError(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const error = (payload as { error?: unknown }).error;

  if (!error || typeof error !== "object") {
    return undefined;
  }

  const detail = error as {
    message?: string;
    code?: string;
    failed_generation?: string;
  };

  return {
    message: detail.message ?? "unknown provider error",
    code: detail.code,
    failedGeneration: detail.failed_generation,
  };
}
