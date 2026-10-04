import {
  FREE_DAILY_LIMIT,
  FREE_DAILY_MEMORY_RUNS,
  FREE_DAILY_TRANSCRIPTIONS,
  MAX_AGENT_STEPS,
  MAX_CONCURRENT_PER_USER,
  MAX_CONVERSATIONS,
  MAX_HISTORY_MESSAGES,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MEMORIES,
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_REQUEST_SECONDS,
  MAX_TOOL_CALLS_PER_ANSWER,
  megabytes,
} from "@/lib/limits";
import type { Mode } from "@/lib/client/types";

/**
 * Public product copy for the `/pricing` page. Every statement here describes
 * behaviour that exists in this repository: nothing speculative belongs in
 * this file. Roadmap material lives in the README instead.
 */

export interface ProductCapability {
  key: string;
  title: string;
  tagline: string;
  bullets: string[];
}

export const OMNI_CAPABILITIES: ProductCapability[] = [
  {
    key: "intelligence",
    title: "Omni Intelligence",
    tagline: "One assistant for thinking out loud.",
    bullets: [
      "Everyday questions, explanations, planning and decision support.",
      "Nexus is the one AI model. There is no model picker and nothing to choose between.",
      "Nexus does the reasoning itself and calls tools for search, files, images, calculations and memory when a request needs them.",
      "Research, agent and tool workflows all run through the same Nexus model.",
    ],
  },
  {
    key: "coding",
    title: "Omni Coding",
    tagline: "Write, read and fix code in chat.",
    bullets: [
      "Generates and refactors code, explains stack traces, compares approaches.",
      "Nexus handles coding directly and can use the application tools when needed.",
      "Answers arrive as formatted markdown with copy buttons per block.",
    ],
  },
  {
    key: "research",
    title: "Omni Research",
    tagline: "Live web search with sources you can check.",
    bullets: [
      "web_search with failover across Tavily, Brave Search and a keyless fallback.",
      "fetch_url reads a public page and returns its text.",
      "Research mode searches first, then answers with a cited source list.",
      "In chat, a question that needs current information searches on its own, so picking a mode is optional.",
      "Search and page text is handed to the model labelled as data, not as instructions.",
      "A turn you marked private does not search, whether or not a local model serves it; the stream says why instead.",
    ],
  },
  {
    key: "agent",
    title: "Omni Agent",
    tagline: "Multi-step work instead of a single reply.",
    bullets: [
      `Plans, runs tools, and answers in up to ${MAX_AGENT_STEPS} steps per run.`,
      "Every tool call is reported in the stream, so you can see what it did.",
      "A verification pass checks the collected evidence before the final answer.",
      "Only tools the current privacy boundary allows reach the planner.",
    ],
  },
  {
    key: "vision",
    title: "Omni Vision",
    tagline: "Attach screenshots and photos.",
    bullets: [
      `Up to ${MAX_IMAGES_PER_MESSAGE} images per message, each up to ${megabytes(MAX_IMAGE_BYTES)} and ${megabytes(MAX_MESSAGE_IMAGE_BYTES)} of them together.`,
      "Nexus reads attached images itself. If a deployment's Nexus backend cannot see images, it says so instead of handing your attachment to another model.",
      "They stay in the transcript. A thread whose attachments outgrow one request re-sends the newest ones and keeps the rest as pictures in the chat only.",
    ],
  },
  {
    key: "creation",
    title: "Omni Creation",
    tagline: "Images and documents as output.",
    bullets: [
      "generate_image creates a picture from a prompt and streams it into the chat.",
      "generate_pdf writes a downloadable PDF from the answer.",
      "inspect_pdf reports a PDF's page count, size and metadata. It does not extract PDF text.",
    ],
  },
  {
    key: "voice",
    title: "Omni Voice",
    tagline: "Speak instead of typing.",
    bullets: [
      "The microphone transcribes dictation into the composer before you send.",
      "Transcribed text is appended, so you can edit it first.",
      `Up to ${FREE_DAILY_TRANSCRIPTIONS} transcriptions a day on the free plan; paid has no ceiling.`,
    ],
  },
  {
    key: "memory",
    title: "Omni Memory",
    tagline: "Useful facts carried across chats.",
    bullets: [
      `Stores up to ${MAX_MEMORIES} memories per account.`,
      "Automatically extracts facts from a finished answer when memory is on.",
      `Extraction is capped at ${FREE_DAILY_MEMORY_RUNS} saves a day on the free plan; paid has no ceiling.`,
      "A conversation that asked to be private is not sent to a cloud backend for extraction.",
      "You can turn it off per setting and delete any stored memory.",
    ],
  },
  {
    key: "private",
    title: "Omni Private",
    tagline: "Say it is private, and external tools stay off.",
    bullets: [
      "A message that asks to be kept private keeps web_search, fetch_url and generate_image off its tool list for that turn.",
      "Where Nexus runs is the deployment's choice: on a self-hosted backend, a private turn never leaves this deployment; on a cloud backend the stream says that plainly instead of claiming otherwise.",
      "Saving chat history is a separate choice: with it on, this deployment stores your conversations as it stores any others, and Delete all conversations clears them from here too.",
      "The Nexus backend key lives on the server only and is never sent to the browser.",
    ],
  },
  {
    key: "tools",
    title: "Omni Tools",
    tagline: "It acts, not just generates.",
    bullets: [
      "web_search, fetch_url, calculator, analyze_text, generate_image, generate_pdf, inspect_pdf.",
      "Calculator is a real expression evaluator with precedence and functions, never eval().",
      "Tools can be switched off per message.",
      "Only tools that send nothing outside this deployment stay available on a private turn.",
    ],
  },
];

