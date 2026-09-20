import { describe, expect, it } from "vitest";
import {
  extractImagePrompt,
  isDirectImageRequest,
} from "./imageRequest";

describe("image request detection", () => {
  it("detects explicit image-generation requests", () => {
    expect(isDirectImageRequest("Generate an image of a Bugatti Chiron")).toBe(true);
    expect(isDirectImageRequest("generate image of a cat")).toBe(true);
    expect(isDirectImageRequest("create a picture of a castle")).toBe(true);
    expect(isDirectImageRequest("make an image of a dragon")).toBe(true);
    expect(isDirectImageRequest("produce a portrait of a person")).toBe(true);
    expect(isDirectImageRequest("generate_image of a futuristic robot")).toBe(true);
  });

  it("detects natural drawing and rendering requests", () => {
    expect(isDirectImageRequest("Draw a human in a blue jacket")).toBe(true);
    expect(isDirectImageRequest("Paint a red sports car")).toBe(true);
    expect(isDirectImageRequest("Sketch a mountain landscape")).toBe(true);
    expect(isDirectImageRequest("Illustrate a futuristic robot")).toBe(true);
    expect(isDirectImageRequest("Render a 3D spaceship")).toBe(true);
    expect(isDirectImageRequest("Can you draw a tree")).toBe(true);
    expect(isDirectImageRequest("Please create a logo for a bakery")).toBe(true);
  });

  it("detects natural conversational image requests", () => {
    expect(isDirectImageRequest("Make me an image of a blue car")).toBe(true);
    expect(isDirectImageRequest("Could you make me a picture of a castle")).toBe(true);
    expect(isDirectImageRequest("I want you to create a portrait of a person")).toBe(true);
    expect(isDirectImageRequest("I'd like you to draw a robot")).toBe(true);
    expect(isDirectImageRequest("Would you paint me a landscape")).toBe(true);
  });

  it("detects direct visual-description requests", () => {
    expect(isDirectImageRequest("Image of a waterfall at sunset")).toBe(true);
    expect(isDirectImageRequest("Picture of a black cat")).toBe(true);
    expect(isDirectImageRequest("Photo of a futuristic city")).toBe(true);
    expect(isDirectImageRequest("Portrait of a person wearing armor")).toBe(true);
  });

  it("does not classify normal chat as image generation", () => {
    expect(isDirectImageRequest("Explain how photosynthesis works")).toBe(false);
    expect(isDirectImageRequest("What is a Bugatti Chiron?")).toBe(false);
    expect(isDirectImageRequest("Write Python code")).toBe(false);
    expect(isDirectImageRequest("How do I draw a human?")).toBe(false);
  });

  it("extracts the actual image prompt", () => {
    expect(
      extractImagePrompt("Generate an image of a realistic Bugatti Chiron"),
    ).toBe("a realistic Bugatti Chiron");

    expect(
      extractImagePrompt("generate_image of a futuristic robot"),
    ).toBe("a futuristic robot");

    expect(
      extractImagePrompt("Please create a picture of a jungle temple"),
    ).toBe("a jungle temple");

    expect(
      extractImagePrompt("make an image: a red sports car"),
    ).toBe("a red sports car");

    expect(
      extractImagePrompt("Make me an image of a blue car"),
    ).toBe("a blue car");

    expect(
      extractImagePrompt("I want you to create a portrait of a person"),
    ).toBe("portrait of a person");

    expect(
      extractImagePrompt("I'd like you to draw a robot"),
    ).toBe("robot");

    expect(
      extractImagePrompt("Can you render a 3D spaceship"),
    ).toBe("3D spaceship");

    expect(
      extractImagePrompt("Picture of a black cat"),
    ).toBe("a black cat");
  });
});
