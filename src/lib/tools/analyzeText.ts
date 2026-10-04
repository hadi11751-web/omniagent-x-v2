import type { ToolDefinition } from "@/lib/types";

export function textStats(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+\s/).filter((part) => part.trim().length > 0);
  const frequency = new Map<string, number>();
  for (const word of words) {
    const key = word.toLowerCase().replace(/[^a-z0-9']/g, "");
    if (key.length < 4) continue;
    frequency.set(key, (frequency.get(key) ?? 0) + 1);
  }
  const top = [...frequency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return {
    characters: text.length,
    words: words.length,
    sentences: sentences.length,
    lines: text.split(/\r?\n/).length,
    averageWordLength: words.length ? Number((words.join("").length / words.length).toFixed(2)) : 0,
    topWords: top.map(([word, count]) => ({ word, count })),
  };
}

export const analyzeTextTool: ToolDefinition = {
  name: "analyze_text",
  description: "Compute statistics (word/sentence counts, frequent terms) for a block of text or a pasted file.",
  argument: "the text to analyse",
  async run(input) {
    const stats = textStats(input);
    const content = [
      `characters: ${stats.characters}`,
      `words: ${stats.words}`,
      `sentences: ${stats.sentences}`,
      `lines: ${stats.lines}`,
      `average word length: ${stats.averageWordLength}`,
      `frequent terms: ${stats.topWords.map((entry) => `${entry.word} (${entry.count})`).join(", ") || "n/a"}`,
    ].join("\n");
    return { ok: true, content, data: stats };
  },
};
