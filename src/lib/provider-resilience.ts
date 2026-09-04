import { StreamAbortedError, UpstreamError } from "@/lib/http";
import type {
  ChatProvider,
  ChatRequest,
  ModelInfo,
  ProviderId,
} from "@/lib/types";

export interface RetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface FailoverCandidate {
  model: ModelInfo;
  provider: ChatProvider;
}

export interface ProviderHealth {
  failures: number;
  cooldownUntil: number;
}

const DEFAULT_POLICY: Required<RetryPolicy> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
};

const RETRYABLE_STATUS = new Set([
  408,
  409,
  425,
  429,
  500,
  502,
  503,
  504,
  529,
]);

const PROVIDER_FAILURE_THRESHOLD = 3;
const PROVIDER_COOLDOWN_BASE_MS = 10_000;
const PROVIDER_COOLDOWN_MAX_MS = 60_000;

const providerHealth = new Map<ProviderId, ProviderHealth>();

export function isRetryableError(error: unknown): boolean {
  if (error instanceof UpstreamError) {
    return RETRYABLE_STATUS.has(error.status);
  }

  if (error instanceof StreamAbortedError) {
    return true;
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") return true;

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

export function getProviderHealth(
  providerId: ProviderId,
): ProviderHealth {
  const health = providerHealth.get(providerId);

  if (!health) {
    return {
      failures: 0,
      cooldownUntil: 0,
    };
  }

  if (
    health.cooldownUntil > 0 &&
    health.cooldownUntil <= Date.now()
  ) {
    providerHealth.delete(providerId);

    return {
      failures: 0,
      cooldownUntil: 0,
    };
  }

  return { ...health };
}

export function isProviderHealthy(
  providerId: ProviderId,
): boolean {
  return getProviderHealth(providerId).cooldownUntil <= Date.now();
}

export function recordProviderSuccess(
  providerId: ProviderId,
): void {
  providerHealth.delete(providerId);
}

export function recordProviderFailure(
  providerId: ProviderId,
  error: unknown,
): void {
  if (!isRetryableError(error)) return;

  const current = getProviderHealth(providerId);
  const failures = current.failures + 1;

  if (failures < PROVIDER_FAILURE_THRESHOLD) {
    providerHealth.set(providerId, {
      failures,
      cooldownUntil: 0,
    });
    return;
  }

  const exponent = failures - PROVIDER_FAILURE_THRESHOLD;
  const cooldownMs = Math.min(
    PROVIDER_COOLDOWN_MAX_MS,
    PROVIDER_COOLDOWN_BASE_MS * 2 ** exponent,
  );

  providerHealth.set(providerId, {
    failures,
    cooldownUntil: Date.now() + cooldownMs,
  });
}

export function resetProviderHealth(): void {
  providerHealth.clear();
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
    Math.random() * Math.max(1, exponential * 0.25),
  );

  return Math.min(maxDelayMs, exponential + jitter);
}

export async function* streamWithRetry(
  provider: ChatProvider,
  request: ChatRequest,
  policy: RetryPolicy = {},
): AsyncGenerator<string> {
  const config = { ...DEFAULT_POLICY, ...policy };

  let attempt = 0;

  while (attempt < config.maxAttempts) {
    attempt += 1;
    let emitted = false;

    try {
      for await (const chunk of provider.stream(request)) {
        emitted = true;
        yield chunk;
      }

      recordProviderSuccess(provider.id);
      return;
    } catch (error) {
      recordProviderFailure(provider.id, error);

      if (
        request.signal?.aborted ||
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

export function rankFailoverCandidates(
  primary: FailoverCandidate,
  models: ModelInfo[],
  providers: Record<string, ChatProvider>,
  capability?: string,
  requiresVision = false,
  allowLocalFallback = false,
): FailoverCandidate[] {
  const candidates = models
    .filter((model) => {
      if (model.id === primary.model.id) return false;

      const candidateProvider = providers[model.provider];

      if (!candidateProvider?.isConfigured()) {
        return false;
      }

      if (!isProviderHealthy(candidateProvider.id)) {
        return false;
      }

      if (requiresVision && !model.vision) {
        return false;
      }

      if (capability === "private") {
        return model.execution === "local";
      }

      if (model.provider === primary.provider.id) {
        return false;
      }

      if (
        capability &&
        !model.capabilities.includes(
          capability as ModelInfo["capabilities"][number],
        )
      ) {
        return false;
      }

      if (!allowLocalFallback && model.execution === "local") {
        return false;
      }

      return true;
    })
    .map((model) => ({
      model,
      provider: providers[model.provider],
    }))
    .filter(
      (candidate): candidate is FailoverCandidate =>
        Boolean(candidate.provider),
    );

  return candidates.sort((a, b) => {
    const aCapability = capability
      ? a.model.capabilities.includes(
          capability as ModelInfo["capabilities"][number],
        )
        ? 0
        : 1
      : 0;

    const bCapability = capability
      ? b.model.capabilities.includes(
          capability as ModelInfo["capabilities"][number],
        )
        ? 0
        : 1
      : 0;

    return aCapability - bCapability;
  });
}

export async function* streamWithFailover(
  primary: FailoverCandidate,
  request: ChatRequest,
  alternatives: FailoverCandidate[],
  policy: RetryPolicy = {},
): AsyncGenerator<{
  text: string;
  model: ModelInfo;
  provider: ChatProvider;
}> {
  const candidates = [
    ...(isProviderHealthy(primary.provider.id)
      ? [primary]
      : []),
    ...alternatives.filter((candidate) =>
      isProviderHealthy(candidate.provider.id),
    ),
  ];

  let lastError: unknown;

  for (const candidate of candidates) {
    const candidateRequest: ChatRequest = {
      ...request,
      model: candidate.model.id,
    };

    let emitted = false;

    try {
      for await (
        const text of streamWithRetry(
          candidate.provider,
          candidateRequest,
          policy,
        )
      ) {
        emitted = true;

        yield {
          text,
          model: candidate.model,
          provider: candidate.provider,
        };
      }

      return;
    } catch (error) {
      lastError = error;

      if (request.signal?.aborted || emitted) {
        throw error;
      }

      if (!isRetryableError(error)) {
        throw error;
      }
    }
  }

  throw (
    lastError ??
    new Error(
      "All configured AI providers are currently unavailable",
    )
  );
}
