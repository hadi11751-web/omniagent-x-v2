import {
  IMAGE_FORMATS,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_REQUEST_IMAGE_DATA_CHARS,
  megabytes,
} from "@/lib/limits";

/** What the file picker reports about a chosen file. */
export interface PickedFile {
  name: string;
  type: string;
  size: number;
}

const MAX_IMAGE_MB = megabytes(MAX_IMAGE_BYTES);
const MAX_MESSAGE_MB = megabytes(MAX_MESSAGE_IMAGE_BYTES);

/** `image/png` and friends, for the picker and for what a file may be. */
const ACCEPTED_TYPES = IMAGE_FORMATS.map((format) => `image/${format}`);

const ACCEPTED = new Set(ACCEPTED_TYPES);

export const IMAGE_ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.join(",");

/**
 * Why this batch cannot be attached, in terms the visitor can act on. Checked
 * against the same constants the server enforces, so a file the browser accepts
 * is a file `validateHistory` will not refuse.
 */
export function attachmentRejection(
  current: readonly PickedFile[],
  incoming: readonly PickedFile[],
): string | undefined {
  const batch = [...current, ...incoming];

  const unusable = incoming.find((file) => !ACCEPTED.has(file.type));

  if (unusable) {
    return `${unusable.name} is not a supported image (${IMAGE_FORMATS.join(", ")})`;
  }

  const oversized = incoming.find((file) => file.size > MAX_IMAGE_BYTES);

  if (oversized) {
    return `${oversized.name} is too large (${MAX_IMAGE_MB} per image)`;
  }

  if (batch.length > MAX_IMAGES_PER_MESSAGE) {
    return `up to ${MAX_IMAGES_PER_MESSAGE} images per message`;
  }

  if (
    batch.reduce((total, file) => total + file.size, 0) > MAX_MESSAGE_IMAGE_BYTES
  ) {
    return `${MAX_IMAGES_PER_MESSAGE} images per message, ${MAX_MESSAGE_MB} of them in total`;
  }

  return undefined;
}

/**
 * Everything sent back as vision input, trimmed to the budget one request may
 * spend on images. The attachments of the message being answered are kept
 * first; older ones are replayed only while there is room, because the whole
 * history shares one body ceiling and a request that passes it is refused
 * before any model sees it.
 */
export function fitImageBudget<T extends { images?: string[] }>(
  messages: readonly T[],
): T[] {
  let spent = 0;
  const slots = new Set<string>();

  // Newest attachment first: the message being answered is the one that needs
  // its images, and a smaller older one is still worth sending.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const images = messages[index].images ?? [];

    for (let slot = images.length - 1; slot >= 0; slot -= 1) {
      if (spent + images[slot].length > MAX_REQUEST_IMAGE_DATA_CHARS) continue;

      spent += images[slot].length;
      slots.add(`${index}:${slot}`);
    }
  }

  return messages.map((message, index) => {
    const images = message.images;

    if (!images?.length) return { ...message };

    const kept = images.filter((_, slot) => slots.has(`${index}:${slot}`));

    return { ...message, images: kept.length ? kept : undefined };
  });
}
