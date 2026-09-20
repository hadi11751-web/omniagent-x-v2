import { describe, expect, it } from "vitest";
import { MODELS } from "./models";

describe("model capability metadata", () => {
  it("marks Claude Opus 5 as vision-capable", () => {
    const model = MODELS.find((candidate) => candidate.id === "claude-opus-5");

    expect(model).toBeDefined();
    expect(model?.vision).toBe(true);
  });

  it("marks Claude Sonnet 5 as vision-capable", () => {
    const model = MODELS.find(
      (candidate) => candidate.id === "claude-sonnet-5",
    );

    expect(model).toBeDefined();
    expect(model?.vision).toBe(true);
  });

  it("does not mark DeepSeek V4 Pro as vision-capable", () => {
    const model = MODELS.find(
      (candidate) => candidate.id === "deepseek-v4-pro",
    );

    expect(model).toBeDefined();
    expect(model?.vision).toBeUndefined();
  });
});
