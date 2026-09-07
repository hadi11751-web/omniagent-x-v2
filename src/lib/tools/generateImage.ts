import type { ToolDefinition } from "@/lib/types";

const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY?.trim();
const GEMINI_MODEL = "gemini-3.1-flash-image";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";

export function imageGenerationAvailable(): boolean {
  return Boolean(GEMINI_API_KEY());
}

export async function generateImage(prompt: string): Promise<string> {
  const key = GEMINI_API_KEY();

  if (!key) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-goog-api-key": key,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input: prompt.trim(),
        response_format: {
          type: "image",
          aspect_ratio: "1:1",
          image_size: "1K",
        },
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      let detail = raw.slice(0, 300);

      try {
        const parsed = JSON.parse(raw) as {
          error?: {
            message?: string;
          };
        };

        detail = parsed.error?.message ?? detail;
      } catch {
        // Keep the raw response excerpt.
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Gemini image generation authentication failed (${response.status}). Check GEMINI_API_KEY in Vercel.`,
        );
      }

      if (response.status === 429) {
        throw new Error(
          "Gemini image generation is temporarily rate-limited. Please try again shortly.",
        );
      }

      if (response.status >= 500) {
        throw new Error(
          `Gemini image generation is temporarily unavailable (${response.status}). Please try again shortly.`,
        );
      }

      throw new Error(
        `Gemini image request failed (${response.status}): ${detail}`,
      );
    }

    let data: {
      output_image?: {
        data?: string;
        mime_type?: string;
      };
    };

    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      throw new Error("Gemini returned an invalid JSON response");
    }

    const image = data.output_image;

    if (!image?.data) {
      throw new Error("Gemini returned no generated image");
    }

    const mimeType = image.mime_type || "image/png";

    return `data:${mimeType};base64,${image.data}`;
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
