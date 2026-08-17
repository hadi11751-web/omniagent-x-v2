import { createOpenAiCompatibleProvider } from "./openaiCompatible";

/** Hugging Face router exposes an OpenAI-compatible endpoint for chat models. */
export const huggingFaceProvider = createOpenAiCompatibleProvider({
  id: "huggingface",
  label: "Hugging Face",
  execution: "cloud",
  baseUrl: () => "https://router.huggingface.co/v1",
  apiKey: () => process.env.HUGGINGFACE_API_KEY,
  requiresKey: true,
});
