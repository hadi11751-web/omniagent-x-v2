set -e
echo ">>> writing files"
mkdir -p "src/app/sign-in/[[...sign-in]]" "src/app/sign-up/[[...sign-up]]" src/app/api/stripe/checkout src/app/api/stripe/webhook
cat > 'src/middleware.ts' << 'OMNI_EOF'
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// The Stripe webhook must stay public (Stripe calls it directly, with no
// user session), and Clerk's own sign-in/up pages obviously can't require
// being signed in already.
const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/api/stripe/webhook"]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};

OMNI_EOF
cat > 'src/app/layout.tsx' << 'OMNI_EOF'
import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "OmniAgent",
  description: "Multi-provider AI agent with tools, research and local-model support.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#07070b",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>{children}</body>
      </html>
    </ClerkProvider>
  );
}

OMNI_EOF
cat > 'src/app/sign-in/[[...sign-in]]/page.tsx' << 'OMNI_EOF'
import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)]">
      <SignIn />
    </div>
  );
}

OMNI_EOF
cat > 'src/app/sign-up/[[...sign-up]]/page.tsx' << 'OMNI_EOF'
import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--background)]">
      <SignUp />
    </div>
  );
}

OMNI_EOF
cat > 'src/lib/quota.ts' << 'OMNI_EOF'
import { Redis } from "@upstash/redis";
import { currentUser } from "@clerk/nextjs/server";

const FREE_DAILY_LIMIT = 20;

function redisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function redis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

/** Plan is stored in the Clerk user's public metadata, set by the Stripe webhook. */
export async function getPlan(): Promise<"free" | "paid"> {
  const user = await currentUser();
  const plan = user?.publicMetadata?.plan;
  return plan === "paid" ? "paid" : "free";
}

function todayKey(userId: string): string {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, resets daily in UTC
  return `usage:${userId}:${day}`;
}

/**
 * Returns { allowed, remaining, limit }. Paid users are always allowed with
 * no counting at all. Free users are capped at FREE_DAILY_LIMIT messages
 * per UTC day. If Redis isn't configured, this fails open (allowed) rather
 * than breaking chat entirely for a missing optional feature.
 */
export async function checkAndConsumeQuota(userId: string): Promise<{
  allowed: boolean;
  remaining: number;
  limit: number | null;
}> {
  const plan = await getPlan();
  if (plan === "paid") return { allowed: true, remaining: Infinity, limit: null };

  if (!redisConfigured()) {
    // Rate limiting is optional infrastructure; don't take down chat for
    // everyone just because Redis env vars aren't set yet.
    return { allowed: true, remaining: FREE_DAILY_LIMIT, limit: FREE_DAILY_LIMIT };
  }

  const key = todayKey(userId);
  const client = redis();
  const count = await client.incr(key);
  if (count === 1) {
    await client.expire(key, 60 * 60 * 26); // a little over a day, covers timezone edge cases
  }

  return {
    allowed: count <= FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - count),
    limit: FREE_DAILY_LIMIT,
  };
}

OMNI_EOF
cat > 'src/app/api/chat/route.ts' << 'OMNI_EOF'
import { StreamAbortedError } from "@/lib/http";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/models";
import { availableModels, providerFor } from "@/lib/providers";
import { checkAndConsumeQuota } from "@/lib/quota";
import { routeModel } from "@/lib/router";
import { collectText, createEventStream, type StreamEvent } from "@/lib/stream";
import {
  availableTools,
  findTool,
  parseNativeToolCall,
  parseToolCall,
  toolInstructions,
} from "@/lib/tools";
import { searchWeb } from "@/lib/tools/webSearch";
import type { ChatMessage, ChatProvider, ModelInfo, Source } from "@/lib/types";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type Mode = "chat" | "research" | "blend" | "agent";

interface Body {
  messages?: ChatMessage[];
  model?: string;
  mode?: Mode;
  autoRoute?: boolean;
  toolsEnabled?: boolean;
  memory?: string;
  projectContext?: string;
}

const MAX_TOOL_STEPS = 3;

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

function toolData(data: unknown) {
  const payload = (data ?? {}) as {
    sources?: Source[];
    image?: string;
    file?: { dataUrl: string; filename: string };
  };
  return payload;
}

