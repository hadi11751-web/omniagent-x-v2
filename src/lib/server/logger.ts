export type LogContext = Record<string, string | number | boolean | undefined>;

function safeError(error: unknown): { name?: string; kind?: string } {
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
