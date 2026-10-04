import { MAX_CONVERSATIONS } from "@/lib/limits";
import type { Conversation, Mode, Project, Settings } from "./types";

const KEYS = {
  conversations: "omniagent.conversations.v1",
  projects: "omniagent.projects.v1",
  settings: "omniagent.settings.v1",
  deletions: "omniagent.deleted-conversations.v1",
  wipePending: "omniagent.conversations.wipe-pending.v1",
} as const;

type KeyName = keyof typeof KEYS;

/**
 * Which account the names below resolve to, or `undefined` while the app does
 * not know yet.
 *
 * Every key used to be a bare constant, so all the accounts that ever signed in
 * on one browser shared one conversation list, one project set, one settings
 * blob and one queue of owed deletes: signing out and back in as somebody else
 * opened the previous person's saved chats, and their pending deletions were
 * spent against this person's history. The keys carry the Clerk user id instead.
 *
 * A visitor with no session keeps the unkeyed names, because that data has no
 * account to belong to yet - and it is what the first signed-in account on this
 * browser adopts, rather than strands.
 */
let scope: string | null | undefined;

/** Marks the one-time move of the unkeyed data, so it is never copied twice. */
const ADOPTED = "omniagent.storage.per-account.v1";

/**
 * Call this with `user?.id ?? null` once Clerk has loaded, before reading or
 * writing anything. While the scope is unset, reads return their fallback and
 * writes are dropped: a request that arrives before Clerk has settled has no
 * business touching another account's rows.
 */
export function setStorageScope(userId: string | null): void {
  if (scope === userId) return;

  scope = userId;

  if (typeof window === "undefined" || userId === null) return;

  /*
   * The unkeyed rows become this account's. They move rather than copy: leaving
   * them where the next account will read them is the same leak in a new shape,
   * and a browser with two accounts has to pick one honestly rather than show
   * each other's history.
   */
  if (window.localStorage.getItem(ADOPTED) !== null) return;

  for (const name of Object.values(KEYS)) {
    const legacy = window.localStorage.getItem(name);

    if (legacy === null) continue;

    try {
      /* An account that already has rows of its own keeps them; the unkeyed
         data is discarded rather than written over its history. */
      if (window.localStorage.getItem(`${name}.${userId}`) === null) {
        window.localStorage.setItem(`${name}.${userId}`, legacy);
      }

      window.localStorage.removeItem(name);
    } catch {
      /* storage full or blocked - the app keeps working in memory */
    }
  }

  try {
    window.localStorage.setItem(ADOPTED, "1");
  } catch {
    /* Not recorded; the worst a later account can do is find the keys empty. */
  }
}

/** What `storage` reads and writes, or `undefined` while no account is known. */
function nameOf(key: KeyName): string | undefined {
  if (scope === undefined) return undefined;

  return scope === null ? KEYS[key] : `${KEYS[key]}.${scope}`;
}

/**
 * Newest activity is determined from the message timeline first. Server saves
 * assign a fresh `updatedAt`, so using that field first can make an older server
 * snapshot look newer than local messages that were added after the save began.
 */
export function conversationStamp(conversation: Conversation): number {
  return (
    conversation.messages.at(-1)?.createdAt ??
    conversation.updatedAt ??
    conversation.createdAt ??
    0
  );
}

/** The copy with the more recent activity; a tie goes to the one holding more messages. */
function isMoreRecent(candidate: Conversation, current: Conversation): boolean {
  const candidateStamp = conversationStamp(candidate);
  const currentStamp = conversationStamp(current);

  if (candidateStamp !== currentStamp) return candidateStamp > currentStamp;

  return candidate.messages.length > current.messages.length;
}

/**
 * Server saves assign a fresh `updatedAt`, so comparing that field alone would
 * let a response from an older in-flight save look newer than the messages that
 * arrived locally after the request began. Compare the message timeline first.
 *
 * A browser copy shorter than the server's is not treated as newer: the tab that
 * deleted a turn and the tab that never received it hold byte-identical
 * prefixes, and guessing wrong here deletes the other device's turn for real.
 */
