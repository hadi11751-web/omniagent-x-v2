import { requestJson } from "@/lib/http";
import type { ToolDefinition } from "@/lib/types";

const HF_MODEL = "black-forest-labs/FLUX.1-schnell";

export function imageGenerationAvailable(): boolean {
  return Boolean(process.env.HUGGINGFACE_API_KEY);
}

/** Returns a data URL so the browser can render the image without extra storage. */
export async function generateImage(prompt: string): Promise<string> {
  const key = process.env.HUGGINGFACE_API_KEY;
  if (!key) throw new Error("image generation needs HUGGINGFACE_API_KEY in .env.local");
  const response = await requestJson(
    "Hugging Face image",
    `https://api-inference.huggingface.co/models/${HF_MODEL}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ inputs: prompt }),
      timeoutMs: 120_000,
    },
  );
  const contentType = response.headers.get("content-type") ?? "image/png";
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
