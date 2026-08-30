import { describe, expect, it } from "vitest";
import { pickDelta } from "@/lib/providers/anthropic";

describe("Anthropic pickDelta", () => {
  it("extracts text from a content_block_delta text_delta event", () => {
    const event = { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } };
    expect(pickDelta(event)).toBe("hi");
  });

  it("ignores non-text-delta events", () => {
    expect(pickDelta({ type: "message_start" })).toBeUndefined();
    expect(pickDelta({ type: "ping" })).toBeUndefined();
    expect(pickDelta({ type: "content_block_stop" })).toBeUndefined();
    expect(pickDelta({ type: "message_stop" })).toBeUndefined();
  });

  it("assembles a full realistic event sequence into the correct final text", () => {
    const events = [
      { type: "message_start" },
      { type: "content_block_start" },
      { type: "ping" },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: ", world!" } },
      { type: "content_block_stop" },
      { type: "message_stop" },
    ];
    const assembled = events.map(pickDelta).filter(Boolean).join("");
    expect(assembled).toBe("Hello, world!");
  });
});

