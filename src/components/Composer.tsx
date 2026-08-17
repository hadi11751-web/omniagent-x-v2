"use client";

import { useRef } from "react";
import { SendIcon, StopIcon } from "./Icons";
import type { Mode } from "@/lib/client/types";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "chat", label: "Chat", hint: "Normal chat, tools available on demand" },
  { id: "research", label: "Research", hint: "Search the web first, then answer with sources" },
  { id: "agent", label: "Agent", hint: "Plan, run tools, then answer" },
  { id: "blend", label: "Blend", hint: "Ask several providers and synthesise" },
];

export default function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  mode,
  onModeChange,
  toolsEnabled,
  onToolsToggle,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  toolsEnabled: boolean;
  onToolsToggle: (enabled: boolean) => void;
  disabled: boolean;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);

  const resize = () => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  };

  return (
    <div className="border-t border-[var(--border)] bg-[var(--background)]/80 backdrop-blur">
      <div className="mx-auto w-full max-w-3xl px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.hint}
              onClick={() => onModeChange(item.id)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                mode === item.id
                  ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--foreground)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {item.label}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-2 text-xs text-[var(--muted)]">
            <input
              type="checkbox"
              checked={toolsEnabled}
              onChange={(event) => onToolsToggle(event.target.checked)}
              className="accent-[var(--accent)]"
            />
            Tools
          </label>
        </div>

        <div className="flex items-end gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2 focus-within:border-[var(--accent)]">
          <textarea
            ref={textarea}
            value={value}
            rows={1}
            placeholder="Ask OmniAgent..."
            disabled={disabled}
            onChange={(event) => {
              onChange(event.target.value);
              resize();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            }}
            className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
          />
          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              className="grid h-9 w-9 place-items-center rounded-xl border border-[var(--border)] bg-[var(--surface-2)] text-[var(--foreground)]"
              aria-label="Stop generating"
            >
              <StopIcon className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={disabled || !value.trim()}
              className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent2)] text-black disabled:opacity-40"
              aria-label="Send message"
            >
              <SendIcon />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--muted)]">
          Enter sends, Shift+Enter adds a line. Answers can be wrong - verify anything important.
        </p>
      </div>
    </div>
  );
}
