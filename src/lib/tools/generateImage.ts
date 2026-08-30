import type { ToolDefinition } from "@/lib/types";

/**
 * Pollinations.ai is a genuinely free, key-less image generation API:
 * https://image.pollinations.ai/prompt/<url-encoded prompt> returns the
 * image bytes directly over a plain GET, no auth headers, no account, no
 * billing page. This replaces the old Hugging Face implementation, which
 * required navigating Hugging Face's Inference Providers permissions and
 * billing requirements for what's meant to be a simple free feature.
 */
export function imageGenerationAvailable(): boolean {
  return true;
}

/** Returns a data URL so the browser can render the image without extra storage. */
export async function generateImage(prompt: string): Promise<string> {
  const encoded = encodeURIComponent(prompt.trim());
  const url = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Pollinations image request failed (${response.status})`);
  }
  const contentType = response.headers.get("content-type") ?? "image/jpeg";
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!contentType.startsWith("image/")) {
    throw new Error(`provider returned ${contentType} instead of an image`);
  }
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

export const generateImageTool: ToolDefinition = {
  name: "generate_image",
  description: "Generate an image from a text prompt. Only call this when the user asks for a picture.",
  argument: "the image prompt",
  async run(input) {
    try {
      const dataUrl = await generateImage(input.trim());
      return {
        ok: true,
        content: `Generated an image for: ${input.trim()}. It is shown to the user.`,
        data: { image: dataUrl },
      };
    } catch (error) {
      return { ok: false, content: `generate_image error: ${(error as Error).message}` };
    }
  },
};