/** The four request modes exposed in the composer. */
export const MODE_DETAILS: { id: Mode; label: string; hint: string }[] = [
  { id: "chat", label: "Chat", hint: "Normal chat, tools available on demand" },
  { id: "research", label: "Research", hint: "Search the web first, then answer with sources" },
  { id: "agent", label: "Agent", hint: "Plan, run tools, then answer" },
];

export interface PlanRow {
  label: string;
  free: string;
  paid: string;
  /** True when the two plans really differ, so the page can highlight it. */
  differs: boolean;
}

export const FREE_PLAN_NAME = "Free";
export const PAID_PLAN_NAME = "Omni Unlimited";

/**
 * Limits as enforced by the server. `differs` is derived from the same
 * constants that enforce the behaviour, so the comparison cannot drift.
 */
export const PLAN_ROWS: PlanRow[] = [
  {
    label: "Messages per day",
    free: `${FREE_DAILY_LIMIT}`,
    paid: "Unlimited",
    differs: true,
  },
  {
    label: "Simultaneous requests",
    free: `${MAX_CONCURRENT_PER_USER}`,
    paid: `${MAX_CONCURRENT_PER_USER}`,
    differs: false,
  },
  {
    label: "Tool calls per chat answer",
    free: `${MAX_TOOL_CALLS_PER_ANSWER}`,
    paid: `${MAX_TOOL_CALLS_PER_ANSWER}`,
    differs: false,
  },
  {
    label: "Agent tool steps per run",
    free: `${MAX_AGENT_STEPS}`,
    paid: `${MAX_AGENT_STEPS}`,
    differs: false,
  },
  {
    label: "Conversation window sent to the model",
    free: `${MAX_HISTORY_MESSAGES} messages`,
    paid: `${MAX_HISTORY_MESSAGES} messages`,
    differs: false,
  },
  {
    label: "Saved conversations",
    free: `${MAX_CONVERSATIONS}`,
    paid: `${MAX_CONVERSATIONS}`,
    differs: false,
  },
  {
    label: "Memories",
    free: `${MAX_MEMORIES}`,
    paid: `${MAX_MEMORIES}`,
    differs: false,
  },
  {
    label: "Images per message",
    free: `${MAX_IMAGES_PER_MESSAGE}`,
    paid: `${MAX_IMAGES_PER_MESSAGE}`,
    differs: false,
  },
  /*
   * checkDailyCap returns "allowed" for a paid account before counting, so
   * quoting these two numbers for both plans described a ceiling that is not
   * imposed.
   */
  {
    label: "Memory saves per day",
    free: `${FREE_DAILY_MEMORY_RUNS}`,
    paid: "Unlimited",
    differs: true,
  },
  {
    label: "Voice transcriptions per day",
    free: `${FREE_DAILY_TRANSCRIPTIONS}`,
    paid: "Unlimited",
    differs: true,
  },
];

/** Capabilities identical on both plans — stated so the page stays honest. */
export const INCLUDED_ON_BOTH: string[] = [
  "The Nexus model",
  "Live web search with citations",
  "Research and agent modes",
  "Image attachments and vision answers",
  "Image generation and PDF export",
  "Voice dictation",
  "Memory and projects",
  "Private turns that keep external tools off",
  "Automatic retry on transient backend errors",
];

