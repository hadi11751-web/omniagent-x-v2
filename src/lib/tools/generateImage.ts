import type { ToolDefinition } from "@/lib/types";

const POLLINATIONS_API_KEY = () => process.env.POLLINATIONS_API_KEY?.trim();
const POLLINATIONS_BASE_URL = "https://gen.pollinations.ai";

export function imageGenerationAvailable(): boolean {
  return Boolean(POLLINATIONS_API_KEY());
}

export async function generateImage(prompt: string): Promise<string> {
  const key = POLLINATIONS_API_KEY();

  if (!key) {
    throw new Error("POLLINATIONS_API_KEY is not configured");
  }

  const encoded = encodeURIComponent(prompt.trim());
  const url = `${POLLINATIONS_BASE_URL}/image/${encoded}?model=flux`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "image/*",
      },
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Pollinations image request failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.startsWith("image/")) {
      throw new Error(
        `provider returned ${contentType || "unknown content type"} instead of an image`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    return `data:${contentType};base64,${buffer.toString("base64")}`;
  } finally {
    clearTimeout(timeout);
  }
}

export const generateImageTool: ToolDefinition = {
  name: "generate_image",
  description:
    "Generate an image from a text prompt. Only call this when the user asks for a picture.",
  argument: "the image prompt",

  async run(input) {
    try {
      const prompt = input.trim();
      if (!prompt) {
        return {
          ok: false,
          content: "generate_image error: image prompt is empty",
        };
      }

      const dataUrl = await generateImage(prompt);

      return {
        ok: true,
        content: `Generated an image for: ${prompt}. It is shown to the user.`,
        data: { image: dataUrl },
      };
    } catch (error) {
      return {
        ok: false,
        content: `generate_image error: ${(error as Error).message}`,
      };
    }
  },
};