export async function POST(request: Request) {
  const { userId } = await auth();
  // Middleware already requires sign-in for this route, so userId should
  // always exist here — this check is just defense in depth.
  if (!userId) return Response.json({ error: "not signed in" }, { status: 401 });

  const quota = await checkAndConsumeQuota(userId);
  if (!quota.allowed) {
    return Response.json(
      {
        error: `You've used today's ${quota.limit} free messages. Upgrade for unlimited access, or come back tomorrow.`,
        upgradeRequired: true,
      },
      { status: 429 },
    );
  }

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return badRequest("request body must be JSON");
  }

  const history = (body.messages ?? []).filter(
    (message) =>
      typeof message?.content === "string" && (message.content.trim().length > 0 || (message.images?.length ?? 0) > 0),
  );
  if (!history.length) return badRequest("messages must contain at least one entry");

  const models = availableModels();
  if (!models.length) {
    return Response.json(
      {
        error:
          "No AI provider is configured. Add GROQ_API_KEY (or GEMINI_API_KEY / OPENROUTER_API_KEY / HUGGINGFACE_API_KEY) to .env.local and restart the server.",
      },
      { status: 503 },
    );
  }

  const mode: Mode = body.mode ?? "chat";
  const lastUserMessage = [...history].reverse().find((message) => message.role === "user");
  const lastUser = lastUserMessage?.content ?? "";
  const hasImages = Boolean(lastUserMessage?.images?.length);

  let model: ModelInfo | undefined;
  let capability: string | undefined;
  if (body.autoRoute) {
    const routed = routeModel(lastUser, models);
    model = routed.model;
    capability = routed.capability;
  } else {
    model = models.find((candidate) => candidate.id === body.model) ?? models[0];
  }

  let switchedForVision = false;
  if (hasImages && !model?.vision) {
    const visionModel = models.find((candidate) => candidate.vision);
    if (visionModel) {
      model = visionModel;
      switchedForVision = true;
    } else {
      return badRequest("no vision-capable model is configured (add GROQ_API_KEY to enable image understanding)");
    }
  }

  if (!model) return badRequest("no usable model");
  const provider = providerFor(model.id);
  if (!provider) return badRequest(`no provider for model ${model.id}`);

  const toolsEnabled = body.toolsEnabled !== false && mode !== "blend";
  const tools = toolsEnabled ? availableTools() : [];

  const systemParts = [DEFAULT_SYSTEM_PROMPT];
  if (body.projectContext?.trim()) systemParts.push(`Project context:\n${body.projectContext.trim()}`);
  if (body.memory?.trim()) systemParts.push(`Long-term memory the user saved:\n${body.memory.trim()}`);
  const systemWithoutTools = systemParts.join("\n\n");
  if (tools.length) systemParts.push(toolInstructions(tools));

  const baseMessages: ChatMessage[] = [
    { role: "system", content: systemParts.join("\n\n") },
    ...history.map((message) => ({ role: message.role, content: message.content })),
  ];

  return createEventStream(async (emit) => {
    emit({
      type: "meta",
      model: model.label,
      provider: provider.label,
      execution: model.execution,
      capability,
      mode,
    });
    if (switchedForVision) {
      emit({ type: "status", text: `Switched to ${model.label} to read the attached image.` });
    }

    const signal = request.signal;
    const conversation = [...baseMessages];

    if (mode === "research") {
      await runResearch(lastUser, conversation, emit, signal);
    }

    if (mode === "blend") {
      await runBlend(model, provider, conversation, emit, signal);
      return;
    }

    if (mode === "agent") {
      await runAgentPlan(provider, model, lastUser, conversation, emit, signal);
    }

    await streamWithTools(
      provider,
      model.id,
      conversation,
      tools.length > 0,
      systemWithoutTools,
      emit,
      signal,
    );
  });
}

