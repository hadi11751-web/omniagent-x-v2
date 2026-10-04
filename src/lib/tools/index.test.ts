import { describe, expect, it } from "vitest";
import {
  ALL_TOOLS,
  availableTools,
  findTool,
  parseToolCall,
  stripThinking,
} from "./index";
import type { PrivacyPolicy } from "@/lib/privacy";

/*
 * The tag pair is written in halves throughout this file: a literal pair does
 * not survive the tooling that moves this text around, and a fixture that lost
 * it silently would assert nothing.
 */
const OPEN = "<" + "think>";
const CLOSE = "<" + "/think>";

const open: PrivacyPolicy = { requested: false, localOnly: false, unmet: false };
const sealed: PrivacyPolicy = { requested: true, localOnly: true, unmet: false };
const cloudAnswering: PrivacyPolicy = {
  requested: true,
  localOnly: false,
  unmet: true,
};

function names(policy?: PrivacyPolicy): string[] {
  return availableTools(policy).map((tool) => tool.name);
}

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

describe("availableTools under a privacy boundary", () => {
  it("drops the tools that reach outside the deployment", () => {
    // The image tool is in the catalog whatever the server keys say.
    expect(ALL_TOOLS.map((tool) => tool.name)).toContain("generate_image");

    expect(names(open)).toContain("web_search");
    expect(names(open)).toContain("fetch_url");
    expect(names(sealed)).not.toContain("web_search");
    expect(names(sealed)).not.toContain("fetch_url");
    expect(names(sealed)).not.toContain("generate_image");
  });

  it("keeps the ones that only touch bytes already in the request", () => {
    for (const name of ["calculator", "analyze_text", "generate_pdf", "inspect_pdf"]) {
      expect(names(sealed)).toContain(name);
    }
  });

  it("refuses to hand back a tool the boundary excluded", () => {
    expect(findTool("web_search", sealed)).toBeUndefined();
    expect(findTool("web_search", open)?.name).toBe("web_search");
  });

  /*
   * The case the boundary used to miss: the prompt reads as private but no
   * local model is configured, so a cloud model answers. The reply has to leave;
   * an image call to a second provider does not.
   */
  it("blocks the same tools when privacy was asked for but cannot be served locally", () => {
    expect(names(cloudAnswering)).not.toContain("web_search");
    expect(names(cloudAnswering)).not.toContain("fetch_url");
    expect(findTool("generate_image", cloudAnswering)).toBeUndefined();

    for (const name of ["calculator", "analyze_text", "generate_pdf", "inspect_pdf"]) {
      expect(names(cloudAnswering)).toContain(name);
    }
  });

  it("offers everything when no policy was passed", () => {
    expect(names()).toEqual(names(open));
  });
});

describe("stripThinking", () => {
  it("keeps the answer and drops a closed reasoning block", () => {
    expect(stripThinking(`${OPEN}2 plus 2 is 4.${CLOSE}\nhi`)).toBe("hi");
  });

  it("drops everything an unclosed block swallowed", () => {
    expect(stripThinking(`${OPEN}never finished thinking`)).toBe("");
  });

  it("leaves an ordinary answer untouched", () => {
    expect(stripThinking("Four.")).toBe("Four.");
  });
});
