"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import Composer from "./Composer";
import MessageList from "./MessageList";
import SettingsPanel from "./SettingsPanel";
import Sidebar from "./Sidebar";
import { GearIcon, MenuIcon } from "./Icons";
import { sendChat } from "@/lib/client/chatClient";
import { fitImageBudget } from "@/lib/client/images";
import {
  forgetAllAutomaticMemories,
  forgetAutomaticMemory,
  listAutomaticMemories,
  saveAutomaticMemory,
} from "@/lib/client/memoryClient";
import {
  deleteAllServerConversations,
  deleteServerConversation,
  loadServerConversations,
  saveServerConversation,
} from "@/lib/client/conversationClient";
import {
  mergeSavedConversation,
  reconcileConversations,
  DEFAULT_SETTINGS,
  newId,
  setStorageScope,
  storage,
  titleFrom,
} from "@/lib/client/storage";
import type { Conversation, Mode, Project, ServerStatus, Settings, UiMessage } from "@/lib/client/types";
import type { ClientMemory } from "@/lib/client/memoryClient";
import type { ChatMessage } from "@/lib/types";

const SUGGESTIONS = [
  "Explain what OmniAgent can do in three bullet points",
  "Write a TypeScript debounce hook with tests",
  "Search the web for this week's AI news and cite sources",
  "Compute (1200 * 1.07) ^ 3 exactly",
];

const MEMORY_EMPTY = "Nothing is remembered right now.";
const MEMORY_SIGNED_OUT =
  "Automatic memory belongs to an account, so nothing is stored while this browser is signed out.";
const MEMORY_UNREADABLE =
  "The remembered facts could not be read from the server. Close and reopen settings to try again.";

/*
 * A history service that answers 503 for a minute should not strand the tab that
 * opened during it, but one that is gone for the day should not be knocked on
 * every few seconds either, so the recovery attempts are bounded.
 */
const HISTORY_RETRY_DELAY_MS = 5_000;
const HISTORY_EXTRA_ATTEMPTS = 2;

