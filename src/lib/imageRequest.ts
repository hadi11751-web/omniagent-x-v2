const IMAGE_COMMAND =
  /^\s*(?:please\s+)?(?:generate_image|generate(?:\s+an?)?\s+image|create(?:\s+an?)?\s+image|make(?:\s+an?)?\s+image)\b/i;

export function isDirectImageRequest(prompt: string): boolean {
  return IMAGE_COMMAND.test(prompt.trim());
}

export function extractImagePrompt(prompt: string): string {
  let value = prompt.trim();

  value = value.replace(IMAGE_COMMAND, "");
  value = value.replace(/^\s*(?:of|for)\b\s*/i, "");
  value = value.replace(/^\s*[:,-]\s*/, "");

  return value.trim();
}
