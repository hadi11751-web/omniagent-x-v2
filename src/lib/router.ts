import type { Capability, ModelInfo } from "@/lib/types";

const PATTERNS: { capability: Capability; pattern: RegExp }[] = [
  { capability: "image", pattern: /\b(draw|generate an image|image of|picture of|illustrate|logo)\b/i },
  { capability: "coding", pattern: /\b(code|function|bug|typescript|python|regex|refactor|stack ?trace|compile)\b/i },
  { capability: "research", pattern: /\b(search|latest|news|who won|current|today|sources?|cite)\b/i },
  { capability: "reasoning", pattern: /\b(why|prove|analy[sz]e|step by step|explain in depth|compare|strategy)\b/i },
  { capability: "private", pattern: /\b(private|confidential|local only|do not send|offline)\b/i },
];

/** Classifies a prompt into the capability that best matches it. */
export function classify(prompt: string): Capability {
  for (const { capability, pattern } of PATTERNS) {
    if (pattern.test(prompt)) return capability;
  }
  return "fast";
}

/**
 * Picks a model for a prompt. Deliberately simple: prefer a configured model
 * that advertises the needed capability, else fall back to the first available.
 */
export function routeModel(prompt: string, models: ModelInfo[]): { model?: ModelInfo; capability: Capability } {
  const capability = classify(prompt);
  const match = models.find((model) => model.capabilities.includes(capability));
  return { model: match ?? models[0], capability };
}
