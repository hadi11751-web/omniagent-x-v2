import { describe, expect, it } from "vitest";
import {
  shouldReplaceStoredConversation,
  type StoredConversation,
} from "./conversations";

function conversation(messages: number[]): StoredConversation {
  return {
    id: "chat-1",
    title: "Chat",
    projectId: "default",
    createdAt: 100,
    updatedAt: 100,
    messages: messages.map((createdAt, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      createdAt,
    })),
  };
}

describe("shouldReplaceStoredConversation", () => {
  it("rejects a stale snapshot with fewer messages", () => {
    expect(shouldReplaceStoredConversation(conversation([100, 200, 300]), conversation([100, 200]))).toBe(false);
  });

  it("accepts a snapshot with additional messages", () => {
    expect(shouldReplaceStoredConversation(conversation([100, 200]), conversation([100, 200, 300]))).toBe(true);
  });

  it("uses the last message timestamp when message counts match", () => {
    expect(shouldReplaceStoredConversation(conversation([100, 200]), conversation([100, 250]))).toBe(true);
    expect(shouldReplaceStoredConversation(conversation([100, 250]), conversation([100, 200]))).toBe(false);
  });

  it("accepts a later state of the same newest message", () => {
    const stored = conversation([100, 200]);
    const incoming = conversation([100, 200]);

    // Text unchanged, but an image and sources arrived after the earlier autosave.
    incoming.messages[1] = {
      ...incoming.messages[1],
      images: ["data:image/png;base64,QUJD"],
      sources: [{ title: "Example", url: "https://example.com" }],
    };

    expect(shouldReplaceStoredConversation(stored, incoming)).toBe(true);
  });

  it("accepts text that grew on the same message while it was streaming", () => {
    const stored = conversation([100, 200]);
    const incoming = conversation([100, 200]);
    incoming.messages[1] = { ...incoming.messages[1], content: "message 1, finished" };

    expect(shouldReplaceStoredConversation(stored, incoming)).toBe(true);
  });

  it("keeps the stored copy when a different message shares the newest timestamp", () => {
    const stored = conversation([100, 200]);
    const incoming = conversation([100, 200]);
    incoming.messages[1] = { ...incoming.messages[1], id: "from-another-tab" };

    expect(shouldReplaceStoredConversation(stored, incoming)).toBe(false);
  });

  it("accepts a retitled conversation that has no messages yet", () => {
    const stored = { ...conversation([]), title: "Old" };
    const incoming = { ...conversation([]), title: "New" };

    expect(shouldReplaceStoredConversation(stored, incoming)).toBe(true);
  });
});