/**
 * Which limits gate the plans, used by the page to phrase the upgrade.
 * `free` stops at `FREE_DAILY_LIMIT`; paid has no daily ceiling.
 */
export const PLAN_LIMIT_SUMMARY = {
  freeDailyMessages: FREE_DAILY_LIMIT,
  paidDailyMessages: null,
} as const;

/**
 * The live-information promise, stated as the code behaves: research mode and
 * a chat question that reads as time-sensitive both go through
 * `runResearch` before the model answers.
 */
export const REALTIME_SEARCH = {
  headline: "Omni doesn't just know. Omni can find out.",
  steps: [
    "Understands what you are asking",
    "Checks whether the answer needs current information",
    "Searches the live web when it does",
    "Reads several results instead of trusting one",
    "Compares them, then answers with sources you can open",
  ],
  searchesFor: [
    "News and anything dated today, yesterday or this week",
    "Latest releases, versions and prices",
    "Who won, final scores and other fast-changing facts",
    "Comparisons that only hold with current data",
    "A site you pasted, fetched and read back to you",
  ],
  skipsFor: [
    "Explanations of stable ideas, like photosynthesis",
    "Code, refactors and stack traces",
    "Arithmetic and text already in the conversation",
    "Creative writing and summaries of your own material",
  ],
};

/** The order work flows through, matching classify -> boundary -> tools -> answer. */
export const DECISION_PIPELINE = [
  "Understand the request",
  "Classify it as private, image, coding, research, reasoning or everyday",
  "Hold the turn inside the privacy boundary when it asks to be private",
  "Pull in saved memory when it is switched on",
  "Search first when the answer needs current information",
  "Call tools: fetch, calculate, inspect files, generate images or PDFs",
  "Verify the evidence collected during a multi-step run",
  "Answer",
];

/** There is exactly one user-facing model. */
export const MODEL_SUMMARY = {
  models: 1,
  name: "Nexus",
} as const;

export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ: FaqItem[] = [
  {
    question: "What counts as a message?",
    answer: `One send from the composer. If a backend failure means you got no usable answer, that message is refunded to your daily count.`,
  },
  {
    question: "Do I have to pick a model?",
    answer: "No. Nexus is the only model there is. It does the reasoning and calls tools when a request needs them.",
  },
  {
    question: "What does the paid plan change?",
    answer: `The daily ceilings. Free stops after ${FREE_DAILY_LIMIT} messages a day, ${FREE_DAILY_MEMORY_RUNS} memory saves and ${FREE_DAILY_TRANSCRIPTIONS} transcriptions; the paid plan has none of those. Features are the same on both, and both use the same Nexus model.`,
  },
  {
    question: "Can I see what Omni remembers?",
    answer: `Yes. Memory holds up to ${MAX_MEMORIES} facts per account, you can delete any of them, and you can switch memory off in settings.`,
  },
  {
    question: "Is there a private option?",
    answer: "Say so in the message (for example, \"keep this private\"). That turn drops web search, page fetching and image generation. Whether the reply itself stays on this deployment depends on where Nexus runs: on a local backend it does; on a cloud backend it cannot, and the stream tells you so. The Nexus key stays on the server and is never sent to the browser.",
  },
  {
    question: "What if a private turn needs something it cannot do?",
    answer: "It says so in the stream and stays inside the boundary. An image request on a private turn is answered as text, and research mode states that it will not search.",
  },
  {
    question: "How many tools can one answer use?",
    answer: `A chat answer runs ${MAX_TOOL_CALLS_PER_ANSWER} tool calls and then answers with what came back; an agent run is allowed ${MAX_AGENT_STEPS} tool steps. Both plans use the same numbers.`,
  },
  {
    question: "Does the paid plan let one answer run longer?",
    answer: `No. A single request is bounded the same way on both plans: ${MAX_REQUEST_SECONDS} seconds of wall clock, ${MAX_AGENT_STEPS} agent tool steps, ${MAX_TOOL_CALLS_PER_ANSWER} tool calls in a chat answer. Upgrading removes the daily counters, so a job that needs more work is sent as more messages rather than as one longer one.`,
  },
  {
    question: "What about PDFs?",
    answer: "Omni writes a PDF of an answer for download and can inspect an uploaded PDF's pages, size and metadata. Reading full text out of a PDF is not shipped yet, so don't expect that.",
  },
];