export function mergeSavedConversation(
  current: Conversation,
  saved: Conversation,
): Conversation {
  const currentMessageStamp =
    current.messages.at(-1)?.createdAt ?? current.createdAt ?? 0;
  const savedMessageStamp =
    saved.messages.at(-1)?.createdAt ?? saved.createdAt ?? 0;

  if (
    current.messages.length > saved.messages.length ||
    currentMessageStamp > savedMessageStamp
  ) {
    return current;
  }

  if (
    current.messages.length === saved.messages.length &&
    currentMessageStamp === savedMessageStamp
  ) {
    /*
     * A successful save response is normally an echo of the state this tab
     * already holds. Returning the current object on a perfect tie stops a stale
     * response from replacing same-timestamp metadata such as tool calls,
     * generated files, images, or an error flag.
     *
     * A tie produced by another device is indistinguishable from that echo here.
     * The server does not reconcile it either: `shouldReplaceStoredConversation`
     * keeps the row it already has, so the saved copy handed back to this tab is
     * the server's, and `reconcileConversations` at the next load decides which
     * one the browser shows.
     */
    return current;
  }

  return saved;
}

/**
 * What the browser and the server each know, resolved row by row.
 *
 * Two things are owed here. Deletions this browser still has to carry to the
 * server: without them a conversation the user deleted while the history
 * service was down came back on the next load, and a delete that never landed
 * left the text on the server with nobody left to ask for it. And the direction
 * a shared row resolves in: the save is debounced, so closing the tab within a
 * second or two of a reply leaves the newest messages only in localStorage. The
 * server row is then the older one, and taking the server copy verbatim dropped
 * those turns - the reload lost the very messages the user had just read. So
 * the newer row wins on both sides, and `needsUpload` names the ids where the
 * browser is the one holding the truth, so the caller can hand them back.
 */
export function reconcileConversations(
  serverConversations: Conversation[],
  localConversations: Conversation[],
  deletedIds: Iterable<string>,
): {
  conversations: Conversation[];
  pendingDeletions: string[];
  needsUpload: string[];
} {
  const deleted = new Set(deletedIds);

  const localById = new Map<string, Conversation>();

  for (const conversation of localConversations) {
    if (deleted.has(conversation.id)) continue;

    const known = localById.get(conversation.id);

    if (!known || isMoreRecent(conversation, known)) {
      localById.set(conversation.id, conversation);
    }
  }

  const needsUpload: string[] = [];

  const chosen = serverConversations
    .filter((conversation) => !deleted.has(conversation.id))
    .map((server) => {
      const local = localById.get(server.id);

      if (!local) return server;

      localById.delete(server.id);

      if (!isMoreRecent(local, server)) return server;

      needsUpload.push(server.id);

      return local;
    });

  // A local-only conversation still marked deleted was never confirmed either,
  // so it must not be re-uploaded as if it were new work.
  for (const conversation of localById.values()) needsUpload.push(conversation.id);

  const conversations = [...chosen, ...localById.values()].sort(
    (a, b) => conversationStamp(b) - conversationStamp(a),
  );

  const pendingDeletions = serverConversations
    .filter((conversation) => deleted.has(conversation.id))
    .map((conversation) => conversation.id);

  return { conversations, pendingDeletions, needsUpload };
}

export const DEFAULT_PROJECTS: Project[] = [
  { id: "general", name: "General", context: "" },
  { id: "coding", name: "Coding", context: "The user mostly asks about software engineering." },
  { id: "research", name: "Research", context: "Prefer sourced, factual answers." },
  { id: "school", name: "School", context: "Explain concepts step by step." },
  { id: "personal", name: "Personal", context: "" },
];

