import { GoogleGenAI } from "@google/genai";
import type { ChatProvider, ChatRequest } from "@/lib/types";

export const geminiProvider: ChatProvider = {
  id: "gemini",
  label: "Gemini",
  execution: "cloud",

  isConfigured: () => Boolean(process.env.GEMINI_API_KEY?.trim()),

  async *stream(request: ChatRequest) {
    const key = process.env.GEMINI_API_KEY?.trim();

    if (!key) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    const ai = new GoogleGenAI({
      apiKey: key,
    });

    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");

    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: m.content }],
      }));

    const response = await ai.models.generateContentStream({
      model: request.model,
      contents,
      ...(system
        ? {
            config: {
              systemInstruction: system,
            },
          }
        : {}),
    });

    for await (const chunk of response) {
      const text = chunk.text;

      if (text) {
        yield text;
      }
    }
  },
};