export default function OmniAgentApp() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<ServerStatus | undefined>(undefined);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memories, setMemories] = useState<ClientMemory[]>([]);
  const [memoryNotice, setMemoryNotice] = useState(MEMORY_EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [hydratedAccountId, setHydratedAccountId] = useState<string | null | undefined>(undefined);
  const [serverPersistence, setServerPersistence] = useState(false);

  const abortRef = useRef<AbortController | undefined>(undefined);
  const dirtyIdsRef = useRef(new Set<string>());
  const deletedIdsRef = useRef(new Set<string>());
  const conversationsRef = useRef<Conversation[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveInFlightRef = useRef(new Map<string, number>());

  const { user, isLoaded: accountIsReady } = useUser();
  const accountId = user?.id ?? null;

  /*
   * Read after an `await` to notice a sign-out that happened while a request was
   * in flight. Written from an effect and not during render: React is free to
   * run a render it then throws away, and a render must not change anything
   * outside the component. Every reader here resumes on a later task than the
   * effect below, so it still sees the current account.
   */
  const accountIdRef = useRef<string | null>(null);

  useEffect(() => {
    accountIdRef.current = accountId;
  }, [accountId]);

  /*
   * The browser's saved rows are keyed per account, so this cannot run on mount
   * any more than the server merge below can: until Clerk has said who is here,
   * every name `storage` uses resolves to nothing, and signing out and back in as
   * somebody else in the same tab has to rebuild the list from that account's
   * keys rather than keep showing the previous one's.
   */
  useEffect(() => {
    if (!accountIsReady) return;

    /*
     * `hydratedAccountId` is only ever assigned at the end of this effect, so the
     * persistence effects below - which run from this same commit and still hold
     * the previous account's state - compare it against `accountId`, see the
     * mismatch, and skip. That is what stops the old account's rows being written
     * under the new account's storage keys.
     */
    setStorageScope(accountId);

    abortRef.current?.abort();
    abortRef.current = undefined;
    dirtyIdsRef.current = new Set();
    deletedIdsRef.current = new Set();
    saveInFlightRef.current.clear();
    setInput("");
    setActiveId(undefined);
    setMemories([]);
    setMemoryNotice(accountId ? MEMORY_EMPTY : MEMORY_SIGNED_OUT);

    const localConversations = storage.loadConversations();
    conversationsRef.current = localConversations;
    setConversations(localConversations);
    setProjects(storage.loadProjects());
    setSettings(storage.loadSettings());

    for (const id of storage.loadDeletions()) {
      deletedIdsRef.current.add(id);
    }

    // The new account's history service has not been read yet.
    setServerPersistence(false);
    setLoaded(true);
    setHydratedAccountId(accountId);
  }, [accountIsReady, accountId]);

  /*
   * Read by the merge below, which runs once and must see the list as it stands
   * then rather than the one captured when it was scheduled.
   */
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  /**
   * Carries a deletion through to the server and forgets it once confirmed. A
   * server that was unreachable when Delete was pressed would otherwise keep the
   * conversation, and show it again on the next load.
   */
  const deleteOnServer = useCallback(async (id: string) => {
    const ownerAccountId = accountId;

    /*
     * A signed-out browser has no server row to delete and nothing owed later, so
     * the local delete it already made is the whole operation. Callers only reach
     * here through the server-history path, which needs an account anyway.
     */
    if (!ownerAccountId) return;

    try {
      await deleteServerConversation(id);

      // A sign-out/account switch may happen while the request is in flight.
      // Never let the old account's completion clear a tombstone belonging to
      // the new account.
      if (accountIdRef.current !== ownerAccountId) return;

      // Keep the tombstone while an older autosave is still in flight. That
      // save will issue a final delete before the tombstone is cleared.
      if ((saveInFlightRef.current.get(id) ?? 0) === 0) {
        deletedIdsRef.current.delete(id);
        storage.saveDeletions([...deletedIdsRef.current]);
      }
    } catch {
      /* Still owed. The next load asks again. */
    }
  }, [accountId]);

  useEffect(() => {
    if (!loaded || !settings.saveHistory || serverPersistence) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;

    const load = async (): Promise<void> => {
      try {
        const serverConversations = await loadServerConversations();
        if (cancelled) return;

        const merged = reconcileConversations(
          serverConversations,
          conversationsRef.current,
          deletedIdsRef.current,
        );

        /*
         * Rows the browser holds and the server does not have in that state:
         * never sent, or sent before the newest turns were saved. They go back
         * through the ordinary save path so a tab closed a second after a reply
         * does not leave those messages stranded in this browser's storage.
         */
        for (const id of merged.needsUpload) {
          dirtyIdsRef.current.add(id);
        }

        setConversations(merged.conversations);

        /*
         * Overflowing the tombstone list means a delete could not be recorded at
         * all, so the owed set is no longer the truth about what this browser
         * deleted. The account's whole server history goes instead: under this
         * app's single-workspace model nothing else can be reading it, and
         * leaving rows the user already deleted behind is the worse way to be
         * wrong about a delete.
         */
        if (storage.loadWipePending()) {
          try {
            await deleteAllServerConversations();

            if (cancelled) return;

            deletedIdsRef.current.clear();
            storage.saveDeletions([]);
            storage.clearWipePending();
            setServerPersistence(true);

            return;
          } catch {
            /*
             * Unreachable history service. The wipe flag stays set, so the owed
             * delete is attempted again the next time this account loads.
             */
          }
        }

        for (const id of merged.pendingDeletions) {
          void deleteOnServer(id);
        }

        setServerPersistence(true);
      } catch {
        if (cancelled) return;

        /*
         * A transient Clerk/Upstash/network failure used to leave persistence
         * disabled for the rest of the session, so a one-minute outage stranded a
         * tab behind a history it could see locally but never sync again. Retry a
         * bounded number of times instead: an open tab must not knock on a history
         * service that is gone for the day, once per request interval, forever.
         * Giving up costs nothing but server sync until the next load.
         */
        if (retries >= HISTORY_EXTRA_ATTEMPTS) return;

        retries += 1;
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void load();
        }, HISTORY_RETRY_DELAY_MS);
      }
    };

    void load();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [deleteOnServer, loaded, serverPersistence, settings.saveHistory]);

  /*
   * The remembered facts live on the server, so they are read when the panel
   * opens rather than tracked through every chat: a turn is remembered on the
   * way out of a request, and a closed settings panel has nobody looking at its
   * list. Nothing is fetched for a signed-out browser - automatic memory
   * belongs to an account, and the route would only answer 401.
   */
  useEffect(() => {
    if (!settingsOpen || !accountIsReady) return;

    if (!accountId) {
      setMemories([]);
      setMemoryNotice(MEMORY_SIGNED_OUT);
      return;
    }

    let cancelled = false;

    void listAutomaticMemories().then(
      (stored) => {
        if (cancelled) return;
        setMemories(stored);
        setMemoryNotice(MEMORY_EMPTY);
      },
      () => {
        if (cancelled) return;
        setMemories([]);
        setMemoryNotice(MEMORY_UNREADABLE);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [accountIsReady, accountId, settingsOpen]);

  const forgetMemory = useCallback(
    async (id: string) => {
      const ownerAccountId = accountId;

      /*
       * A button in this panel is a request to forget, so a no-op has to say so:
       * a signed-out browser would otherwise sit there showing the old list.
       */
      if (!ownerAccountId) {
        setMemoryNotice(MEMORY_SIGNED_OUT);
        return;
      }

      try {
        const next = await forgetAutomaticMemory(id);
        if (accountIdRef.current !== ownerAccountId) return;
        setMemories(next);
        setMemoryNotice(MEMORY_EMPTY);
      } catch {
        if (accountIdRef.current === ownerAccountId) {
          setMemoryNotice(MEMORY_UNREADABLE);
        }
      }
    },
    [accountId],
  );

  const forgetEveryMemory = useCallback(async () => {
    const ownerAccountId = accountId;

    if (!ownerAccountId) {
      setMemoryNotice(MEMORY_SIGNED_OUT);
      return;
    }

    try {
      await forgetAllAutomaticMemories();
      if (accountIdRef.current !== ownerAccountId) return;
      setMemories([]);
      setMemoryNotice(MEMORY_EMPTY);
    } catch {
      if (accountIdRef.current === ownerAccountId) {
        setMemoryNotice(MEMORY_UNREADABLE);
      }
    }
  }, [accountId]);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/status")
      .then((response) => response.json())
      .then((data: ServerStatus) => {
        if (cancelled) return;
        setStatus(data);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded || hydratedAccountId !== accountId || !settings.saveHistory) return;

    storage.saveConversations(conversations);
  }, [accountId, conversations, hydratedAccountId, loaded, settings.saveHistory]);

  useEffect(() => {
    if (
      !loaded ||
      !serverPersistence ||
      hydratedAccountId !== accountId ||
      !settings.saveHistory
    ) return;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(() => {
      const saveAccountId = accountId;
      const ids = [...dirtyIdsRef.current];
      dirtyIdsRef.current.clear();

      if (!ids.length) return;

      const currentById = new Map(
        conversations.map((conversation) => [conversation.id, conversation]),
      );

      void Promise.all(
        ids.map(async (id) => {
          const conversation = currentById.get(id);
          if (!conversation) return;

          const inFlight = (saveInFlightRef.current.get(id) ?? 0) + 1;
          saveInFlightRef.current.set(id, inFlight);

          try {
            const saved = await saveServerConversation(conversation);

            if (accountIdRef.current !== saveAccountId) return;

            if (deletedIdsRef.current.has(saved.id)) {
              return;
            }

            setConversations((current) =>
              current.map((candidate) => {
                if (candidate.id !== saved.id) return candidate;

                const merged = mergeSavedConversation(candidate, saved);

                if (merged === candidate) {
                  // The save response represented an older snapshot. Keep the
                  // newer browser copy dirty so the next debounced pass writes
                  // it back instead of silently losing those messages.
                  dirtyIdsRef.current.add(candidate.id);
                }

                return merged;
              }),
            );
          } catch {
            if (
              accountIdRef.current === saveAccountId &&
              !deletedIdsRef.current.has(id)
            ) {
              dirtyIdsRef.current.add(id);
            }
          } finally {
            if (accountIdRef.current !== saveAccountId) return;

            const remaining = (saveInFlightRef.current.get(id) ?? 1) - 1;
            if (remaining > 0) {
              saveInFlightRef.current.set(id, remaining);
            } else {
              saveInFlightRef.current.delete(id);
            }

            // A deletion pressed during this save wins. Re-delete once the
            // final in-flight save finishes, then allow the tombstone to clear.
            if (deletedIdsRef.current.has(id) && remaining <= 0) {
              void deleteOnServer(id);
            }
          }
        }),
      );
    }, 700);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [
    accountId,
    conversations,
    deleteOnServer,
    hydratedAccountId,
    loaded,
    serverPersistence,
    settings.saveHistory,
  ]);

  useEffect(() => {
    if (!loaded || hydratedAccountId !== accountId) return;

    storage.saveSettings(settings);
  }, [accountId, hydratedAccountId, loaded, settings]);

  useEffect(() => {
    if (!loaded || hydratedAccountId !== accountId) return;

    storage.saveProjects(projects);
  }, [accountId, hydratedAccountId, loaded, projects]);

  const activeProjectId = settings.projectId;

  const visibleConversations = useMemo(
    () => conversations.filter((conversation) => conversation.projectId === activeProjectId),
    [conversations, activeProjectId],
  );

  const active = conversations.find((conversation) => conversation.id === activeId);
  const messages = active?.messages ?? [];
  const nexusUnavailable = status !== undefined && !status.nexus.ready;

  const patchSettings = (patch: Partial<Settings>) =>
    setSettings((current) => ({ ...current, ...patch }));

  const markDirty = useCallback((conversationId: string) => {
    dirtyIdsRef.current.add(conversationId);
  }, []);

  const updateMessages = useCallback(
    (conversationId: string, update: (messages: UiMessage[]) => UiMessage[]) => {
      dirtyIdsRef.current.add(conversationId);

      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, messages: update(conversation.messages) }
            : conversation,
        ),
      );
    },
    [],
  );

  const run = useCallback(
    async (conversationId: string, history: UiMessage[]) => {
      const assistantId = newId();
      const project = projects.find((candidate) => candidate.id === activeProjectId);
      const placeholder: UiMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
      };

      updateMessages(conversationId, (current) => [...current, placeholder]);

      const patch = (mutate: (message: UiMessage) => UiMessage) =>
        updateMessages(conversationId, (current) =>
          current.map((message) =>
            message.id === assistantId ? mutate(message) : message,
          ),
        );

      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);
      let assistantText = "";

      /*
       * The only record of whether this turn stayed on the machine is the meta
       * event. It decides whether the follow-up memory extraction may leave it.
       */
      let answeredLocally = false;
      /*
       * Assistant messages carry images the model generated for the user, so
       * only user attachments are sent back as vision input. The whole replay
       * has to fit the image budget of one request.
       */
      const payload: ChatMessage[] = fitImageBudget(
        history.map((message) => ({
          role: message.role,
          content: message.content,
          images: message.role === "user" ? message.images : undefined,
        })),
      );

      try {
        await sendChat({
          messages: payload,
          mode: settings.mode,
          toolsEnabled: settings.toolsEnabled,
          memory: settings.memoryEnabled ? settings.memory : undefined,
          memoryEnabled: settings.memoryEnabled,
          projectContext: project?.context,
          signal: controller.signal,
          onEvent: (event) => {
            switch (event.type) {
              case "meta":
                answeredLocally = event.execution === "local";

                patch((message) => ({
                  ...message,
                  meta: {
                    model: event.model,
                    execution: event.execution,
                    mode: event.mode as Mode,
                  },
                }));
                break;

              case "status":
                patch((message) => ({
                  ...message,
                  status: [...(message.status ?? []), event.text],
                }));
                break;

              case "delta":
                assistantText += event.text;
                patch((message) => ({
                  ...message,
                  content: message.content + event.text,
                }));
                break;

              case "tool":
                patch((message) => ({
                  ...message,
                  tools: [
                    ...(message.tools ?? []),
                    {
                      name: event.name,
                      argument: event.argument,
                      ok: event.ok,
                      summary: event.summary,
                    },
                  ],
                }));
                break;

              case "sources":
                patch((message) => ({
                  ...message,
                  sources: [...(message.sources ?? []), ...event.sources],
                }));
                break;

              case "image":
                patch((message) => ({
                  ...message,
                  images: [...(message.images ?? []), event.dataUrl],
                }));
                break;

              case "file":
                patch((message) => ({
                  ...message,
                  files: [
                    ...(message.files ?? []),
                    {
                      dataUrl: event.dataUrl,
                      filename: event.filename,
                    },
                  ],
                }));
                break;

              case "error":
                patch((message) => ({
                  ...message,
                  error: event.message,
                }));
                break;

              case "done":
                break;
            }
          },
        });
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          patch((message) => ({
            ...message,
            error: (error as Error).message,
          }));
        }
      } finally {
        setStreaming(false);
        abortRef.current = undefined;
        markDirty(conversationId);

        if (settings.memoryEnabled && assistantText.trim()) {
          void saveAutomaticMemory(
            conversationId,
            [
              ...payload,
              {
                role: "assistant",
                content: assistantText,
              },
            ],
            answeredLocally,
          ).catch(() => undefined);
        }
      }
    },
    [activeProjectId, projects, settings, updateMessages, markDirty],
  );

  const send = useCallback(
    async (text: string, images?: string[]) => {
      const content = text.trim();
      const attachments = images ?? [];
      if ((!content && !attachments.length) || streaming) return;

      setInput("");

      const userMessage: UiMessage = {
        id: newId(),
        role: "user",
        content:
          content ||
          (attachments.length === 1 ? "What's in this image?" : "What's in these images?"),
        createdAt: Date.now(),
        images: attachments.length ? attachments : undefined,
      };

      let conversationId = activeId;
      let history: UiMessage[] = [];

      if (
        !conversationId ||
        !conversations.some((conversation) => conversation.id === conversationId)
      ) {
        conversationId = newId();

        const conversation: Conversation = {
          id: conversationId,
          title: titleFrom(content),
          projectId: activeProjectId,
          createdAt: Date.now(),
          messages: [userMessage],
        };

        history = [userMessage];

        dirtyIdsRef.current.add(conversationId);
        setConversations((current) => [conversation, ...current]);
        setActiveId(conversationId);
      } else {
        const existing = conversations.find(
          (conversation) => conversation.id === conversationId,
        );

        history = [...(existing?.messages ?? []), userMessage];

        updateMessages(conversationId, (current) => [
          ...current,
          userMessage,
        ]);

        if (existing && existing.messages.length === 0) {
          dirtyIdsRef.current.add(conversationId);

          setConversations((current) =>
            current.map((conversation) =>
              conversation.id === conversationId
                ? {
                    ...conversation,
                    title: titleFrom(content),
                  }
                : conversation,
            ),
          );
        }
      }

      await run(conversationId, history);
    },
    [
      activeId,
      activeProjectId,
      conversations,
      run,
      streaming,
      updateMessages,
    ],
  );

  const regenerate = useCallback(async () => {
    if (!active || streaming) return;

    const lastUserIndex = [...active.messages]
      .map((message) => message.role)
      .lastIndexOf("user");

    if (lastUserIndex < 0) return;

    const history = active.messages.slice(0, lastUserIndex + 1);

    updateMessages(active.id, () => history);
    await run(active.id, history);
  }, [active, run, streaming, updateMessages]);

  const stop = () => abortRef.current?.abort();

  const newChat = () => {
    setActiveId(undefined);
    setSidebarOpen(false);
  };

  const deleteConversation = (id: string) => {
    dirtyIdsRef.current.delete(id);

    /*
     * Recorded before it is asked for: the server may be unreachable, and a
     * deletion nobody remembered to make came back as history on the next load.
     */
    deletedIdsRef.current.add(id);
    storage.saveDeletions([...deletedIdsRef.current]);

    setConversations((current) =>
      current.filter((conversation) => conversation.id !== id),
    );

    if (activeId === id) setActiveId(undefined);

    if (serverPersistence) void deleteOnServer(id);
  };

  const deleteAll = () => {
    const ownerAccountId = accountId;

    dirtyIdsRef.current.clear();

    for (const conversation of conversations) {
      deletedIdsRef.current.add(conversation.id);
    }

    storage.saveDeletions([...deletedIdsRef.current]);

    setConversations([]);
    storage.clearConversations();
    setActiveId(undefined);

    if (serverPersistence) {
      void deleteAllServerConversations()
        .then(() => {
          if (accountIdRef.current !== ownerAccountId) return;

          for (const id of [...deletedIdsRef.current]) {
            if ((saveInFlightRef.current.get(id) ?? 0) === 0) {
              deletedIdsRef.current.delete(id);
            }
          }
          storage.saveDeletions([...deletedIdsRef.current]);

          // Nothing is owed any more, including an overflow request.
          storage.clearWipePending();
        })
        .catch(() => undefined);
    }
  };


  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        conversations={visibleConversations}
        activeId={activeId}
        projects={projects}
        activeProjectId={activeProjectId}
        status={status}
        onNewChat={newChat}
        onSelect={(id) => {
          setActiveId(id);
          setSidebarOpen(false);
        }}
        onDelete={deleteConversation}
        onSelectProject={(id) => {
          patchSettings({ projectId: id });
          setActiveId(undefined);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)]/60 px-4 py-3 backdrop-blur">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="text-[var(--muted)] md:hidden"
            aria-label="Open sidebar"
          >
            <MenuIcon />
          </button>

          <h1 className="text-sm font-semibold tracking-tight">OmniAgent</h1>

          <div className="ml-auto flex items-center gap-2">
            <div
              className="max-w-[220px] truncate rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs"
              aria-label="AI model"
              title="Nexus is the one AI model. It uses tools for search, files, images and memory."
            >
              {status && !status.nexus.ready ? "Nexus unavailable" : "Nexus"}
            </div>

            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="text-[var(--muted)] transition hover:text-[var(--foreground)]"
              aria-label="Open settings"
            >
              <GearIcon />
            </button>
          </div>
        </header>

        {nexusUnavailable ? (
          <p className="border-b border-amber-900/50 bg-amber-950/30 px-4 py-2 text-xs text-amber-200">
            Nexus is not configured. Copy <code>.env.example</code> to{" "}
            <code>.env.local</code>, set <code>NEXUS_MODEL</code> and{" "}
            <code>NEXUS_API_KEY</code>, then restart the server.
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-4 px-4 py-12">
              <h2 className="text-2xl font-semibold tracking-tight">
                What can I do for you
                <span className="bg-gradient-to-r from-[var(--accent)] to-[var(--accent2)] bg-clip-text text-transparent">
                  ?
                </span>
              </h2>

              <p className="text-sm text-[var(--muted)]">
                Chat, research with sources, run tools, or plan with agent
                mode. Powered by{" "}
                <span className="text-[var(--foreground)]">Nexus</span>
              </p>

              <div className="grid w-full gap-2 sm:grid-cols-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => send(suggestion)}
                    className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-left text-sm text-[var(--muted)] transition hover:border-[var(--accent)] hover:text-[var(--foreground)]"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <MessageList
              messages={messages}
              streaming={streaming}
              onRegenerate={regenerate}
            />
          )}
        </div>

        <Composer
          value={input}
          onChange={setInput}
          onSend={(images) => send(input, images)}
          onStop={stop}
          streaming={streaming}
          mode={settings.mode}
          onModeChange={(mode) => patchSettings({ mode })}
          toolsEnabled={settings.toolsEnabled}
          onToolsToggle={(toolsEnabled) =>
            patchSettings({ toolsEnabled })
          }
          disabled={nexusUnavailable}
        />
      </main>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={patchSettings}
        status={status}
        projects={projects}
        activeProjectId={activeProjectId}
        onProjectContextChange={(context) =>
          setProjects((current) =>
            current.map((project) =>
              project.id === activeProjectId
                ? { ...project, context }
                : project,
            ),
          )
        }
        onDeleteAllChats={deleteAll}
        memories={memories}
        memoryNotice={memoryNotice}
        onMemoryForget={forgetMemory}
        onMemoryClearAll={forgetEveryMemory}
      />
    </div>
  );
}
