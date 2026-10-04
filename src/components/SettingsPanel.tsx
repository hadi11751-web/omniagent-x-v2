"use client";

import { CloseIcon } from "./Icons";
import type { ClientMemory } from "@/lib/client/memoryClient";
import type { Project, ServerStatus, Settings } from "@/lib/client/types";

export default function SettingsPanel({
  open,
  onClose,
  settings,
  onChange,
  status,
  projects,
  activeProjectId,
  onProjectContextChange,
  onDeleteAllChats,
  memories,
  memoryNotice,
  onMemoryForget,
  onMemoryClearAll,
}: {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  status: ServerStatus | undefined;
  projects: Project[];
  activeProjectId: string;
  onProjectContextChange: (context: string) => void;
  onDeleteAllChats: () => void;
  memories: ClientMemory[];
  memoryNotice: string;
  onMemoryForget: (id: string) => void;
  onMemoryClearAll: () => void;
}) {
  if (!open) return null;
  const project = projects.find((candidate) => candidate.id === activeProjectId);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4">
      <div className="omni-fade w-full max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings & privacy</h2>
          <button type="button" onClick={onClose} aria-label="Close settings" className="text-[var(--muted)]">
            <CloseIcon />
          </button>
        </div>

        <div className="space-y-5 text-sm">
          <section className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-[var(--muted)]">AI model</h3>
            <p>
              <strong>Nexus</strong> is the one AI model in OmniAgent. There is nothing
              to pick: Nexus does the reasoning and calls tools for web research, files
              and PDFs, images, calculations and memory when a request needs them.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-[var(--muted)]">Privacy</h3>
            <label className="flex items-center justify-between gap-3">
              <span>
                Save chat history in this browser
                <span className="block text-xs text-[var(--muted)]">
                  This browser keeps its copy in localStorage. While you are
                  signed in to a deployment with history storage configured, the
                  same conversations are also saved on that server so they
                  appear in your other browsers - &quot;Delete all
                  conversations&quot; clears both. Messages are sent to the Nexus
                  backend this deployment is configured with; enabled history, memory, authentication,
                  or billing features may also use this deployment&apos;s
                  configured Clerk, Upstash, or Stripe services.
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.saveHistory}
                onChange={(event) => onChange({ saveHistory: event.target.checked })}
                className="accent-[var(--accent)]"
              />
            </label>
            <button
              type="button"
              onClick={onDeleteAllChats}
              className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-xs text-red-300"
            >
              Delete all conversations
            </button>
            <p className="text-xs text-[var(--muted)]">
              API keys stay on the server in .env.local and are never sent to the browser. When Nexus runs on a
              cloud backend your messages leave this deployment; a local Nexus backend keeps them on it.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-[var(--muted)]">Memory</h3>
            <label className="flex items-center justify-between gap-3">
              <span>
                Use long-term memory
                <span className="block text-xs text-[var(--muted)]">
                  Off by default. When on, the notes below and the facts OmniAgent
                  has kept from your chats are added to every request. When off,
                  neither is read, whatever is stored.
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.memoryEnabled}
                onChange={(event) => onChange({ memoryEnabled: event.target.checked })}
                className="accent-[var(--accent)]"
              />
            </label>
            <textarea
              value={settings.memory}
              onChange={(event) => onChange({ memory: event.target.value })}
              rows={3}
              placeholder="Facts you want OmniAgent to remember"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2 text-sm outline-none focus:border-[var(--accent)]"
            />
            <button
              type="button"
              onClick={() => onChange({ memory: "" })}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)]"
            >
              Clear these notes
            </button>

            <h4 className="text-xs text-[var(--muted)]">
              What OmniAgent remembered from your chats
            </h4>
            {memories.length ? (
              <>
                <ul className="space-y-1">
                  {memories.map((memory) => (
                    <li
                      key={memory.id}
                      className="flex items-start justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5"
                    >
                      <span className="text-xs">{memory.fact}</span>
                      <button
                        type="button"
                        onClick={() => onMemoryForget(memory.id)}
                        className="shrink-0 rounded border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)] hover:border-[var(--accent)]"
                      >
                        Forget
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={onMemoryClearAll}
                  className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-1.5 text-xs text-red-300"
                >
                  Delete every remembered fact
                </button>
              </>
            ) : (
              <p className="text-xs text-[var(--muted)]">{memoryNotice}</p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-[var(--muted)]">
              Project context - {project?.name ?? "none"}
            </h3>
            <textarea
              value={project?.context ?? ""}
              onChange={(event) => onProjectContextChange(event.target.value)}
              rows={3}
              placeholder="Context shared by every chat in this project"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </section>

          <section className="space-y-1">
            <h3 className="text-xs uppercase tracking-wide text-[var(--muted)]">Server capabilities</h3>
            {status ? (
              <ul className="space-y-1 text-xs text-[var(--muted)]">
                <li>Nexus: {status.nexus.ready ? `ready (${status.nexus.execution} backend)` : "not configured"}</li>
                <li>Tools: {status.tools.map((tool) => tool.name).join(", ")}</li>
                <li>Image generation: {status.imageGeneration ? "available" : "not configured"}</li>
                <li>Voice input: {status.voiceInput ? "available" : "not configured"}</li>
                <li>Image/screenshot understanding: {status.visionInput ? "available" : "not configured"}</li>
                <li>Search: {status.searchEngine}</li>
              </ul>
            ) : (
              <p className="text-xs text-[var(--muted)]">Loading...</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

