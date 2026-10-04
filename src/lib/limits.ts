/**
 * Enforced product limits in one place so the public pricing page cannot drift
 * from what the server actually applies. Every constant here is imported by the
 * code that enforces it.
 */

/** Messages a `free` plan user may send per day before a 429. */
export const FREE_DAILY_LIMIT = 20;

/** Simultaneous in-flight requests per user, any plan. */
export const MAX_CONCURRENT_PER_USER = 3;

/** Tool calls inside one chat-mode answer. */
export const MAX_TOOL_STEPS = 3;

/**
 * Tool calls one chat answer can actually trigger. The last of the turns above
 * answers without tools, so the user-facing number is one lower than the loop
 * bound, and the pricing page says this rather than the loop bound.
 */
export const MAX_TOOL_CALLS_PER_ANSWER = MAX_TOOL_STEPS - 1;

/** Tool calls inside one agent-mode run. */
export const MAX_AGENT_STEPS = 8;

/** Prior messages replayed to the model per request. */
export const MAX_HISTORY_MESSAGES = 60;

/** Longest single message content accepted anywhere: chat, memory or history. */
export const MAX_MESSAGE_CHARS = 100_000;

/** Largest conversation JSON the server will persist. */
export const MAX_CONVERSATION_JSON_CHARS = 5_000_000;

/**
 * Largest JSON body `/api/conversations` reads. The ceiling above is counted in
 * characters and the body arrives in bytes, so this is that many characters at
 * the four bytes per character UTF-8 can cost — no legitimate save is turned
 * away, and nothing larger is buffered.
 */
export const MAX_CONVERSATION_BODY_BYTES = MAX_CONVERSATION_JSON_CHARS * 4;

/** Prior messages handed to the memory extractor per request. */
export const MAX_MEMORY_TRANSCRIPT_MESSAGES = 40;

/** Longest advisory prompt field (project context, saved memory) the chat route accepts. */
export const MAX_CONTEXT_FIELD_CHARS = 200_000;

/** Longest text the PDF tool will lay out; beyond this the model must split the work. */
export const MAX_PDF_INPUT_CHARS = 100_000;

/** Images attached to a single message. */
export const MAX_IMAGES_PER_MESSAGE = 4;

/** Longest image data URL accepted from the client. */
export const MAX_IMAGE_DATA_CHARS = 4_000_000;

/** Largest JSON body `/api/chat` reads. */
export const MAX_CHAT_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Base64 characters all the images in one request may occupy. Each image is
 * already held to `MAX_IMAGE_DATA_CHARS`, but the body carries the replayed
 * conversation and the prompt fields too, so the aggregate that matters is the
 * one that leaves 1 MB of `MAX_CHAT_BODY_BYTES` for everything else.
 */
export const MAX_REQUEST_IMAGE_DATA_CHARS = MAX_CHAT_BODY_BYTES - 1024 * 1024;

/**
 * A `data:image/...;base64,` prefix, plus the room the base64 padding rule
 * leaves below the ceiling it is measured against.
 */
const DATA_URL_OVERHEAD_CHARS = 64;

/** File bytes that become `chars` of base64. */
function base64Bytes(chars: number): number {
  return Math.floor((chars - DATA_URL_OVERHEAD_CHARS) / 4) * 3;
}

/**
 * Client-side pre-check ceiling for one image attachment: base64 costs four
 * characters per three bytes, so a file this size produces a data URL just
 * inside `MAX_IMAGE_DATA_CHARS`. Anything larger is refused by the browser
 * rather than arriving to be rejected by the server.
 */
export const MAX_IMAGE_BYTES = base64Bytes(MAX_IMAGE_DATA_CHARS);

/** The same conversion for the whole of one message's images. */
export const MAX_MESSAGE_IMAGE_BYTES = base64Bytes(
  MAX_REQUEST_IMAGE_DATA_CHARS - DATA_URL_OVERHEAD_CHARS * MAX_IMAGES_PER_MESSAGE,
);

/**
 * Image formats whose data URLs the server's validation accepts. A file in any
 * other format is refused, so the browser says so at attach time instead of
 * letting the message fail.
 */
export const IMAGE_FORMATS = [
  "png",
  "jpeg",
  "jpg",
  "webp",
  "gif",
  "heic",
  "heif",
] as const;

const IMAGE_DATA_URL = new RegExp(
  `^data:image/(${IMAGE_FORMATS.join("|")});base64,`,
  "i",
);

/**
 * Whether a string is an image the server will accept. Both the chat route and
 * the history store test with this, so the format list the browser offers can
 * never name a type the server refuses.
 */
export function isImageDataUrl(value: string): boolean {
  return IMAGE_DATA_URL.test(value);
}

/**
 * A byte count spelled out in megabytes, to one decimal, for every piece of
 * copy or error text that states a size ceiling.
 */
export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Saved memories per user. */
export const MAX_MEMORIES = 100;

/** Memory ids are `crypto.randomUUID()` output; anything longer is not one. */
export const MAX_MEMORY_ID_CHARS = 64;

/** Saved conversations per user. */
export const MAX_CONVERSATIONS = 200;

/** Messages kept per saved conversation. */
export const MAX_MESSAGES = 500;

/**
 * Backstop ceilings for the two routes that call a model but do not bill a
 * chat message: `/api/memory` runs after every reply, and `/api/transcribe`
 * runs before one. Both are set above `FREE_DAILY_LIMIT` so honest use can
 * never reach them, while a script calling those endpoints directly can.
 */
export const FREE_DAILY_MEMORY_RUNS = 60;
export const FREE_DAILY_TRANSCRIPTIONS = 40;

/**
 * Wall-clock ceiling for one chat request, in seconds. `/api/chat` exports this
 * as `maxDuration`, but only a literal there is read by Next, so the number is
 * written twice on purpose: the pricing page quotes this constant and a test
 * compares it against the route source, which is what keeps the two in step.
 */
export const MAX_REQUEST_SECONDS = 120;
