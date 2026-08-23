export type ProviderId =
  | "groq"
  | "gemini"
  | "openrouter"
  | "huggingface"
  | "ollama";

export type Execution = "cloud" | "local";

export type Capability =
  | "fast"
  | "coding"
  | "reasoning"
  | "research"
  | "image"
  | "private";

export interface ModelInfo {
  id: string;
  label: string;
  provider: ProviderId;
  execution: Execution;
  capabilities: Capability[];
  /** True for models that can accept image input (screenshots, photos, etc). */
  vision?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Data URLs of images attached to this message, for vision-capable models. */
  images?: string[];
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatProvider {
  id: ProviderId;
  label: string;
  execution: Execution;
  /** True when the server has everything it needs to call this provider. */
  isConfigured(): boolean;
  /** Yields incremental text chunks. Providers without native streaming yield once. */
  stream(request: ChatRequest): AsyncGenerator<string>;
}

export interface ToolResult {
  ok: boolean;
  /** Text handed back to the model. */
  content: string;
  /** Optional structured payload the UI can render (sources, images...). */
  data?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Human readable description of the single string argument the tool takes. */
  argument: string;
  run(input: string): Promise<ToolResult>;
}

export interface Source {
  title: string;
  url: string;
  snippet?: string;
}

