import { describe, expect, it } from "vitest";
import { classify } from "@/lib/intent";
import { REALTIME_SEARCH } from "@/lib/product";

describe("classify", () => {
  it("reads a plain question as everyday", () => {
    expect(classify("how do I boil an egg")).toBe("fast");
  });

  it("recognises each capability on its own wording", () => {
    expect(classify("refactor this typescript function")).toBe("coding");
    expect(classify("who won yesterday's match")).toBe("research");
    expect(classify("prove this step by step")).toBe("reasoning");
    expect(classify("draw a logo of a fox")).toBe("image");
  });

  /*
   * The order of the patterns is the privacy guarantee: a private request that
   * also mentions code or search used to be classified as those instead, and
   * then routed to a cloud model.
   */
  it("lets privacy outrank every other reading", () => {
    expect(classify("search the web for the latest news on this")).toBe("research");
    expect(classify("private: refactor this typescript function")).toBe("private");
    expect(classify("confidential, search for the latest version")).toBe("private");
    expect(classify("local only, draw a logo")).toBe("private");
    expect(classify("do not send this to anyone, explain why")).toBe("private");
  });

  it("matches privacy wording case-insensitively", () => {
    expect(classify("PRIVATE notes")).toBe("private");
  });

  /*
   * The other half of the same rule. One bare `\bprivate\b|\boffline\b` matched
   * ordinary programming questions, and a false positive is not harmless: it
   * switches tools and live search off, moves the question to the local model,
   * and tells the memory extractor to skip the chat.
   */
  it("does not read a programming word as a privacy claim", () => {
    expect(classify("why does my private method throw in TypeScript?")).toBe("coding");
    expect(classify("make my PWA work offline")).toBe("fast");
    expect(classify("do not send me marketing emails")).toBe("fast");
    expect(classify("what does the private modifier do in a TypeScript class?")).toBe("coding");
  });

  it("still keeps a privacy claim that mentions code", () => {
    expect(classify("keep this private, it is about my salary")).toBe("private");
    expect(classify("this is confidential, refactor it carefully")).toBe("private");
    expect(classify("use a local model only for these patient records")).toBe("private");
    expect(classify("don't send this to anyone outside my machine")).toBe("private");
  });
});

/*
 * The pricing page lists what Omni goes and finds out on the live web. Each of
 * those lines has to be a question the router reads as research, or the copy
 * promises a search the code never runs.
 */
describe("what the live-search copy promises", () => {
  const promised: [string, string][] = [
    [
      "News and anything dated today, yesterday or this week",
      "what changed in the news this week",
    ],
    [
      "Latest releases, versions and prices",
      "what does the latest version cost",
    ],
    [
      "Who won, final scores and other fast-changing facts",
      "who won, and what was the final score",
    ],
    [
      "Comparisons that only hold with current data",
      "compare the current options",
    ],
  ];

  for (const [claim, question] of promised) {
    it(`reads "${question}" as research, for the claim "${claim}"`, () => {
      expect(classify(question)).toBe("research");
    });
  }

  /*
   * The fifth line, a site you pasted, is `fetch_url` reading that page rather
   * than a search, so it is deliberately outside the router. Adding a promised
   * line without a case above fails here instead of quietly over-promising.
   */
  it("keeps the promised list covered by a case each", () => {
    expect(REALTIME_SEARCH.searchesFor).toHaveLength(promised.length + 1);
  });
});
