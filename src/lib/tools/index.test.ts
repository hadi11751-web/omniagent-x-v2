import { describe, expect, it } from "vitest";
import { parseToolCall } from "./index";

describe("parseToolCall image commands", () => {
  it("parses the normal TOOL protocol", () => {
    expect(
      parseToolCall("TOOL: generate_image | a realistic Bugatti"),
    ).toEqual({
      name: "generate_image",
      argument: "a realistic Bugatti",
    });
  });

  it("parses a Qwen-style think-wrapped tool call", () => {
    expect(
      parseToolCall(
        "<think>I should generate an image.</think>\nTOOL: generate_image | a realistic Bugatti",
      ),
    ).toEqual({
      name: "generate_image",
      argument: "a realistic Bugatti",
    });
  });

  it("parses the simple generate image wording", () => {
    expect(
      parseToolCall("generate image of a realistic Bugatti"),
    ).toEqual({
      name: "generate_image",
      argument: "a realistic Bugatti",
    });
  });

  it("parses the underscore form", () => {
    expect(
      parseToolCall("generate_image of a realistic Bugatti"),
    ).toEqual({
      name: "generate_image",
      argument: "a realistic Bugatti",
    });
  });
});
