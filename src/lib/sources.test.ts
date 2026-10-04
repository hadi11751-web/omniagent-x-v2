import { describe, expect, it } from "vitest";
import { followableSources, isFollowableUrl } from "./sources";

describe("source URL safety", () => {
  it("accepts normal http(s) URLs", () => {
    expect(isFollowableUrl("https://example.com/path")).toBe(true);
    expect(isFollowableUrl("http://example.com")).toBe(true);
  });

  it("rejects scripts, data URLs, and credential-bearing links", () => {
    expect(isFollowableUrl("javascript:alert(1)")).toBe(false);
    expect(isFollowableUrl("data:text/html,hello")).toBe(false);
    expect(isFollowableUrl("https://user:pass@example.com")).toBe(false);
  });

  it("filters unsafe sources without disturbing safe source order", () => {
    expect(
      followableSources([
        { title: "bad", url: "javascript:alert(1)" },
        { title: "one", url: "https://example.com/one" },
        { title: "credential", url: "https://u:p@example.com" },
        { title: "two", url: "https://example.com/two" },
      ]),
    ).toEqual([
      { title: "one", url: "https://example.com/one" },
      { title: "two", url: "https://example.com/two" },
    ]);
  });
});
