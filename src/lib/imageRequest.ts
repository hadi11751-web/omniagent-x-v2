const IMAGE_COMMAND =
  /^\s*(?:(?:(?:please|can you|could you|would you|i want you to|i'd like you to)\s+)?(?:generate_image\b|(?:generate|create|make|produce)\s+(?:me\s+)?(?:(?:a|an|the)\s+)?(?:image|picture|photo|portrait|illustration|drawing|artwork|scene|poster|logo|icon|avatar)\b|(?:draw|paint|sketch|illustrate|render|depict)\s+(?:me\s+)?(?:(?:a|an|the)\s+)?|(?:image|picture|photo|portrait|illustration|drawing|artwork|scene|poster|logo|icon|avatar)\s+of\b))/i;

const CONVERSATIONAL_PREFIX =
  /^(?:please|can you|could you|would you|i want you to|i'd like you to)\s+/i;

const GENERATION_PREFIX =
  /^(?:generate|create|make|produce)\s+(?:me\s+)?/i;

const DRAWING_PREFIX =
  /^(?:draw|paint|sketch|illustrate|render|depict)\s+(?:me\s+)?/i;

const IMAGE_WRAPPER =
  /^(?:a|an|the)\s+(?:image|picture|photo)\b/i;

const STYLED_VISUAL =
  /^(?:a|an|the)\s+(?:portrait|illustration|drawing|artwork|scene|poster|logo|icon|avatar)\b/i;

const DIRECT_VISUAL =
  /^(?:image|picture|photo|portrait|illustration|drawing|artwork|scene|poster|logo|icon|avatar)\s+of\b/i;

function stripOfOrFor(value: string): string {
  return value
    .replace(/^\s*(?:of|for)\b\s*/i, "")
    .replace(/^\s*[:,-]\s*/, "")
    .trim();
}

export function isDirectImageRequest(prompt: string): boolean {
  return IMAGE_COMMAND.test(prompt.trim());
}

export function extractImagePrompt(prompt: string): string {
  let value = prompt.trim();

  value = value.replace(CONVERSATIONAL_PREFIX, "");

  if (/^generate_image\b/i.test(value)) {
    value = value.replace(/^generate_image\b\s*/i, "");
    return stripOfOrFor(value);
  }

  if (GENERATION_PREFIX.test(value)) {
    value = value.replace(GENERATION_PREFIX, "");

    if (IMAGE_WRAPPER.test(value)) {
      value = value.replace(IMAGE_WRAPPER, "");
      return stripOfOrFor(value);
    }

    if (STYLED_VISUAL.test(value)) {
      value = value.replace(/^(?:a|an|the)\s+/i, "");
      return value.trim();
    }

    return value.replace(/^\s*[:,-]\s*/i, "").trim();
  }

  if (DRAWING_PREFIX.test(value)) {
    value = value.replace(DRAWING_PREFIX, "");
    return value
      .replace(/^(?:(?:a|an|the)\s+)/i, "")
      .replace(/^\s*[:,-]\s*/i, "")
      .trim();
  }

  if (DIRECT_VISUAL.test(value)) {
    value = value.replace(
      /^(?:image|picture|photo|portrait|illustration|drawing|artwork|scene|poster|logo|icon|avatar)\s+of\b\s*/i,
      "",
    );
    return value.trim();
  }

  return value.trim();
}