async function runResearch(
  query: string,
  conversation: ChatMessage[],
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
) {
  emit({ type: "status", text: "Searching the web..." });
  try {
    const { sources, engine } = await searchWeb(query);
    if (!sources.length) {
      emit({ type: "status", text: `${engine} returned no results; answering from model knowledge only.` });
      return;
    }
    emit({ type: "sources", sources });
    emit({ type: "tool", name: "web_search", argument: query, ok: true, summary: `${sources.length} results via ${engine}` });
    conversation.push({
      role: "system",
      content: [
        `Search results from ${engine}. Use them and cite with [n] markers.`,
        ...sources.map((source, index) => `[${index + 1}] ${source.title} - ${source.url}\n${source.snippet ?? ""}`),
      ].join("\n"),
    });
  } catch (error) {
    emit({ type: "status", text: `Search unavailable: ${(error as Error).message}` });
  }
  void signal;
}

async function runBlend(
  primary: ModelInfo,
  primaryProvider: ChatProvider,
  conversation: ChatMessage[],
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
) {
  const models = availableModels();
  const seen = new Set<string>();
  const participants = models
    .filter((candidate) => {
      if (seen.has(candidate.provider)) return false;
      seen.add(candidate.provider);
      return true;
    })
    .slice(0, 3);

  const answers: { label: string; text: string }[] = [];
  for (const participant of participants) {
    const participantProvider = providerFor(participant.id);
    if (!participantProvider) continue;
    emit({ type: "status", text: `Asking ${participant.label}...` });
    try {
      const text = await collectText(participantProvider, participant.id, conversation, signal);
      if (text) answers.push({ label: `${participant.label} (${participantProvider.label})`, text });
    } catch (error) {
      emit({ type: "status", text: `${participant.label} failed: ${(error as Error).message}` });
    }
  }

  if (!answers.length) {
    emit({ type: "error", message: "every provider in the blend failed" });
    return;
  }
  if (answers.length === 1) {
    emit({ type: "status", text: "Only one provider is configured, showing its answer directly." });
    emit({ type: "delta", text: answers[0].text });
    return;
  }

  emit({ type: "status", text: `Synthesising ${answers.length} answers...` });
  const synthesis: ChatMessage[] = [
    {
      role: "system",
      content:
        "You merge several draft answers into one. Keep what is correct, drop contradictions, and note disagreements briefly.",
    },
    ...conversation.filter((message) => message.role !== "system"),
    {
      role: "user",
      content: answers.map((answer) => `### ${answer.label}\n${answer.text}`).join("\n\n"),
    },
  ];
  for await (const chunk of primaryProvider.stream({ model: primary.id, messages: synthesis, signal })) {
    emit({ type: "delta", text: chunk });
  }
}

async function runAgentPlan(
  provider: ChatProvider,
  model: ModelInfo,
  goal: string,
  conversation: ChatMessage[],
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
) {
  const tools = availableTools();
  if (!tools.length) return;
  emit({ type: "status", text: "Planning..." });
  const planPrompt: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are the planner of a controlled agent. Break the goal into at most 3 steps.",
        "Each line must be exactly: STEP: <tool> | <argument>",
        `Allowed tools: ${tools.map((tool) => tool.name).join(", ")}.`,
        "If no tool is needed, answer exactly: NO_TOOLS.",
        "Never plan destructive or irreversible actions.",
      ].join("\n"),
    },
    { role: "user", content: goal },
  ];

  let plan = "";
  try {
    plan = await collectText(provider, model.id, planPrompt, signal);
  } catch (error) {
    emit({ type: "status", text: `Planner failed, answering directly: ${(error as Error).message}` });
    return;
  }
  if (/NO_TOOLS/i.test(plan)) {
    emit({ type: "status", text: "Planner decided no tools are needed." });
    return;
  }

  const steps = plan
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*STEP:\s*([a-z_]+)\s*\|\s*(.+)$/i))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .slice(0, 3);

  if (!steps.length) {
    emit({ type: "status", text: "Planner produced no usable steps; answering directly." });
    return;
  }

  for (const [, name, argument] of steps) {
    const tool = findTool(name.toLowerCase());
    if (!tool) continue;
    emit({ type: "status", text: `Running ${tool.name}...` });
    const result = await tool.run(argument.trim());
    emitToolResult(emit, tool.name, argument.trim(), result.ok, result.content, result.data);
    conversation.push({
      role: "system",
      content: `Result of ${tool.name}(${argument.trim()}):\n${result.content}`,
    });
  }
  emit({ type: "status", text: "Verifying and writing the answer..." });
}

