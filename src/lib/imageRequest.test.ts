import { describe, expect, it } from "vitest";
import {
  extractImagePrompt,
  isDirectImageRequest,
} from "./imageRequest";

describe("image request detection", () => {
  it("detects generate image requests", () => {
    expect(isDirectImageRequest("Generate an image of a Bugatti Chiron")).toBe(true);
    expect(isDirectImageRequest("generate image of a cat")).toBe(true);
    expect(isDirectImageRequest("generate_image of a futuristic robot")).toBe(true);
    expect(isDirectImageRequest("please create an image of a castle")).toBe(true);
    expect(isDirectImageRequest("make an image of a dragon")).toBe(true);
  });

  it("does not classify normal chat as image generation", () => {
    expect(isDirectImageRequest("Explain how photosynthesis works")).toBe(false);
    expect(isDirectImageRequest("What is a Bugatti Chiron?")).toBe(false);
    expect(isDirectImageRequest("Write Python code")).toBe(false);
  });

  it("extracts the actual image prompt", () => {
    expect(
      extractImagePrompt("Generate an image of a realistic Bugatti Chiron"),
    ).toBe("a realistic Bugatti Chiron");

    expect(
      extractImagePrompt("generate_image of a futuristic robot"),
    ).toBe("a futuristic robot");

    expect(
      extractImagePrompt("Please create an image of a jungle temple"),
    ).toBe("a jungle temple");

    expect(
      extractImagePrompt("make an image: a red sports car"),
    ).toBe("a red sports car");
  });
});
