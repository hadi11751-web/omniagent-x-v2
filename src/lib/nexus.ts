import { UpstreamError } from "@/lib/http";
import { createOpenAiCompatibleProvider } from "@/lib/nexusTransport";
import type { ChatProvider, ChatRequest, Execution, ModelInfo } from "@/lib/types";

/**
 * Nexus is the one AI model OmniAgent has.
 *
 * It is a single reasoning engine behind a single, operator-configured
 * endpoint that speaks the OpenAI chat-completions protocol (OpenAI itself,
 * Groq, OpenRouter, Together, vLLM, LM Studio, Ollama's /v1, ...). Which engine
 * that is lives in three server environment variables and is never sent to the
 * browser, named in the UI, or chosen per request:
 *
 *   NEXUS_BASE_URL   endpoint root, e.g. https://api.openai.com/v1 (default)
 *   NEXUS_API_KEY    bearer token (not needed for a local endpoint)
 *   NEXUS_MODEL      the engine's model id (required; there is no safe default)
 *
 * Optional:
 *   NEXUS_VISION       "true" only when the configured engine can read images (default false)
 *   NEXUS_EXECUTION    "local" | "cloud"; defaults to local for loopback hosts
 *   NEXUS_NATIVE_TOOLS "true" to use the engine's function-calling instead of
 *                      the text tool protocol (default false: works everywhere)
 *
 * There is deliberately no second provider, no fallback model and no router.
 * Capabilities beyond reasoning are tools that Nexus calls.
 */
export const NEXUS_ID = "nexus" as const;
export const NEXUS_LABEL = "Nexus" as const;

export const DEFAULT_NEXUS_BASE_URL = "https://api.openai.com/v1";

export interface NexusConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  vision: boolean;
  execution: Execution;
  nativeTools: boolean;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  const normalised = value?.trim().toLowerCase();

  if (!normalised) return fallback;
  if (["1", "true", "yes", "on"].includes(normalised)) return true;
  if (["0", "false", "no", "off"].includes(normalised)) return false;

  return fallback;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * The configuration in force right now, or undefined when Nexus cannot answer.
 * Read from the environment on every call so a restart is the only thing a
 * change needs, and so tests can stub it.
 */
export function nexusConfig(): NexusConfig | undefined {
  const model = process.env.NEXUS_MODEL?.trim();

  if (!model) return undefined;

  const rawBase = process.env.NEXUS_BASE_URL?.trim() || DEFAULT_NEXUS_BASE_URL;

  let url: URL;

  try {
    url = new URL(rawBase);
  } catch {
    return undefined;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

  const baseUrl = rawBase.replace(/\/+$/, "");
  const apiKey = process.env.NEXUS_API_KEY?.trim() || undefined;

  const declared = process.env.NEXUS_EXECUTION?.trim().toLowerCase();
  const execution: Execution =
    declared === "local" || declared === "cloud"
      ? declared
      : isLoopback(url.hostname)
        ? "local"
        : "cloud";

  // A hosted endpoint without a key can only fail; a local one may not need it.
  if (!apiKey && execution === "cloud") return undefined;

  return {
    baseUrl,
    apiKey,
    model,
    vision: flag(process.env.NEXUS_VISION, false),
    execution,
    nativeTools: flag(process.env.NEXUS_NATIVE_TOOLS, false),
  };
}

export function nexusConfigured(): boolean {
  return nexusConfig() !== undefined;
}

/** What the rest of the app may know about Nexus: never the engine behind it. */
export function nexusModel(): ModelInfo | undefined {
  const config = nexusConfig();

  if (!config) return undefined;

  return {
    id: NEXUS_ID,
    label: NEXUS_LABEL,
    execution: config.execution,
    vision: config.vision,
  };
}

/** Why Nexus is unavailable, phrased for the person running the deployment. */
export const NEXUS_NOT_CONFIGURED_MESSAGE =
  "Nexus is not configured on this server. Set NEXUS_MODEL (and NEXUS_API_KEY, or a local NEXUS_BASE_URL) in .env.local and restart.";

const transport = createOpenAiCompatibleProvider({
  id: NEXUS_ID,
  label: NEXUS_LABEL,
  execution: "cloud",
  baseUrl: () => nexusConfig()?.baseUrl,
  apiKey: () => nexusConfig()?.apiKey,
  requiresKey: false,
  supportsNativeTools: () => nexusConfig()?.nativeTools ?? false,
});

/**
 * What a user may be told about a backend failure. The upstream's own error
 * body routinely names the engine ("the model `x` does not exist"), so it is
 * logged for the operator and replaced here; the status survives so retry
 * rules still work.
 */
function publicUpstreamError(error: UpstreamError): UpstreamError {
  console.error("nexus_upstream_error", error.status, error.detail);

  const detail =
    error.status === 401 || error.status === 403
      ? "the backend rejected this server's credentials (operator: check NEXUS_API_KEY)"
      : error.status === 404
        ? "the backend could not find the configured model or endpoint (operator: check NEXUS_MODEL and NEXUS_BASE_URL)"
        : error.status === 429
          ? "the backend is rate limiting requests, please try again shortly"
          : error.status >= 500
            ? "the backend had an internal error"
            : "the backend refused the request";

  return new UpstreamError(NEXUS_LABEL, error.status, detail);
}

/**
 * The single chat provider. Whatever `model` a caller might have carried
 * around is irrelevant here: the engine is the one configured on the server,
 * so a request cannot steer Nexus onto a different model.
 */
export const nexusProvider: ChatProvider = {
  id: NEXUS_ID,
  label: NEXUS_LABEL,

  get execution(): Execution {
    return nexusConfig()?.execution ?? "cloud";
  },

  isConfigured: nexusConfigured,

  async *stream(request: ChatRequest) {
    const config = nexusConfig();

    if (!config) {
      throw new Error(NEXUS_NOT_CONFIGURED_MESSAGE);
    }

    try {
      yield* transport.stream({ ...request, model: config.model });
    } catch (error) {
      throw error instanceof UpstreamError ? publicUpstreamError(error) : error;
    }
  },
};