function emitToolResult(
  emit: (event: StreamEvent) => void,
  name: string,
  argument: string,
  ok: boolean,
  content: string,
  data: unknown,
) {
  emit({
    type: "tool",
    name,
    argument,
    ok,
    summary: ok ? content.slice(0, 160) : content,
  });
  const payload = toolData(data);
  if (payload.sources?.length) emit({ type: "sources", sources: payload.sources });
  if (payload.image) emit({ type: "image", dataUrl: payload.image });
  if (payload.file) emit({ type: "file", dataUrl: payload.file.dataUrl, filename: payload.file.filename });
}

/**
 * Streams the answer, but holds back the first characters so a `TOOL:` line is
 * executed instead of being shown to the user.
 */
async function streamWithTools(
  provider: ChatProvider,
  modelId: string,
  conversation: ChatMessage[],
  toolsEnabled: boolean,
  systemWithoutTools: string,
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
) {
  let toolsAllowed = toolsEnabled;

  for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
    const isLastStep = step === MAX_TOOL_STEPS - 1;
    const allowTools = toolsAllowed && !isLastStep;
    let held = allowTools;
    let buffer = "";
    let emitted = false;
    let call: { name: string; argument: string } | undefined;

    try {
      for await (const chunk of provider.stream({ model: modelId, messages: conversation, signal })) {
        if (!held) {
          emitted = true;
          emit({ type: "delta", text: chunk });
          continue;
        }
        buffer += chunk;
        const trimmed = buffer.trimStart();
        if (trimmed.length < 5) continue;
        if (/^tool:/i.test(trimmed)) continue;
        held = false;
        emitted = true;
        emit({ type: "delta", text: buffer });
        buffer = "";
      }
    } catch (error) {
      if (signal.aborted) return;
      // Models that were trained for native tool calls sometimes emit one, and
      // the provider then aborts the stream. Run the requested tool instead of
      // leaving the answer blank.
      const aborted = error instanceof StreamAbortedError ? error : undefined;
      const native = aborted ? parseNativeToolCall(aborted.failedGeneration) : undefined;
      if (!native || emitted) {
        if (emitted) emit({ type: "error", message: (error as Error).message });
        else if (!(await retryWithoutTools(provider, modelId, conversation, systemWithoutTools, emit, signal))) {
          emit({ type: "error", message: (error as Error).message });
        }
        return;
      }
      call = native;
      buffer = `TOOL: ${native.name} | ${native.argument}`;
    }

    if (!call && !held) {
      if (buffer) emit({ type: "delta", text: buffer });
      else if (!emitted && !(await retryWithoutTools(provider, modelId, conversation, systemWithoutTools, emit, signal))) {
        emit({ type: "status", text: "The model returned an empty response." });
      }
      return;
    }

    if (!call) {
      call = parseToolCall(buffer);
      if (!call) {
        if (buffer.trim()) {
          emit({ type: "delta", text: buffer });
        } else if (!(await retryWithoutTools(provider, modelId, conversation, systemWithoutTools, emit, signal))) {
          emit({ type: "status", text: "The model returned an empty response." });
        }
        return;
      }
    }

    const tool = findTool(call.name);
    if (!tool) {
      conversation.push({ role: "assistant", content: buffer.trim() });
      conversation.push({ role: "system", content: `Tool "${call.name}" does not exist. Answer without tools.` });
      toolsAllowed = false;
      continue;
    }
    emit({ type: "status", text: `Running ${tool.name}...` });
    const result = await tool.run(call.argument);
    emitToolResult(emit, tool.name, call.argument, result.ok, result.content, result.data);
    conversation.push({ role: "assistant", content: buffer.trim() });
    conversation.push({
      role: "system",
      content: `Result of ${tool.name}(${call.argument}):\n${result.content}\nNow answer the user. Do not call another tool unless it is essential.`,
    });
  }

  // Every step ran a tool and none produced an answer: ask once more, tool-free.
  if (!(await retryWithoutTools(provider, modelId, conversation, systemWithoutTools, emit, signal))) {
    emit({ type: "status", text: "The model returned an empty response." });
  }
}

