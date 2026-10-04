import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteServerConversation } from "@/lib/client/conversationClient";
import {
  conversationStamp,
  reconcileConversations,
  setStorageScope,
  storage,
  MAX_PENDING_DELETIONS,
} from "@/lib/client/storage";
import { MAX_CONVERSATIONS } from "@/lib/limits";
import type { Conversation } from "@/lib/client/types";

function conversation(id: string, updatedAt: number): Conversation {
  return {
    id,
    title: `Chat ${id}`,
    projectId: "general",
    createdAt: updatedAt - 10,
    updatedAt,
    messages: [{ id: `m-${id}`, role: "user", content: "hi", createdAt: updatedAt - 10 }],
  };
}

/** The same chat with `count` turns, the newest of them at `updatedAt`. */
function longer(id: string, updatedAt: number, count: number): Conversation {
  return {
    ...conversation(id, updatedAt),
    messages: Array.from({ length: count }, (_, index) => ({
      id: `m-${id}-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn ${index}`,
      createdAt: updatedAt - (count - index),
    })) as Conversation["messages"],
  };
}

describe("reconcileConversations", () => {
  it("merges server history with local-only chats, newest first", () => {
    const { conversations, pendingDeletions, needsUpload } = reconcileConversations(
      [conversation("server-old", 100), conversation("server-new", 300)],
      [conversation("local-only", 200)],
      [],
    );

    expect(conversations.map((item) => item.id)).toEqual([
      "server-new",
      "local-only",
      "server-old",
    ]);
    expect(pendingDeletions).toEqual([]);

    // The one row the server has never seen is the one row it has to be sent.
    expect(needsUpload).toEqual(["local-only"]);
  });

  /*
   * Saving is debounced, so closing the tab within a second or two of a reply
   * leaves the newest turns only in localStorage. The server copy of that chat
   * is then the older one, and taking it verbatim dropped those turns: four
   * local messages came back as two, and the reload looked like a reply that
   * had never arrived.
   */
  it("keeps the local turns when the server copy of that chat is older", () => {
    const { conversations, needsUpload } = reconcileConversations(
      [longer("chat-1", 100, 2)],
      [longer("chat-1", 400, 4)],
      [],
    );

    const [kept] = conversations;

    expect(kept.messages).toHaveLength(4);
    expect(kept.updatedAt).toBe(400);
    expect(needsUpload).toEqual(["chat-1"]);
  });

  it("takes the server copy when that is the newer one", () => {
    const { conversations, needsUpload } = reconcileConversations(
      [longer("chat-2", 500, 6)],
      [longer("chat-2", 200, 2)],
      [],
    );

    expect(conversations[0].messages).toHaveLength(6);
    expect(needsUpload).toEqual([]);
  });

  /*
   * A browser that never recorded `updatedAt` can still show the turns, so an
   * untimed local row is not proof of being older: at the same stamp the copy
   * holding more of the conversation wins.
   */
  it("breaks a tie by the copy holding the most messages", () => {
    const { conversations } = reconcileConversations(
      [longer("chat-3", 300, 3)],
      [longer("chat-3", 300, 5)],
      [],
    );

    expect(conversations[0].messages).toHaveLength(5);
  });

  /*
   * Deleting while the history service was down used to leave the conversation
   * on the server, and the next load presented it as if nothing had happened.
   */
  it("keeps a deleted conversation deleted and reports the server copy as owed", () => {
    const { conversations, pendingDeletions, needsUpload } = reconcileConversations(
      [conversation("gone", 100), conversation("kept", 200)],
      [longer("gone", 900, 8)],
      ["gone"],
    );

    expect(conversations.map((item) => item.id)).toEqual(["kept"]);
    expect(pendingDeletions).toEqual(["gone"]);

    // A delete the user asked for outranks a newer local copy of the same row.
    expect(needsUpload).toEqual([]);
  });

  it("will not re-upload a local chat whose deletion was never confirmed", () => {
    const { conversations, needsUpload } = reconcileConversations(
      [],
      [conversation("unsent", 100)],
      ["unsent"],
    );

    expect(conversations).toEqual([]);
    expect(needsUpload).toEqual([]);
  });
});

