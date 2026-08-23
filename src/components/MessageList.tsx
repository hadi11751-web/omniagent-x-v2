"use client";

/* eslint-disable @next/next/no-img-element -- generated images arrive as data URLs */
import { useEffect, useRef } from "react";
import CopyButton from "./CopyButton";
import Markdown from "./Markdown";
import { RefreshIcon } from "./Icons";
import type { UiMessage } from "@/lib/client/types";

const EXECUTION_BADGE = {
  cloud: { label: "Cloud", icon: "\u2601" },
  local: { label: "Local", icon: "\uD83D\uDD12" },
} as const;

function MetaLine({ message }: { message: UiMessage }) {
  if (!message.meta) return null;
  const badge = EXECUTION_BADGE[message.meta.execution];
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)]">
      <span className="rounded-full border border-[var(--border)] px-2 py-0.5">
        {badge.icon} {badge.label}
      </span>
      <span>
        {message.meta.model} - {message.meta.provider}
      </span>
      {message.meta.mode !== "chat" && <span>mode: {message.meta.mode}</span>}
      {message.meta.capability && <span>routed: {message.meta.capability}</span>}
    </div>
  );
}

export default function MessageList({
  messages,
  streaming,
  onRegenerate,
}: {
  messages: UiMessage[];
  streaming: boolean;
  onRegenerate: () => void;
}) {
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streaming]);

  const lastAssistantId = [...messages].reverse().find((message) => message.role === "assistant")?.id;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
      {messages.map((message) => (
        <article
          key={message.id}
          className={
            message.role === "user"
              ? "omni-fade ml-auto max-w-[85%] rounded-2xl rounded-br-sm border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-[0.95rem] whitespace-pre-wrap"
              : "omni-fade max-w-full rounded-2xl rounded-bl-sm border border-[var(--border)] bg-[var(--surface)]/80 px-4 py-3"
          }
        >
          {message.role === "assistant" ? (
            <div className="flex flex-col gap-3">
              <MetaLine message={message} />

              {message.status?.map((line, index) => (
                <p key={`${message.id}-status-${index}`} className="text-xs text-[var(--muted)]">
                  {line}
                </p>
              ))}

              {message.tools?.map((tool, index) => (
                <div
                  key={`${message.id}-tool-${index}`}
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    tool.ok
                      ? "border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]"
                      : "border-red-900/60 bg-red-950/30 text-red-300"
                  }`}
                >
                  <span className="font-mono text-[var(--accent2)]">{tool.name}</span>
                  <span className="text-[var(--muted)]"> ({tool.argument.slice(0, 120)})</span>
                  <p className="mt-1 whitespace-pre-wrap">{tool.summary}</p>
                </div>
              ))}

              {message.content ? <Markdown content={message.content} /> : null}

              {streaming && message.id === lastAssistantId && !message.error ? (
                <span className="omni-caret" aria-label="generating" />
              ) : null}

              {message.images?.map((image, index) => (
                <img
                  key={`${message.id}-image-${index}`}
                  src={image}
                  alt="Generated image"
                  className="w-full max-w-md rounded-xl border border-[var(--border)]"
                />
              ))}

              {message.files?.map((file, index) => (
                <a
                  key={`${message.id}-file-${index}`}
                  href={file.dataUrl}
                  download={file.filename}
                  className="flex w-fit items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-medium hover:border-[var(--accent)]"
                >
                  📄 {file.filename}
                  <span className="text-[var(--muted)]">Download</span>
                </a>
              ))}

              {message.sources?.length ? (
                <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
                  <p className="mb-1 text-xs uppercase tracking-wide text-[var(--muted)]">Sources</p>
                  <ol className="list-decimal space-y-1 pl-5 text-xs">
                    {message.sources.map((source) => (
                      <li key={source.url}>
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-[var(--accent2)] underline"
                        >
                          {source.title}
                        </a>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {message.error ? (
                <p className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">
                  {message.error}
                </p>
              ) : null}

              {!streaming && !message.content && !message.error ? (
                <p className="text-xs text-[var(--muted)]">No answer was generated. Try Regenerate.</p>
              ) : null}

              {!streaming && (message.content || message.id === lastAssistantId) ? (
                <div className="flex items-center gap-2 pt-1">
                  {message.content ? <CopyButton text={message.content} /> : null}
                  {message.id === lastAssistantId ? (
                    <button
                      type="button"
                      onClick={onRegenerate}
                      className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--muted)] transition hover:text-[var(--foreground)]"
                    >
                      <RefreshIcon className="h-3.5 w-3.5" />
                      Regenerate
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            message.content
          )}
        </article>
      ))}
      <div ref={bottom} />
    </div>
  );
}

