import { describe, expect, it } from "vitest";
import { auditCitations } from "@/lib/citations";
import type { Source } from "@/lib/types";

function returned(count: number): Source[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `Result ${index + 1}`,
    url: `https://example.com/${index + 1}`,
  }));
}

describe("auditCitations", () => {
  it("keeps a marker that matches a source the search returned", () => {
    const answer = "Gemma 3 runs on 8GB of RAM [1].";
    const audit = auditCitations(answer, returned(3));

    expect(audit.text).toBe(answer);
    expect(audit.verified).toEqual([1]);
    expect(audit.unresolved).toEqual([]);
  });

  it("keeps every marker of a confirmed group in the order written", () => {
    const audit = auditCitations("Both [2] and [1] agree.", returned(2));

    expect(audit.text).toBe("Both [2] and [1] agree.");
    expect(audit.verified).toEqual([2, 1]);
  });

  it("drops a marker past the end of the source list", () => {
    const audit = auditCitations("The trial reported 40% [4].", returned(3));

    expect(audit.text).toBe("The trial reported 40%.");
    expect(audit.unresolved).toEqual([4]);
    expect(audit.verified).toEqual([]);
  });

  it("drops citation claims from an answer that never searched", () => {
    const audit = auditCitations("Experts agree it works [1][2][3].", []);

    expect(audit.text).toBe("Experts agree it works.");
    expect(audit.unresolved).toEqual([1, 2, 3]);
  });

  it("keeps the part of a mixed group that has a source behind it", () => {
    const audit = auditCitations("Reported as [1, 9].", returned(3));

    expect(audit.text).toBe("Reported as [1].");
    expect(audit.verified).toEqual([1]);
    expect(audit.unresolved).toEqual([9]);
  });

  it("leaves a confirmed range written as a range", () => {
    const audit = auditCitations("Across [1-3] the trend held.", returned(5));

    expect(audit.text).toBe("Across [1-3] the trend held.");
    expect(audit.unresolved).toEqual([]);
  });

  it("drops a range whose far end no source covers", () => {
    const audit = auditCitations("Across [1-9] the trend held.", returned(3));

    expect(audit.text).toBe("Across the trend held.");
    // Source 1 exists and 9 does not, so the claim as a whole cannot stand.
    expect(audit.verified).toEqual([1]);
    expect(audit.unresolved).toEqual([9]);
  });

  it("collapses the gap a dropped marker left without joining words", () => {
    const audit = auditCitations("see [7] for details", returned(2));

    expect(audit.text).toBe("see for details");
  });

  it("does not double the indent when a line starts with a marker", () => {
    const audit = auditCitations("  [7] first item", returned(2));

    expect(audit.text).toBe("  first item");
  });

  it("never touches a real markdown link", () => {
    const answer = "See [the release note](https://example.com/x) for [1].";
    const audit = auditCitations(answer, returned(1));

    expect(audit.text).toBe(answer);
    expect(audit.verified).toEqual([1]);
  });

  it("never touches an image or a reference definition", () => {
    const answer = "![1](https://example.com/a.png)\n[9]: https://example.com";
    const audit = auditCitations(answer, returned(2));

    expect(audit.text).toBe(answer);
    expect(audit.unresolved).toEqual([]);
  });

  it("never touches [n] inside a fenced code block", () => {
    const answer = [
      "Index it directly:",
      "```python",
      "values[9] = row[1]",
      "```",
      "That is all [9].",
    ].join("\n");

    const audit = auditCitations(answer, returned(2));

    expect(audit.text).toContain("values[9] = row[1]");
    expect(audit.text).toBe("Index it directly:\n```python\nvalues[9] = row[1]\n```\nThat is all.");
  });

  it("never touches [n] inside an inline code span", () => {
    const answer = "Read `argv[9]` before the call [1].";
    const audit = auditCitations(answer, returned(1));

    expect(audit.text).toBe(answer);
  });

  it("treats a four-digit bracket as a year, not a source index", () => {
    const answer = "Shipped in [2024] and revised [1].";
    const audit = auditCitations(answer, returned(1));

    expect(audit.text).toBe(answer);
    expect(audit.verified).toEqual([1]);
    expect(audit.unresolved).toEqual([]);
  });

  it("leaves prose in brackets alone", () => {
    const answer = "The [see above] note still stands.";
    const audit = auditCitations(answer, returned(2));

    expect(audit.text).toBe(answer);
    expect(audit.unresolved).toEqual([]);
  });

  it("passes text with no brackets through untouched", () => {
    const answer = "No citations here at all.";

    expect(auditCitations(answer, returned(3)).text).toBe(answer);
    expect(auditCitations("", returned(3)).text).toBe("");
  });

  it("only removes a marker instead of rewriting the answer", () => {
    const audit = auditCitations("Claims [1] and [8].", returned(2));

    expect(audit.text).toBe("Claims [1] and.");
    expect(audit.verified).toEqual([1]);
    expect(audit.unresolved).toEqual([8]);
  });

  it("checks a chained group of markers one by one", () => {
    const audit = auditCitations("Reported [1][2][8].", returned(2));

    expect(audit.text).toBe("Reported [1][2].");
    expect(audit.unresolved).toEqual([8]);
  });
});
