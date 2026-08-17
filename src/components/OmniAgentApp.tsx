"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Composer from "./Composer";
import MessageList from "./MessageList";
import SettingsPanel from "./SettingsPanel";
import Sidebar from "./Sidebar";
import { GearIcon, MenuIcon } from "./Icons";
import { sendChat } from "@/lib/client/chatClient";
import { DEFAULT_SETTINGS, newId, storage, titleFrom } from "@/lib/client/storage";
import type { Conversation, Mode, Project, ServerStatus, Settings, UiMessage } from "@/lib/client/types";
import type { Capability, ChatMessage } from "@/lib/types";

const SUGGESTIONS = [
  "Explain what OmniAgent can do in three bullet points",
  "Write a TypeScript debounce hook with tests",
  "Search the web for this week's AI news and cite sources",
  "Compute (1200 * 1.07) ^ 3 exactly",
];

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
  const [loaded, setLoaded] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    setConversations(storage.loadConversations());
    setProjects(storage.loadProjects());
    setSettings(storage.loadSettings());
    setLoaded(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/status")
      .then((response) => response.json())
      .then((data: ServerStatus) => {
        if (cancelled) return;
        setStatus(data);
        setSettings((current) => {
          if (current.model && data.models.some((model) => model.id === current.model)) return current;
          return { ...current, model: data.models[0]?.id ?? "" };
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (settings.saveHistory) storage.saveConversations(conversations);
  }, [conversations, settings.saveHistory, loaded]);

  useEffect(() => {
    if (loaded) storage.saveSettings(settings);
  }, [settings, loaded]);

  useEffect(() => {
    if (loaded) storage.saveProjects(projects);
  }, [projects, loaded]);

  const activeProjectId = settings.projectId;

  const visibleConversations = useMemo(
    () => conversations.filter((conversation) => conversation.projectId === activeProjectId),
    [conversations, activeProjectId],
  );
  const active = conversations.find((conversation) => conversation.id === activeId);
  const messages = active?.messages ?? [];
  const noProvider = status !== undefined && status.models.length === 0;

  const patchSettings = (patch: Partial<Settings>) => setSettings((current) => ({ ...current, ...patch }));

  const updateMessages = useCallback(
    (conversationId: string, update: (messages: UiMessage[]) => UiMessage[]) => {
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
      const placeholder: UiMessage = { id: assistantId, role: "assistant", content: "" };
      updateMessages(conversationId, (current) => [...current, placeholder]);

      const patch = (mutate: (message: UiMessage) => UiMessage) =>
        updateMessages(conversationId, (current) =>
          current.map((message) => (message.id === assistantId ? mutate(message) : message)),
        );

      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);

      const payload: ChatMessage[] = history.map((message) => ({
        role: message.role,
        content: message.content,
      }));

      try {
        await sendChat({
          messages: payload,
          model: settings.model,
          mode: settings.mode,
          autoRoute: settings.autoRoute,
          toolsEnabled: settings.toolsEnabled,
          memory: settings.memoryEnabled ? settings.memory : undefined,
          projectContext: project?.context,
          signal: controller.signal,
          onEvent: (event) => {
            switch (event.type) {
              case "meta":
                patch((message) => ({
                  ...message,
                  meta: {
                    model: event.model,
                    provider: event.provider,
                    execution: event.execution,
                    capability: event.capability as Capability | undefined,
                    mode: event.mode as Mode,
                  },
                }));
                break;
              case "status":
                patch((message) => ({ ...message, status: [...(message.status ?? []), event.text] }));
                break;
              case "delta":
                patch((message) => ({ ...message, content: message.content + event.text }));
                break;
              case "tool":
                patch((message) => ({
                  ...message,
                  tools: [
                    ...(message.tools ?? []),
                    { name: event.name, argument: event.argument, ok: event.ok, summary: event.summary },
                  ],
                }));
                break;
              case "sources":
                patch((message) => ({ ...message, sources: [...(message.sources ?? []), ...event.sources] }));
                break;
              case "image":
                patch((message) => ({ ...message, images: [...(message.images ?? []), event.dataUrl] }));
                break;
              case "error":
                patch((message) => ({ ...message, error: event.message }));
                break;
              case "done":
                break;
            }
          },
        });
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          patch((message) => ({ ...message, error: (error as Error).message }));
        }
      } finally {
        setStreaming(false);
        abortRef.current = undefined;
      }
    },
    [activeProjectId, projects, settings, updateMessages],
  );

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming) return;
      setInput("");

      const userMessage: UiMessage = { id: newId(), role: "user", content };
      let conversationId = activeId;
      let history: UiMessage[] = [];

      if (!conversationId || !conversations.some((conversation) => conversation.id === conversationId)) {
        conversationId = newId();
        const conversation: Conversation = {
          id: conversationId,
          title: titleFrom(content),
          projectId: activeProjectId,
          createdAt: Date.now(),
          messages: [userMessage],
        };
        history = [userMessage];
        setConversations((current) => [conversation, ...current]);
        setActiveId(conversationId);
      } else {
        const existing = conversations.find((conversation) => conversation.id === conversationId);
        history = [...(existing?.messages ?? []), userMessage];
        updateMessages(conversationId, (current) => [...current, userMessage]);
        if (existing && existing.messages.length === 0) {
          setConversations((current) =>
            current.map((conversation) =>
              conversation.id === conversationId ? { ...conversation, title: titleFrom(content) } : conversation,
            ),
          );
        }
      }

      await run(conversationId, history);
    },
    [activeId, activeProjectId, conversations, run, streaming, updateMessages],
  );

  const regenerate = useCallback(async () => {
    if (!active || streaming) return;
    const lastUserIndex = [...active.messages].map((message) => message.role).lastIndexOf("user");
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
    setConversations((current) => current.filter((conversation) => conversation.id !== id));
    if (activeId === id) setActiveId(undefined);
  };

  const deleteAll = () => {
    setConversations([]);
    storage.clearConversations();
    setActiveId(undefined);
  };

  const currentModelLabel =
    status?.models.find((model) => model.id === settings.model)?.label ?? "no model configured";

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
            <select
              value={settings.model}
              onChange={(event) => patchSettings({ model: event.target.value })}
              disabled={!status || status.models.length === 0 || settings.autoRoute}
              className="max-w-[220px] truncate rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs outline-none focus:border-[var(--accent)] disabled:opacity-60"
              aria-label="Model"
            >
              {status?.models.length ? (
                status.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.execution === "local" ? "\u{1F512}" : "\u2601"} {model.label}
                  </option>
                ))
              ) : (
                <option value="">{currentModelLabel}</option>
              )}
            </select>
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

        {noProvider ? (
          <p className="border-b border-amber-900/50 bg-amber-950/30 px-4 py-2 text-xs text-amber-200">
            No AI provider is configured. Copy <code>.env.example</code> to <code>.env.local</code>, add a key such as{" "}
            <code>GROQ_API_KEY</code>, then restart the dev server.
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
                Chat, research with sources, run tools, or plan with agent mode. Model:{" "}
                <span className="text-[var(--foreground)]">{settings.autoRoute ? "automatic routing" : currentModelLabel}</span>
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
            <MessageList messages={messages} streaming={streaming} onRegenerate={regenerate} />
          )}
        </div>

        <Composer
          value={input}
          onChange={setInput}
          onSend={() => send(input)}
          onStop={stop}
          streaming={streaming}
          mode={settings.mode}
          onModeChange={(mode) => patchSettings({ mode })}
          toolsEnabled={settings.toolsEnabled}
          onToolsToggle={(toolsEnabled) => patchSettings({ toolsEnabled })}
          disabled={noProvider}
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
            current.map((project) => (project.id === activeProjectId ? { ...project, context } : project)),
          )
        }
        onDeleteAllChats={deleteAll}
      />
    </div>
  );
}
