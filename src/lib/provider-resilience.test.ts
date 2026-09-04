import { beforeEach, describe, expect, it } from "vitest";
import {
  getProviderHealth,
  isProviderHealthy,
  isRetryableError,
  rankFailoverCandidates,
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderHealth,
  streamWithFailover,
} from "./provider-resilience";
import { UpstreamError } from "./http";
import type { ChatProvider, ModelInfo } from "./types";

function provider(
  id: ChatProvider["id"],
  execution: ChatProvider["execution"] = "cloud",
): ChatProvider {
  return {
    id,
    label: id,
    execution,
    isConfigured: () => true,
    async *stream() {
      yield "ok";
    },
  };
}

function model(
  id: string,
  providerId: ModelInfo["provider"],
  capabilities: ModelInfo["capabilities"],
  vision = false,
  execution: ModelInfo["execution"] = "cloud",
): ModelInfo {
  return {
    id,
    label: id,
    provider: providerId,
    execution,
    capabilities,
    ...(vision ? { vision: true } : {}),
  };
}

describe("provider resilience", () => {
  beforeEach(() => {
    resetProviderHealth();
  });

  it("classifies transient upstream failures as retryable", () => {
    expect(
      isRetryableError(
        new UpstreamError("test", 429, "rate limited"),
      ),
    ).toBe(true);

    expect(
      isRetryableError(
        new UpstreamError("test", 503, "unavailable"),
      ),
    ).toBe(true);
  });

  it("does not retry permanent client errors", () => {
    expect(
      isRetryableError(
        new UpstreamError("test", 401, "unauthorized"),
      ),
    ).toBe(false);

    expect(
      isRetryableError(
        new UpstreamError("test", 400, "bad request"),
      ),
    ).toBe(false);
  });

  it("ranks compatible models from different providers", () => {
    const primary = {
      model: model(
        "claude-opus-5",
        "anthropic",
        ["reasoning", "coding"],
      ),
      provider: provider("anthropic"),
    };

    const groqModel = model(
      "openai/gpt-oss-120b",
      "groq",
      ["reasoning", "research"],
    );

    const localModel = model(
      "llama3.1",
      "ollama",
      ["private", "fast"],
      false,
      "local",
    );

    const alternatives = rankFailoverCandidates(
      primary,
      [primary.model, groqModel, localModel],
      {
        anthropic: primary.provider,
        groq: provider("groq"),
        ollama: provider("ollama", "local"),
      },
      "reasoning",
    );

    expect(alternatives.map((item) => item.model.id)).toEqual([
      "openai/gpt-oss-120b",
    ]);
  });

  it("keeps vision failover limited to vision-capable models", () => {
    const primary = {
      model: model(
        "qwen/qwen3.6-27b",
        "groq",
        ["coding", "reasoning"],
        true,
      ),
      provider: provider("groq"),
    };

    const normal = model(
      "gemini-3.6-flash",
      "gemini",
      ["fast", "research", "reasoning"],
    );

    const vision = model(
      "another-vision-model",
      "openrouter",
      ["reasoning"],
      true,
    );

    const alternatives = rankFailoverCandidates(
      primary,
      [primary.model, normal, vision],
      {
        groq: primary.provider,
        gemini: provider("gemini"),
        openrouter: provider("openrouter"),
      },
      "reasoning",
      true,
    );

    expect(alternatives.map((item) => item.model.id)).toEqual([
      "another-vision-model",
    ]);
  });

  it("keeps private requests on local execution", () => {
    const primary = {
      model: model(
        "local-primary",
        "ollama",
        ["private"],
        false,
        "local",
      ),
      provider: provider("ollama", "local"),
    };

    const cloud = model(
      "cloud-fallback",
      "groq",
      ["private", "reasoning"],
    );

    const local = model(
      "local-fallback",
      "ollama",
      ["private"],
      false,
      "local",
    );

    const alternatives = rankFailoverCandidates(
      primary,
      [primary.model, cloud, local],
      {
        ollama: primary.provider,
        groq: provider("groq"),
      },
      "private",
      false,
      true,
    );

    expect(alternatives.map((item) => item.model.id)).toEqual([
      "local-fallback",
    ]);
  });

  it("fails over after a provider fails before producing output", async () => {
    const failing: ChatProvider = {
      id: "anthropic",
      label: "anthropic",
      execution: "cloud",
      isConfigured: () => true,
      async *stream() {
        throw new UpstreamError(
          "anthropic",
          503,
          "unavailable",
        );
      },
    };

    const fallback = provider("groq");

    const primary = {
      model: model("primary", "anthropic", ["reasoning"]),
      provider: failing,
    };

    const alternative = {
      model: model("fallback", "groq", ["reasoning"]),
      provider: fallback,
    };

    const chunks: string[] = [];

    for await (
      const chunk of streamWithFailover(
        primary,
        {
          model: "primary",
          messages: [{ role: "user", content: "hello" }],
        },
        [alternative],
        {
          maxAttempts: 1,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      )
    ) {
      chunks.push(`${chunk.model.id}:${chunk.text}`);
    }

    expect(chunks).toEqual(["fallback:ok"]);
  });

  it("does not retry or fail over after partial output", async () => {
    const calls: string[] = [];

    const partiallyFailing: ChatProvider = {
      id: "anthropic",
      label: "anthropic",
      execution: "cloud",
      isConfigured: () => true,
      async *stream() {
        calls.push("anthropic");
        yield "partial";
        throw new UpstreamError(
          "anthropic",
          503,
          "stream failed",
        );
      },
    };

    const fallback: ChatProvider = {
      id: "groq",
      label: "groq",
      execution: "cloud",
      isConfigured: () => true,
      async *stream() {
        calls.push("groq");
        yield "should not run";
      },
    };

    const primary = {
      model: model("primary", "anthropic", ["reasoning"]),
      provider: partiallyFailing,
    };

    const alternative = {
      model: model("fallback", "groq", ["reasoning"]),
      provider: fallback,
    };

    const chunks: string[] = [];

    await expect(async () => {
      for await (
        const chunk of streamWithFailover(
          primary,
          {
            model: "primary",
            messages: [{ role: "user", content: "hello" }],
          },
          [alternative],
          {
            maxAttempts: 3,
            baseDelayMs: 0,
            maxDelayMs: 0,
          },
        )
      ) {
        chunks.push(chunk.text);
      }
    }).rejects.toThrow("stream failed");

    expect(chunks).toEqual(["partial"]);
    expect(calls).toEqual(["anthropic"]);
  });

  it("enters cooldown after three consecutive transient failures", () => {
    const error = new UpstreamError(
      "groq",
      503,
      "unavailable",
    );

    recordProviderFailure("groq", error);
    expect(isProviderHealthy("groq")).toBe(true);

    recordProviderFailure("groq", error);
    expect(isProviderHealthy("groq")).toBe(true);

    recordProviderFailure("groq", error);
    expect(isProviderHealthy("groq")).toBe(false);

    const health = getProviderHealth("groq");

    expect(health.failures).toBe(3);
    expect(health.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("does not put permanent failures into cooldown", () => {
    recordProviderFailure(
      "groq",
      new UpstreamError(
        "groq",
        401,
        "unauthorized",
      ),
    );

    expect(isProviderHealthy("groq")).toBe(true);
    expect(getProviderHealth("groq").failures).toBe(0);
  });

  it("successful provider use clears health failures", () => {
    recordProviderFailure(
      "groq",
      new UpstreamError(
        "groq",
        503,
        "unavailable",
      ),
    );

    expect(getProviderHealth("groq").failures).toBe(1);

    recordProviderSuccess("groq");

    expect(getProviderHealth("groq")).toEqual({
      failures: 0,
      cooldownUntil: 0,
    });
  });

  it("skips cooled providers when ranking candidates", () => {
    const primary = {
      model: model(
        "primary",
        "anthropic",
        ["reasoning"],
      ),
      provider: provider("anthropic"),
    };

    const groqModel = model(
      "groq-fallback",
      "groq",
      ["reasoning"],
    );

    const geminiModel = model(
      "gemini-fallback",
      "gemini",
      ["reasoning"],
    );

    const error = new UpstreamError(
      "groq",
      503,
      "unavailable",
    );

    recordProviderFailure("groq", error);
    recordProviderFailure("groq", error);
    recordProviderFailure("groq", error);

    const alternatives = rankFailoverCandidates(
      primary,
      [primary.model, groqModel, geminiModel],
      {
        anthropic: primary.provider,
        groq: provider("groq"),
        gemini: provider("gemini"),
      },
      "reasoning",
    );

    expect(alternatives.map((item) => item.model.id)).toEqual([
      "gemini-fallback",
    ]);
  });
});
