"use client";

import { useEffect, useRef, useState } from "react";
import { ImageIcon, MicIcon, SendIcon, StopIcon } from "./Icons";
import type { Mode } from "@/lib/client/types";
import {
  attachmentRejection,
  IMAGE_ACCEPT_ATTRIBUTE,
  type PickedFile,
} from "@/lib/client/images";
import { audioFilename } from "@/lib/audioMime";
import { MAX_IMAGES_PER_MESSAGE } from "@/lib/limits";

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "chat", label: "Chat", hint: "Normal chat, tools available on demand" },
  { id: "research", label: "Research", hint: "Search the web first, then answer with sources" },
  { id: "agent", label: "Agent", hint: "Plan, run tools, then answer" },
];

/** An attachment the browser has already read into a data URL. */
interface Attached extends PickedFile {
  dataUrl: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("couldn't read that file"));
    reader.readAsDataURL(file);
  });
}

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
  onSend: (images?: string[]) => void;
  onStop: () => void;
  streaming: boolean;
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  toolsEnabled: boolean;
  onToolsToggle: (enabled: boolean) => void;
  disabled: boolean;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [attached, setAttached] = useState<Attached[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);

  // The recorder's onstop handler is created when recording starts, so reading
  // `value` there would clobber anything typed while the mic was open.
  const latestValue = useRef(value);

  useEffect(() => {
    latestValue.current = value;
  }, [value]);

  const clearAttachments = () => {
    setAttached([]);
    if (fileInput.current) fileInput.current.value = "";
  };

  const handleFiles = async (files: File[]) => {
    setImageError(null);
    if (!files.length) return;

    const rejection = attachmentRejection(attached, files);

    if (rejection) {
      setImageError(rejection);
      return;
    }

    try {
      const read = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type,
          size: file.size,
          dataUrl: await readAsDataUrl(file),
        })),
      );

      setAttached((current) => [...current, ...read]);
    } catch (error) {
      setImageError((error as Error).message);
    }
  };

  const submit = () => {
    if (streaming) return;

    onSend(attached.length ? attached.map((image) => image.dataUrl) : undefined);
    clearAttachments();
  };

  const startRecording = async () => {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      const media = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunks.current = [];
      media.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      media.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks.current, { type: media.mimeType || "audio/webm" });
        chunks.current = [];
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const form = new FormData();
          form.append("audio", blob, audioFilename(blob.type));
          const response = await fetch("/api/transcribe", { method: "POST", body: form });
          const data = (await response.json()) as { text?: string; error?: string };
          if (!response.ok || data.error) throw new Error(data.error ?? "transcription failed");
          if (data.text) {
            const current = latestValue.current;
            onChange(current ? `${current} ${data.text}` : data.text);
          }
        } catch (error) {
          setMicError((error as Error).message);
        } finally {
          setTranscribing(false);
        }
      };
      recorder.current = media;
      media.start();
      setRecording(true);
    } catch {
      setMicError("microphone access was blocked or unavailable");
    }
  };

  const stopRecording = () => {
    recorder.current?.stop();
    setRecording(false);
  };

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

        {attached.length ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {attached.map((image, index) => (
              <div
                key={`${image.name}-${index}`}
                className="relative rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1.5"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- local preview of an in-memory data URL */}
                <img
                  src={image.dataUrl}
                  alt={image.name}
                  title={image.name}
                  className="h-12 w-12 rounded object-cover"
                />
                <button
                  type="button"
                  onClick={() =>
                    setAttached((current) => current.filter((_, slot) => slot !== index))
                  }
                  aria-label={`Remove ${image.name}`}
                  className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  &times;
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={clearAttachments}
              className="text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              Remove all
            </button>
          </div>
        ) : null}

        <div className="flex items-end gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-2 focus-within:border-[var(--accent)]">
          <input
            ref={fileInput}
            type="file"
            accept={IMAGE_ACCEPT_ATTRIBUTE}
            multiple
            className="hidden"
            onChange={(event) => {
              void handleFiles([...(event.target.files ?? [])]);
              if (!event.target.files?.length) return;
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={disabled || attached.length >= MAX_IMAGES_PER_MESSAGE}
            title={
              attached.length >= MAX_IMAGES_PER_MESSAGE
                ? `${MAX_IMAGES_PER_MESSAGE} images is the most one message takes`
                : "Attach images or screenshots"
            }
            aria-label="Attach images or screenshots"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[var(--border)] bg-[var(--surface-2)] text-[var(--foreground)] transition hover:border-[var(--accent)] disabled:opacity-40"
          >
            <ImageIcon className="h-3.5 w-3.5" />
          </button>
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
              /*
               * An Enter that confirms an input-method candidate (Chinese,
               * Japanese, Korean, and accented Latin via dead keys) is not the
               * user asking to send. Without this the half-typed word - or the
               * empty draft before the candidate is chosen - goes out as the
               * message.
               */
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                submit();
              }
            }}
            className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-[var(--muted)] disabled:opacity-50"
          />
          <button
            type="button"
            onClick={recording ? stopRecording : startRecording}
            disabled={disabled || transcribing}
            title={recording ? "Stop recording" : "Record a voice message"}
            aria-label={recording ? "Stop recording" : "Record a voice message"}
            className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl border transition disabled:opacity-40 ${
              recording
                ? "animate-pulse border-red-500 bg-red-500/15 text-red-400"
                : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--foreground)] hover:border-[var(--accent)]"
            }`}
          >
            <MicIcon className="h-3.5 w-3.5" />
          </button>
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
              onClick={submit}
              disabled={disabled || (!value.trim() && !attached.length)}
              className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-[var(--accent)] to-[var(--accent2)] text-black disabled:opacity-40"
              aria-label="Send message"
            >
              <SendIcon />
            </button>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-[var(--muted)]">
          {transcribing
            ? "Transcribing your voice message..."
            : micError
              ? `Voice input error: ${micError}`
              : imageError
                ? `Image error: ${imageError}`
                : "Enter sends, Shift+Enter adds a line. Answers can be wrong - verify anything important."}
        </p>
      </div>
    </div>
  );
}

