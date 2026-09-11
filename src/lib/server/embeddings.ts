import { requestJson } from "@/lib/http";

const GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const GEMINI_EMBEDDING_DIMENSION = 768;
const MAX_EMBEDDING_INPUT = 8_000;

interface GeminiEmbeddingResponse {
  embedding?: {
    values?: unknown;
  };
}

function getGeminiApiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();

  if (!key) {
    throw new Error("Gemini embeddings are not configured");
  }

  return key;
}

function validateEmbedding(values: unknown): number[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Gemini embeddings returned an invalid vector");
  }

  const vector = values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );

  if (vector.length !== values.length) {
    throw new Error("Gemini embeddings returned non-numeric values");
  }

  return vector;
}

export function cosineSimilarity(
  left: number[],
  right: number[],
): number {
  if (
    left.length === 0 ||
    left.length !== right.length
  ) {
    return 0;
  }

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];

    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return (
    dot /
    (Math.sqrt(leftMagnitude) *
      Math.sqrt(rightMagnitude))
  );
}

export async function createEmbedding(
  text: string,
): Promise<number[]> {
  const input = text.trim().slice(0, MAX_EMBEDDING_INPUT);

  if (!input) {
    return [];
  }

  const response = await requestJson(
    "Gemini embeddings",
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": getGeminiApiKey(),
      },
      body: JSON.stringify({
        model: `models/${GEMINI_EMBEDDING_MODEL}`,
        content: {
          parts: [{ text: input }],
        },
        outputDimensionality: GEMINI_EMBEDDING_DIMENSION,
      }),
    },
  );

  const payload =
    (await response.json()) as GeminiEmbeddingResponse;

  return validateEmbedding(payload.embedding?.values);
}
