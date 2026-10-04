import { describe, expect, it } from "vitest";
import {
  attachmentRejection,
  fitImageBudget,
  IMAGE_ACCEPT_ATTRIBUTE,
  type PickedFile,
} from "@/lib/client/images";
import {
  IMAGE_FORMATS,
  MAX_CHAT_BODY_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DATA_CHARS,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MESSAGE_IMAGE_BYTES,
  MAX_REQUEST_IMAGE_DATA_CHARS,
  isImageDataUrl,
} from "@/lib/limits";

/*
 * The chat route and the history store measure images as base64 characters
 * while the browser measures files as bytes. These are the checks that keep the
 * byte ceilings the visitor is told from naming a file the character ceilings
 * then refuse.
 */

/** Longest realistic data URL prefix: `data:image/heif;base64,`. */
const PREFIX = "data:image/heif;base64,";

const uploadChars = (bytes: number) => Math.ceil(bytes / 3) * 4 + PREFIX.length;

const file = (name: string, size: number, type = "image/png"): PickedFile => ({
  name,
  size,
  type,
});

const image = (chars: number) => `${PREFIX}${"A".repeat(chars - PREFIX.length)}`;

describe("the image ceilings the browser is told", () => {
  it("base64-expands inside the per-image ceiling the server applies", () => {
    expect(uploadChars(MAX_IMAGE_BYTES)).toBeLessThanOrEqual(MAX_IMAGE_DATA_CHARS);
  });

  it("fills every slot of one message without passing the request ceiling", () => {
    const batch = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, (_, index) =>
      file(`shot-${index}.png`, Math.floor(MAX_MESSAGE_IMAGE_BYTES / MAX_IMAGES_PER_MESSAGE)),
    );

    expect(attachmentRejection([], batch)).toBeUndefined();
    expect(
      batch.reduce((total, item) => total + uploadChars(item.size), 0),
    ).toBeLessThanOrEqual(MAX_REQUEST_IMAGE_DATA_CHARS);
  });

  it("takes the lopsided batch that spends the whole message budget", () => {
    const batch = [
      file("big.png", MAX_IMAGE_BYTES),
      file("rest.png", MAX_MESSAGE_IMAGE_BYTES - MAX_IMAGE_BYTES),
    ];

    expect(attachmentRejection([], batch)).toBeUndefined();
    expect(
      batch.reduce((total, item) => total + uploadChars(item.size), 0),
    ).toBeLessThanOrEqual(MAX_REQUEST_IMAGE_DATA_CHARS);
  });

  it("leaves the rest of the body for the text of the request", () => {
    expect(MAX_IMAGE_BYTES).toBeLessThan(MAX_MESSAGE_IMAGE_BYTES);
    expect(MAX_REQUEST_IMAGE_DATA_CHARS).toBeLessThan(MAX_CHAT_BODY_BYTES);
  });
});

describe("attachmentRejection", () => {
  it("names a file that could never reach a vision model", () => {
    expect(attachmentRejection([], [file("diagram.svg", 1000, "image/svg+xml")])).toMatch(
      /not a supported image/,
    );
  });

  it("offers the picker exactly the formats the server parses", () => {
    for (const format of IMAGE_FORMATS) {
      expect(IMAGE_ACCEPT_ATTRIBUTE).toContain(`image/${format}`);
      expect(isImageDataUrl(`data:image/${format};base64,QUJD`)).toBe(true);
    }

    expect(isImageDataUrl("data:image/svg+xml;base64,QUJD")).toBe(false);
    expect(isImageDataUrl("https://example.com/a.png")).toBe(false);
  });

  it("refuses a second large image before it is read", () => {
    const rejection = attachmentRejection(
      [file("a.png", MAX_IMAGE_BYTES)],
      [file("b.png", MAX_IMAGE_BYTES)],
    );

    expect(rejection).toMatch(/in total|per message/);
  });

  it("refuses the fifth image of a message", () => {
    const already = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, (_, index) =>
      file(`shot-${index}.png`, 1024),
    );

    expect(attachmentRejection(already, [file("one-more.png", 1024)])).toMatch(
      `up to ${MAX_IMAGES_PER_MESSAGE} images per message`,
    );
  });

  it("states the size ceiling in the same words as the pricing page", () => {
    const rejection = attachmentRejection([], [file("huge.png", MAX_IMAGE_BYTES + 1)]);

    expect(rejection).toContain(`${(MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(1)} MB`);
  });
});

describe("fitImageBudget", () => {
  it("leaves a request that already fits alone", () => {
    const messages = [
      { role: "user" as const, content: "first", images: [image(1000)] },
      { role: "user" as const, content: "second", images: [image(2000)] },
    ];

    expect(fitImageBudget(messages)).toEqual(messages);
  });

  it("keeps the newest attachments when the thread has outgrown one request", () => {
    // Two of these already spend the budget, so only the newest survives.
    const big = MAX_REQUEST_IMAGE_DATA_CHARS / 2 + 1;
    const messages = [
      { role: "user" as const, content: "oldest", images: [image(big)] },
      { role: "assistant" as const, content: "answered earlier" },
      { role: "user" as const, content: "previous", images: [image(big)] },
      { role: "user" as const, content: "this turn", images: [image(big)] },
    ];

    const trimmed = fitImageBudget(messages);

    expect(trimmed[3].images).toHaveLength(1);
    expect(trimmed[2].images).toBeUndefined();
    expect(trimmed[0].images).toBeUndefined();
    expect(trimmed[1].content).toBe("answered earlier");
  });

  it("does not change the transcript it was given", () => {
    const messages = [{ role: "user" as const, content: "hi", images: [image(900)] }];
    const before = structuredClone(messages);

    expect(fitImageBudget(messages)).not.toBe(messages);
    expect(messages).toEqual(before);
  });
});
