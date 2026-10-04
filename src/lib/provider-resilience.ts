import { EmptyProviderResponseError, StreamAbortedError, UpstreamError } from "@/lib/http";
import type { ChatProvider, ChatRequest } from "@/lib/types";

/*
 * Resilience for the one backend Nexus talks to. A transient failure (a 429, a
 * 5xx, a dropped socket) is retried with backoff against the SAME backend, and
 * only before any text has reached the reader. There is no second provider to
 * fail over to: Nexus is the only model, so when retries are exhausted the
 * turn ends with an honest error rather than a silent switch to another model.
 */

export interface RetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_POLICY: Required<RetryPolicy> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
};

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export function isRetryableError(error: unknown): boolean {
  if (error instanceof UpstreamError) {
    return RETRYABLE_STATUS.has(error.status);
  }

  if (error instanceof StreamAbortedError || error instanceof EmptyProviderResponseError) {
    return true;
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return true;
    }

    const message = error.message.toLowerCase();

    return (
      message.includes("fetch failed") ||
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("socket") ||
      message.includes("econnreset") ||
      message.includes("econnrefused") ||
      message.includes("etimedout")
    );
  }

  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponential = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );

  const jitter = Math.floor(
    Math.random() *
      Math.max(1, exponential * 0.25),
  );

  return Math.min(
    maxDelayMs,
    exponential + jitter,
  );
}

export async function* streamWithRetry(
  provider: ChatProvider,
  request: ChatRequest,
  policy: RetryPolicy = {},
): AsyncGenerator<string> {
  const config = {
    ...DEFAULT_POLICY,
    ...policy,
  };

  let attempt = 0;

  while (attempt < config.maxAttempts) {
    attempt += 1;

    let emitted = false;

    try {
      for await (
        const chunk of provider.stream(request)
      ) {
        emitted = true;
        yield chunk;
      }

      if (!emitted) {
        throw new EmptyProviderResponseError(provider.label);
      }

      return;
    } catch (error) {
      /*
       * A cancelled turn arrives as an AbortError, which is indistinguishable
       * from a dropped connection by shape alone, so the caller's own signal
       * decides: pressing Stop is never retried.
       */
      const cancelled = Boolean(request.signal?.aborted);

      if (
        cancelled ||
        emitted ||
        !isRetryableError(error) ||
        attempt >= config.maxAttempts
      ) {
        throw error;
      }

      await delay(
        backoffDelay(
          attempt,
          config.baseDelayMs,
          config.maxDelayMs,
        ),
      );
    }
  }
}

