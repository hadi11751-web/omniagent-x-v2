import { UpstreamError } from "../http";

export type LogContext = Record<string, string | number | boolean | undefined>;

function safeError(
  error: unknown,
): {
  name?: string;
  kind?: string;
  provider?: string;
  status?: number;
  detail?: string;
} {
  if (error instanceof UpstreamError) {
    return {
      name: error.name,
      provider: error.provider,
      status: error.status,
      detail: error.detail.slice(0, 500),
    };
  }

  if (error instanceof Error) {
    return { name: error.name };
  }

  if (typeof error === "string") {
    return { kind: "string" };
  }

  return { kind: typeof error };
}

export function logServerError(
  event: string,
  error?: unknown,
  context: LogContext = {},
): void {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...context,
      error: error === undefined ? undefined : safeError(error),
    }),
  );
}
