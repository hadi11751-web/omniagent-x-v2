import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import MessageList from "@/components/MessageList";
import type { UiMessage } from "@/lib/client/types";

function answer(content: string, sourceCount?: number): UiMessage {
  return {
    id: "a-1",
    role: "assistant",
    content,
    createdAt: 1,
    meta: { model: "Nexus", execution: "cloud", mode: "research" },
    sources:
      sourceCount === undefined
        ? undefined
        : Array.from({ length: sourceCount }, (_, index) => ({
            title: `Result ${index + 1}`,
            url: `https://example.com/${index + 1}`,
          })),
  };
}

function render(message: UiMessage): string {
  return renderToStaticMarkup(
    createElement(MessageList, {
      messages: [message],
      streaming: false,
      onRegenerate: () => {},
    }),
  );
}

describe("citation markers in the rendered answer", () => {
  it("shows only the marker a returned source can back", () => {
    const html = render(answer("Gemma fits on 8GB [1] and the paper claims [7].", 3));

    expect(html).toContain("[1]");
    expect(html).not.toContain("[7]");
  });

  it("renders the source list in the numbering the markers were checked against", () => {
    const html = render(answer("Reported [2] first.", 3));
    const links = [...html.matchAll(/href="(https:\/\/example\.com\/\d+)"/g)].map(
      (match) => match[1],
    );

    expect(links).toEqual([
      "https://example.com/1",
      "https://example.com/2",
      "https://example.com/3",
    ]);
  });

  it("leaves a bracketed index inside a code block alone", () => {
    const html = render(answer("```js\nvalues[9] = row[1];\n```", 2));

    expect(html).toContain("values[9]");
  });

  it("strips citation claims from an answer that never searched", () => {
    const html = render(answer("Analysts agree [1][2]."));

    expect(html).not.toContain("[1]");
    expect(html).not.toContain("[2]");
  });

  it("still renders a real markdown link the answer wrote", () => {
    const html = render(answer("See [the release note](https://example.com/x).", 1));

    expect(html).toContain('href="https://example.com/x"');
  });

  /*
   * A saved row can carry a source whose url is not a link a browser may follow
   * — anything stored before the search results were filtered. It is shown as
   * text in its original position rather than dropped, because the position is
   * the number the [n] markers were checked against.
   */
  it("does not turn a source with an unusable scheme into a clickable link", () => {
    const message = answer("Reported [1] and [2].", 0);

    message.sources = [
      { title: "Scripted", url: "javascript:alert(1)" },
      { title: "Real", url: "https://example.com/real" },
    ];

    const html = render(message);

    expect(html).not.toContain('href="javascript:alert(1)"');
    expect(html).toContain("Scripted");
    expect(html).toContain('href="https://example.com/real"');
    expect(html.match(/<li>/g)).toHaveLength(2);
  });
});
