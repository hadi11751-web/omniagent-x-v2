"use client";

import { CloseIcon } from "./Icons";
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
            <h3 className="text-xs uppercase tracking-wide text-[var(--muted)]">Routing</h3>
            <label className="flex items-center justify-between gap-3">
              <span>
                Automatic model routing
                <span className="block text-xs text-[var(--muted)]">
                  Picks a configured model based on the task (fast, coding, reasoning, research, private).
                </span>
              </span>
              <input
                type="checkbox"
                checked={settings.autoRoute}
                onChange={(event) => onChange({ autoRoute: event.target.checked })}
                className="accent-[var(--accent)]"
              />
            </label>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-[var(--muted)]">Privacy</h3>
            <label className="flex items-center justify-between gap-3">
              <span>
                Save chat history in this browser
                <span className="block text-xs text-[var(--muted)]">
                  History is stored in localStorage only. Nothing is sent anywhere except the AI provider you use.
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
              API keys stay on the server in .env.local and are never sent to the browser. Requests to cloud providers
              leave your machine; only models marked Local stay on it.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-[var(--muted)]">Memory</h3>
            <label className="flex items-center justify-between gap-3">
              <span>
                Use long-term memory
                <span className="block text-xs text-[var(--muted)]">
                  Off by default. When on, the notes below are added to every request.
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
              Clear memory
            </button>
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
                <li>Providers: {status.providers.map((provider) => `${provider.label} (${provider.execution})`).join(", ") || "none"}</li>
                <li>Models: {status.models.length}</li>
                <li>Tools: {status.tools.map((tool) => tool.name).join(", ")}</li>
                <li>Image generation: {status.imageGeneration ? "available" : "not configured"}</li>
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