export const DEFAULT_SETTINGS: Settings = {
  projectId: "general",
  mode: "chat",
  toolsEnabled: true,
  saveHistory: true,
  memoryEnabled: false,
  memory: "",
};

const MODES: Mode[] = ["chat", "research", "agent"];

/**
 * Settings saved by older versions carried a model pick, an auto-route switch
 * and possibly the retired Blend mode. None of those exist any more: they are
 * dropped here so a stale browser never sends them or lands in a mode the app
 * no longer has.
 */
export function migrateSettings(stored: Record<string, unknown>): Settings {
  const { model: _model, autoRoute: _autoRoute, ...rest } = stored;
  void _model;
  void _autoRoute;

  const merged = { ...DEFAULT_SETTINGS, ...(rest as Partial<Settings>) };

  return MODES.includes(merged.mode)
    ? merged
    : { ...merged, mode: DEFAULT_SETTINGS.mode };
}

function read<T>(key: KeyName, fallback: T): T {
  const name = nameOf(key);

  if (typeof window === "undefined" || name === undefined) return fallback;

  try {
    const raw = window.localStorage.getItem(name);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: KeyName, value: unknown) {
  const name = nameOf(key);

  if (typeof window === "undefined" || name === undefined) return;

  try {
    window.localStorage.setItem(name, JSON.stringify(value));
  } catch {
    /* storage full or blocked - the app keeps working in memory */
  }
}

function forget(key: KeyName) {
  const name = nameOf(key);

  if (typeof window === "undefined" || name === undefined) return;

  window.localStorage.removeItem(name);
}

/**
 * How many owed deletes the browser may forget about at once: none.
 *
 * A tombstone is only spent when the server confirms the delete, so this holds
 * every conversation id this browser can point at: the rows the server returns
 * (`MAX_CONVERSATIONS`) plus the local rows merged alongside them (the same
 * number, which is why `saveConversations` trims to it). A ceiling below the two
 * combined is a ceiling at which owed deletes start going unrecorded, so the
 * overflow is answered by a flag rather than by dropping ids.
 */
export const MAX_PENDING_DELETIONS = 2 * MAX_CONVERSATIONS;

export const storage = {
  loadConversations: () => read<Conversation[]>("conversations", []),
  /**
   * Keeps the same ceiling the server keeps, so the history this browser shows
   * and the history it can load back are bounded by one documented number
   * instead of growing until the storage quota fails silently.
   */
  saveConversations: (conversations: Conversation[]) =>
    write(
      "conversations",
      [...conversations]
        .sort((a, b) => conversationStamp(b) - conversationStamp(a))
        .slice(0, MAX_CONVERSATIONS),
    ),
  clearConversations: () => forget("conversations"),
  loadDeletions: () => read<string[]>("deletions", []),
  /*
   * Bounded at `MAX_PENDING_DELETIONS`, and trimmed to the ceiling rather than
   * dropped: once the list is full a delete genuinely cannot be recorded, so the
   * flag says what the next successful load has to do instead — clear the
   * account's server history in one request. Silently slicing the oldest ids out
   * was how a deleted conversation came back as restored history.
   */
  saveDeletions: (ids: string[]) => {
    if (ids.length <= MAX_PENDING_DELETIONS) {
      write("deletions", ids);

      return;
    }

    write("deletions", ids.slice(0, MAX_PENDING_DELETIONS));
    write("wipePending", true);
  },
  loadWipePending: () => read<boolean>("wipePending", false),
  clearWipePending: () => forget("wipePending"),
  clearDeletions: () => forget("deletions"),
  loadProjects: () => read<Project[]>("projects", DEFAULT_PROJECTS),
  saveProjects: (projects: Project[]) => write("projects", projects),
  loadSettings: () => migrateSettings(read<Record<string, unknown>>("settings", {})),
  saveSettings: (settings: Settings) => write("settings", settings),
};

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 42 ? `${clean.slice(0, 42)}...` : clean || "New chat";
}