/**
 * Last resort when a tool-enabled turn produced no visible text: ask again with
 * the tool protocol removed, so the user always gets an answer.
 * Returns true when some text was streamed.
 */
async function retryWithoutTools(
  provider: ChatProvider,
  modelId: string,
  conversation: ChatMessage[],
  systemWithoutTools: string,
  emit: (event: StreamEvent) => void,
  signal: AbortSignal,
): Promise<boolean> {
  const messages: ChatMessage[] = conversation.map((message, index) =>
    index === 0 && message.role === "system" ? { role: "system", content: systemWithoutTools } : message,
  );
  if (signal.aborted) return true;
  emit({ type: "status", text: "Answering without tools..." });
  let emitted = false;
  try {
    for await (const chunk of provider.stream({ model: modelId, messages, signal })) {
      emitted = true;
      emit({ type: "delta", text: chunk });
    }
  } catch (error) {
    if (!emitted) {
      emit({ type: "error", message: (error as Error).message });
      return true;
    }
  }
  return emitted;
}

OMNI_EOF
cat > 'src/app/api/stripe/checkout/route.ts' << 'OMNI_EOF'
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { auth, currentUser } from "@clerk/nextjs/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!secretKey || !priceId) {
    return NextResponse.json({ error: "billing isn't configured on the server yet" }, { status: 503 });
  }

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress;
  const origin = new URL(request.url).origin;

  const stripe = new Stripe(secretKey);
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: email,
    // Carried through to the webhook so we know which Clerk user to upgrade
    // — Stripe has no idea what a "Clerk user" is on its own. Attaching it
    // to the subscription (not just the session) means cancellation events
    // later can find the right user with no separate database lookup.
    client_reference_id: userId,
    subscription_data: { metadata: { clerkUserId: userId } },
    success_url: `${origin}/?upgraded=1`,
    cancel_url: `${origin}/?upgrade=cancelled`,
  });

  return NextResponse.json({ url: session.url });
}

OMNI_EOF
cat > 'src/app/api/stripe/webhook/route.ts' << 'OMNI_EOF'
import { NextResponse } from "next/server";
import Stripe from "stripe";
import { clerkClient } from "@clerk/nextjs/server";

export const runtime = "nodejs";

async function setPlan(clerkUserId: string, plan: "free" | "paid") {
  const client = await clerkClient();
  await client.users.updateUserMetadata(clerkUserId, { publicMetadata: { plan } });
}

export async function POST(request: Request) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) {
    return NextResponse.json({ error: "billing isn't configured on the server yet" }, { status: 503 });
  }

  // Stripe signs the RAW request body, so this must not be JSON-parsed
  // before verification — parsing first would invalidate the signature.
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing stripe-signature header" }, { status: 400 });

  const stripe = new Stripe(secretKey);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    return NextResponse.json({ error: `signature verification failed: ${(error as Error).message}` }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const clerkUserId = session.client_reference_id;
      if (clerkUserId) await setPlan(clerkUserId, "paid");
      break;
    }
    case "customer.subscription.deleted":
    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const clerkUserId = subscription.metadata?.clerkUserId;
      if (clerkUserId) {
        const stillActive = subscription.status === "active" || subscription.status === "trialing";
        await setPlan(clerkUserId, stillActive ? "paid" : "free");
      }
      break;
    }
    default:
      // Other event types aren't relevant to plan status; ignore them.
      break;
  }

  return NextResponse.json({ received: true });
}

OMNI_EOF
cat > 'src/components/Sidebar.tsx' << 'OMNI_EOF'
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

OMNI_EOF
echo ">>> installing dependencies"
npm install @clerk/nextjs stripe @upstash/redis --save --legacy-peer-deps --silent
echo ">>> typecheck"
npx tsc --noEmit
echo ">>> lint"
npx eslint .
echo ">>> committing"
git add -A
git commit -m "Add sign-in, Stripe subscriptions, and daily quota for free users"
echo ">>> pushing"
git push
echo ">>> ALL DONE"