describe("storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fakeStorage() {
    const store = new Map<string, string>();

    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });

    // The names are per-account, so nothing is stored until an account is known.
    setStorageScope("user_sync");

    return store;
  }

  /*
   * The server prunes an account to `MAX_CONVERSATIONS`; the browser kept every
   * chat forever, so the two histories were bounded by different rules and the
   * unbounded one failed silently once localStorage filled up.
   */
  it("keeps only the number of conversations the server keeps", () => {
    fakeStorage();

    const many = Array.from({ length: MAX_CONVERSATIONS + 25 }, (_, index) =>
      conversation(`c-${index}`, index + 1),
    );

    storage.saveConversations(many);

    const kept = storage.loadConversations();

    expect(kept).toHaveLength(MAX_CONVERSATIONS);
    expect(kept[0].id).toBe(`c-${MAX_CONVERSATIONS + 24}`);
    expect(kept.some((item) => item.id === "c-0")).toBe(false);
  });

  it("remembers a deletion until the server confirms it", () => {
    fakeStorage();

    storage.saveDeletions(["a", "b"]);

    expect(storage.loadDeletions()).toEqual(["a", "b"]);

    storage.clearDeletions();

    expect(storage.loadDeletions()).toEqual([]);
  });

  /*
   * The tombstone list used to be trimmed with `slice(-MAX_CONVERSATIONS)`, so
   * offline deletes past the ceiling were dropped and the deleted conversations
   * came back as restored history. The bound now covers every id this browser
   * can point at, and the overflow is answered by a flag instead of by memory
   * loss.
   */
  it("records every owed delete up to the bound", () => {
    fakeStorage();

    const ids = Array.from({ length: MAX_PENDING_DELETIONS }, (_, index) => `d-${index}`);

    storage.saveDeletions(ids);

    expect(storage.loadDeletions()).toEqual(ids);
    expect(storage.loadWipePending()).toBe(false);
  });

  it("asks for one bulk clear once the tombstones overflow", () => {
    fakeStorage();

    const ids = Array.from(
      { length: MAX_PENDING_DELETIONS + 1 },
      (_, index) => `d-${index}`,
    );

    storage.saveDeletions(ids);

    expect(storage.loadDeletions()).toHaveLength(MAX_PENDING_DELETIONS);
    expect(storage.loadWipePending()).toBe(true);

    storage.clearWipePending();

    expect(storage.loadWipePending()).toBe(false);
  });

  it("bounds tombstones at every conversation this browser could owe", () => {
    // Server rows plus the local rows merged alongside them.
    expect(MAX_PENDING_DELETIONS).toBe(2 * MAX_CONVERSATIONS);
  });
});

describe("conversationStamp", () => {
  it("ranks by the newest message, not by the server's updatedAt", () => {
    // updatedAt is 500 but the newest message is at 490: the timeline wins, so a
    // fresh server stamp cannot make an older snapshot look newer.
    const stamped = conversation("a", 500);
    const unstamped = { ...conversation("b", 0), updatedAt: undefined };

    expect(conversationStamp(stamped)).toBe(490);
    expect(conversationStamp(unstamped)).toBe(-10);
  });

  it("falls back to updatedAt, then createdAt, when there are no messages", () => {
    const empty = { ...conversation("c", 500), messages: [] };
    const bare = { ...empty, updatedAt: undefined };

    expect(conversationStamp(empty)).toBe(500);
    expect(conversationStamp(bare)).toBe(490);
  });
});

/*
 * A tombstone is only cleared when the server agrees the row is gone, so a
 * response that already means "not here" has to count as agreement - otherwise
 * the app retried that deletion on every load forever.
 */
describe("deleteServerConversation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats a missing row as deleted but a failed request as owed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    await expect(deleteServerConversation("gone")).resolves.toBeUndefined();

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));

    await expect(deleteServerConversation("down")).rejects.toThrow(/503/);
  });
});
