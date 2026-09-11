import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestJsonMock } = vi.hoisted(() => ({
  requestJsonMock: vi.fn(),
}));

vi.mock("@/lib/http", () => ({
  requestJson: requestJsonMock,
}));

import {
  cosineSimilarity,
  createEmbedding,
} from "./embeddings";

describe("memory embeddings", () => {
  const originalKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    requestJsonMock.mockReset();
    process.env.GEMINI_API_KEY = "test-gemini-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  it("returns an embedding from Gemini", async () => {
    requestJsonMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          embedding: {
            values: [0.1, 0.2, 0.3],
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      createEmbedding("user likes TypeScript"),
    ).resolves.toEqual([0.1, 0.2, 0.3]);

    expect(requestJsonMock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty vector for empty input", async () => {
    await expect(createEmbedding("   ")).resolves.toEqual([]);
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it("rejects when Gemini is not configured", async () => {
    delete process.env.GEMINI_API_KEY;

    await expect(
      createEmbedding("test"),
    ).rejects.toThrow(
      "Gemini embeddings are not configured",
    );

    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it("rejects malformed embedding values", async () => {
    requestJsonMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          embedding: {
            values: [0.1, "invalid", 0.3],
          },
        }),
        { status: 200 },
      ),
    );

    await expect(
      createEmbedding("test"),
    ).rejects.toThrow(
      "Gemini embeddings returned non-numeric values",
    );
  });
});

describe("cosine similarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(
      cosineSimilarity([1, 0, 0], [1, 0, 0]),
    ).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(
      cosineSimilarity([1, 0, 0], [0, 1, 0]),
    ).toBeCloseTo(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(
      cosineSimilarity([1, 0, 0], [-1, 0, 0]),
    ).toBeCloseTo(-1);
  });

  it("returns 0 for mismatched vector dimensions", () => {
    expect(
      cosineSimilarity([1, 0], [1, 0, 0]),
    ).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(
      cosineSimilarity([0, 0], [1, 0]),
    ).toBe(0);
  });
});
