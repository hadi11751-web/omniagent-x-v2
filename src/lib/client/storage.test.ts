import { mergeSavedConversation } from "./storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * These names are what an account's saved chats are made of, so the property
 * under test is who else can read them. Written as bare constants they were one
 * shared bucket per browser: signing out and back in as a second account opened
 * the first one's history, its projects, its settings, and the deletes it still
 * owed the server.
 *
 * The module holds the account in a variable rather than reading it from Clerk,
 * so each test loads a fresh copy: `vi.resetModules()` is the only way to get
 * back the "nobody is known yet" state the app starts in.
 */
type StorageModule = typeof import("./storage");

let rows: Map<string, string>;

function browser() {
  rows = new Map();

  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, value: string) => {
        rows.set(key, String(value));
      },
      removeItem: (key: string) => {
        rows.delete(key);
      },
    },
  });
}

async function freshStorage(): Promise<StorageModule> {
  vi.resetModules();

  return import("./storage");
}

function conversation(id: string, text: string): import("./types").Conversation {
  return {
    id,
    title: text,
    projectId: "general",
    createdAt: 1,
    messages: [
      {
        id: `${id}-m1`,
        role: "user",
        content: text,
        createdAt: 1,
      },
    ],
  };
}

describe("per-account browser storage", () => {
  beforeEach(() => {
    browser();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not read or write anything until it knows the account", async () => {
    const { storage } = await freshStorage();

    storage.saveConversations([conversation("a-1", "private notes")]);

    expect(storage.loadConversations()).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it("keeps two accounts on one browser apart", async () => {
    const { setStorageScope, storage } = await freshStorage();

    setStorageScope("user_a");
    storage.saveConversations([conversation("a-1", "my thesis draft")]);

    setStorageScope("user_b");

    expect(storage.loadConversations()).toEqual([]);

    setStorageScope("user_a");

    expect(storage.loadConversations().map((entry) => entry.id)).toEqual(["a-1"]);
  });

  it("keeps projects, settings and owed deletes with their own account too", async () => {
    const { DEFAULT_SETTINGS, DEFAULT_PROJECTS, setStorageScope, storage } =
      await freshStorage();

    setStorageScope("user_a");
    storage.saveProjects([{ id: "p-1", name: "Client work", context: "secret" }]);
    storage.saveSettings({ ...DEFAULT_SETTINGS, memory: "calls me Mira" });
    storage.saveDeletions(["a-1"]);

    setStorageScope("user_b");

    expect(storage.loadProjects()).toEqual(DEFAULT_PROJECTS);
    expect(storage.loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(storage.loadDeletions()).toEqual([]);

    // And clearing this account's history cannot reach the other one's.
    storage.clearConversations();
    storage.clearDeletions();

    setStorageScope("user_a");

    expect(storage.loadDeletions()).toEqual(["a-1"]);
    expect(storage.loadSettings().memory).toBe("calls me Mira");
  });

  it("adopts history this browser made before the keys were per-account", async () => {
    rows.set("omniagent.conversations.v1", JSON.stringify([conversation("old-1", "before")]));

    const { setStorageScope, storage } = await freshStorage();

    setStorageScope("user_a");

    expect(storage.loadConversations().map((entry) => entry.id)).toEqual(["old-1"]);

    setStorageScope("user_b");

    // Adopted, not copied: the second account must not be handed the first's.
    expect(storage.loadConversations()).toEqual([]);
    expect(rows.has("omniagent.conversations.v1")).toBe(false);
  });

  it("keeps an account's own rows when it adopts", async () => {
    rows.set("omniagent.conversations.v1", JSON.stringify([conversation("old-1", "shared")]));
    rows.set(
      "omniagent.conversations.v1.user_a",
      JSON.stringify([conversation("own-1", "mine")]),
    );

    const { setStorageScope, storage } = await freshStorage();

    setStorageScope("user_a");

    expect(storage.loadConversations().map((entry) => entry.id)).toEqual(["own-1"]);
  });

  it("leaves a signed-out visitor on the unkeyed names", async () => {
    const { setStorageScope, storage } = await freshStorage();

    setStorageScope(null);
    storage.saveConversations([conversation("anon-1", "not signed in")]);

    expect(rows.has("omniagent.conversations.v1")).toBe(true);

    // The first account to sign in in this tab takes that row, as it always did.
    setStorageScope("user_a");

    expect(storage.loadConversations().map((entry) => entry.id)).toEqual(["anon-1"]);
  });
});


describe("mergeSavedConversation", () => {
  it("does not let a stale server save overwrite newer local messages", () => {
    const current = conversation("same", "newer");
    current.messages.push({
      id: "m2",
      role: "assistant",
      content: "new local answer",
      createdAt: 200,
    });
    current.updatedAt = 200;

    const saved = conversation("same", "older");
    saved.updatedAt = 999999;

    expect(mergeSavedConversation(current, saved)).toBe(current);
  });

  it("keeps the current copy when a save echo has the exact same timeline", () => {
    const current = conversation("same", "current");
    current.messages[0].tools = [
      {
        name: "calculator",
        argument: "2 + 2",
        ok: true,
        summary: "4",
      },
    ];

    const saved = conversation("same", "saved echo");

    expect(mergeSavedConversation(current, saved)).toBe(current);
  });

  it("prefers the newer message timeline during server reconciliation", async () => {
    const { conversationStamp } = await freshStorage();

    const local = conversation("same", "local");
    local.messages.push({
      id: "m2",
      role: "assistant",
      content: "new local answer",
      createdAt: 200,
    });

    const staleServer = conversation("same", "server");
    staleServer.updatedAt = 999999;

    expect(conversationStamp(local)).toBe(200);
    expect(conversationStamp(staleServer)).toBe(1);
  });

  it("will not let a copy that lost a turn overwrite the copy that has it", () => {
    /*
     * The tab that deleted an answer and the tab that never received it hold the
     * same first turns, so nothing in the row tells the two apart. Reading it as
     * a deletion would let a stale tab erase another device's newest turn for the
     * whole account, so the copy holding more turns wins. Pinned here because it
     * looks exactly like a bug worth "fixing".
     */
    const shorter = conversation("same", "local");
    const longer = conversation("same", "server");

    longer.messages.push({
      id: "m2",
      role: "assistant",
      content: "an answer this tab never saw",
      createdAt: 200,
    });

    expect(mergeSavedConversation(shorter, longer)).toBe(longer);
  });
});
