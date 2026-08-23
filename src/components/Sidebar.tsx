"use client";

import { useState } from "react";
import { useUser, UserButton } from "@clerk/nextjs";
import { CloseIcon, GearIcon, PlusIcon, TrashIcon } from "./Icons";
import type { Conversation, Project, ServerStatus } from "@/lib/client/types";

const NAV_HINTS: { label: string; hint: string }[] = [
  { label: "Agents", hint: "Agent mode plans, runs tools, then answers. Pick it in the composer." },
  { label: "Tools", hint: "Tools run on the server and are listed below." },
  { label: "Models", hint: "Only providers with a configured key appear in the model picker." },
];

export default function Sidebar({
  open,
  onClose,
  conversations,
  activeId,
  projects,
  activeProjectId,
  status,
  onNewChat,
  onSelect,
  onDelete,
  onSelectProject,
  onOpenSettings,
}: {
  open: boolean;
  onClose: () => void;
  conversations: Conversation[];
  activeId: string | undefined;
  projects: Project[];
  activeProjectId: string;
  status: ServerStatus | undefined;
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onSelectProject: (id: string) => void;
  onOpenSettings: () => void;
}) {
  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="Close sidebar"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-transform md:static md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-[var(--accent)] to-[var(--accent2)] text-sm font-bold text-black">
              O
            </span>
            <span className="font-semibold tracking-tight">OmniAgent</span>
          </div>
          <button type="button" onClick={onClose} className="text-[var(--muted)] md:hidden" aria-label="Close sidebar">
            <CloseIcon />
          </button>
        </div>

        <div className="p-3">
          <button
            type="button"
            onClick={onNewChat}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[var(--accent2)] px-3 py-2 text-sm font-medium text-black transition hover:opacity-90"
          >
            <PlusIcon />
            New chat
          </button>
        </div>

        <div className="px-3 pb-2">
          <label className="text-[11px] uppercase tracking-wide text-[var(--muted)]" htmlFor="project-select">
            Project
          </label>
          <select
            id="project-select"
            value={activeProjectId}
            onChange={(event) => onSelectProject(event.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          <p className="px-2 py-2 text-[11px] uppercase tracking-wide text-[var(--muted)]">Chats</p>
          {conversations.length === 0 ? (
            <p className="px-2 text-xs text-[var(--muted)]">No conversations in this project yet.</p>
          ) : null}
          <ul className="space-y-1">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <div
                  className={`group flex items-center gap-1 rounded-lg px-2 ${
                    conversation.id === activeId ? "bg-[var(--surface-2)]" : "hover:bg-[var(--surface-2)]/60"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(conversation.id)}
                    className="flex-1 truncate py-2 text-left text-sm"
                  >
                    {conversation.title}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(conversation.id)}
                    aria-label={`Delete ${conversation.title}`}
                    className="text-[var(--muted)] opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-4 space-y-2 px-2 pb-4 text-[11px] text-[var(--muted)]">
            {NAV_HINTS.map((item) => (
              <p key={item.label}>
                <span className="font-medium text-[var(--foreground)]">{item.label}:</span> {item.hint}
              </p>
            ))}
            {status ? (
              <>
                <p>
                  <span className="font-medium text-[var(--foreground)]">Providers:</span>{" "}
                  {status.providers.map((provider) => provider.label).join(", ") || "none configured"}
                </p>
                <p>
                  <span className="font-medium text-[var(--foreground)]">Tools:</span>{" "}
                  {status.tools.map((tool) => tool.name).join(", ")}
                </p>
                <p>
                  <span className="font-medium text-[var(--foreground)]">Search:</span> {status.searchEngine}
                </p>
              </>
            ) : null}
          </div>
        </div>

        <AccountRow />
        <button
          type="button"
          onClick={onOpenSettings}
          className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-3 text-sm text-[var(--muted)] transition hover:text-[var(--foreground)]"
        >
          <GearIcon />
          Settings & privacy
        </button>
      </aside>
    </>
  );
}

function AccountRow() {
  const { user, isLoaded } = useUser();
  const [loadingCheckout, setLoadingCheckout] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isLoaded || !user) return null;

  const plan = user.publicMetadata?.plan === "paid" ? "paid" : "free";

  const upgrade = async () => {
    setError(null);
    setLoadingCheckout(true);
    try {
      const response = await fetch("/api/stripe/checkout", { method: "POST" });
      const data = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !data.url) throw new Error(data.error ?? "couldn't start checkout");
      window.location.href = data.url;
    } catch (err) {
      setError((err as Error).message);
      setLoadingCheckout(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-3">
      <div className="flex items-center gap-2">
        <UserButton />
        <span className="text-xs text-[var(--muted)]">{plan === "paid" ? "Paid plan" : "Free plan"}</span>
      </div>
      {plan === "free" ? (
        <button
          type="button"
          onClick={upgrade}
          disabled={loadingCheckout}
          className="rounded-full bg-gradient-to-br from-[var(--accent)] to-[var(--accent2)] px-3 py-1 text-xs font-medium text-black disabled:opacity-50"
        >
          {loadingCheckout ? "Loading..." : "Upgrade"}
        </button>
      ) : null}
      {error ? <span className="text-xs text-red-400">{error}</span> : null}
    </div>
  );
}

