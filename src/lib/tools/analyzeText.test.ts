import { describe, expect, it } from "vitest";
import { analyzeTextTool, textStats } from "./analyzeText";

describe("analyzeText tool", () => {
  it("calculates basic text statistics", () => {
    const result = textStats("Hello world. Hello again!");

    expect(result.characters).toBe(25);
    expect(result.words).toBe(4);
    expect(result.sentences).toBe(2);
    expect(result.lines).toBe(1);
    expect(result.averageWordLength).toBe(5.5);
    expect(result.topWords).toEqual([
      { word: "hello", count: 2 },
      { word: "world", count: 1 },
      { word: "again", count: 1 },
    ]);
  });

  it("handles empty input", () => {
    const result = textStats("");

    expect(result.characters).toBe(0);
    expect(result.words).toBe(0);
    expect(result.sentences).toBe(0);
    expect(result.lines).toBe(1);
    expect(result.averageWordLength).toBe(0);
    expect(result.topWords).toEqual([]);
  });

  it("counts lines and ignores terms shorter than four characters", () => {
    const result = textStats("The cat and dog\nThe cat runs");

    expect(result.lines).toBe(2);
    expect(result.topWords).toEqual([
      { word: "runs", count: 1 },
    ]);
  });

  it("returns the tool result format", async () => {
    const result = await analyzeTextTool.run("Hello world.");

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      characters: 12,
      words: 2,
      sentences: 1,
      lines: 1,
      averageWordLength: 5.5,
      topWords: [
        { word: "hello", count: 1 },
        { word: "world", count: 1 },
      ],
    });
    expect(result.content).toContain("words: 2");
  });

  it("normalizes punctuation when calculating frequent terms", () => {
    const result = textStats("Hello, hello! HELLO?");

    expect(result.topWords).toEqual([
      { word: "hello", count: 3 },
    ]);
  });

  it("returns at most ten frequent terms", () => {
    const text = Array.from(
      { length: 15 },
      (_, index) => `term${index}`,
    ).join(" ");

    const result = textStats(text);

    expect(result.topWords).toHaveLength(10);
  });

  it("rejects excessively large input", async () => {
    const result = await analyzeTextTool.run("x".repeat(1_000_001));

    expect(result.ok).toBe(false);
    expect(result.content).toContain("input is too large");
  });
});
