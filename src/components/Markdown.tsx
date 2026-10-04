"use client";

import type { ComponentPropsWithoutRef, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import CopyButton from "./CopyButton";

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const element = node as { props?: { children?: ReactNode } };
  return element.props ? textOf(element.props.children) : "";
}


const LOCAL_IMAGE = /^(?:data:image\/[a-z0-9.+-]+;base64,|blob:)/i;

const SAFE_LINK = /^(?:https?:|mailto:|tel:)/i;

function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  if (!href || !SAFE_LINK.test(href)) {
    return <>{children}</>;
  }

  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function MarkdownImage({
  src,
  alt,
  title,
}: {
  src?: string;
  alt?: string;
  title?: string;
}) {
  if (!src) return null;

  if (!LOCAL_IMAGE.test(src)) {
    if (!/^https?:/i.test(src)) {
      return <span>{alt || src}</span>;
    }

    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer noopener"
        className="underline"
        title={title}
      >
        {alt || src}
      </a>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- markdown can contain in-memory data/blob images
    <img
      src={src}
      alt={alt ?? ""}
      title={title}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="max-w-full rounded-xl"
    />
  );
}

function CodeBlock({ children }: ComponentPropsWithoutRef<"pre">) {
  const code = textOf(children);
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-[var(--border)] bg-[#0b0b12]">
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5">
        <span className="text-[11px] uppercase tracking-wide text-[var(--muted)]">code</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

export default function Markdown({ content }: { content: string }) {
  return (
    <div className="omni-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeBlock,
          a: (props) => (
            <MarkdownLink
              href={typeof props.href === "string" ? props.href : undefined}
            >
              {props.children}
            </MarkdownLink>
          ),
          img: (props) => (
            <MarkdownImage
              src={typeof props.src === "string" ? props.src : undefined}
              alt={typeof props.alt === "string" ? props.alt : undefined}
              title={typeof props.title === "string" ? props.title : undefined}
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
