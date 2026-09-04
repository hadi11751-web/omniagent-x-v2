import { beforeEach, describe, expect, it } from "vitest";
import { resetProviderHealth } from "./provider-resilience";
import { collectText } from "./stream";
import type { ChatProvider } from "./types";

function testProvider(
  id: ChatProvider["id"],
  streamImpl: ChatProvider["stream"],
): ChatProvider {
  return {
    id,
    label: id,
    execution: "cloud",
    isConfigured: () => true,
    stream: streamImpl,
  };
}

describe("collectText resilience", () => {
  beforeEach(() => {
    resetProviderHealth();
  });

  it("returns normal provider output", async () => {
    const provider = testProvider(
      "anthropic",
      async function* () {
        yield "hello ";
        yield "world";
      },
    );

    await expect(
      collectText(
        provider,
        "claude-opus-5",
        [{ role: "user", content: "hello" }],
      ),
    ).resolves.toBe("hello world");
  });

  it("fails over when the primary provider fails before output", async () => {
    const calls: string[] = [];

    const primary = testProvider(
      "anthropic",
      async function* () {
        calls.push("anthropic");
        throw new Error("fetch failed");
      },
    );

    const fallback = testProvider(
      "groq",
      async function* () {
        calls.push("groq");
        yield "fallback answer";
      },
    );

    const originalProviders = await import("@/lib/providers");
    const originalAnthropic = originalProviders.PROVIDERS.anthropic;
    const originalGroq = originalProviders.PROVIDERS.groq;

    originalProviders.PROVIDERS.anthropic = primary;
    originalProviders.PROVIDERS.groq = fallback;

    try {
      const result = await collectText(
        primary,
        "claude-opus-5",
        [{ role: "user", content: "hello" }],
      );

      expect(result).toBe("fallback answer");
      expect(calls).toEqual([
        "anthropic",
        "anthropic",
        "anthropic",
        "groq",
      ]);
    } finally {
      originalProviders.PROVIDERS.anthropic =
        originalAnthropic;
      originalProviders.PROVIDERS.groq = originalGroq;
    }
  });

  it("does not fail over after partial output", async () => {
    const calls: string[] = [];

    const primary = testProvider(
      "anthropic",
      async function* () {
        calls.push("anthropic");
        yield "partial";
        throw new Error("network failure");
      },
    );

    const fallback = testProvider(
      "groq",
      async function* () {
        calls.push("groq");
        yield "should not run";
      },
    );

    const originalProviders = await import("@/lib/providers");
    const originalAnthropic = originalProviders.PROVIDERS.anthropic;
    const originalGroq = originalProviders.PROVIDERS.groq;

    originalProviders.PROVIDERS.anthropic = primary;
    originalProviders.PROVIDERS.groq = fallback;

    try {
      await expect(
        collectText(
          primary,
          "claude-opus-5",
          [{ role: "user", content: "hello" }],
        ),
      ).rejects.toThrow("network failure");

      expect(calls).toEqual(["anthropic"]);
    } finally {
      originalProviders.PROVIDERS.anthropic =
        originalAnthropic;
      originalProviders.PROVIDERS.groq = originalGroq;
    }
  });
});
