export type ProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "xai"
  | "deepseek"
  | "perplexity"
  | "groq"
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
  /**
   * Exact model identifier sent to the provider API.
   * This must be a real provider model ID, never a marketing-only name.
   */
  id: string;

  /** Human-readable name shown in the UI. */
  label: string;

  /** Provider responsible for the model API call. */
  provider: ProviderId;

  /** Cloud or local execution. */
  execution: Execution;

  /** Capabilities used by automatic routing and failover ranking. */
  capabilities: Capability[];

  /** True when the model accepts image input. */
  vision?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;

  /**
   * Data URLs for images attached to the message.
   * Providers that support vision may transform these into their wire format.
   */
  images?: string[];
}

export interface ChatRequest {
  /** Exact provider API model ID. */
  model: string;

  messages: ChatMessage[];

  /**
   * Optional legacy sampling control.
   * Providers may intentionally ignore this when their current API
   * generation controls do not support it.
   */
  temperature?: number;

  /** Allows the request to be cancelled by the caller. */
  signal?: AbortSignal;
}

export interface ChatProvider {
  id: ProviderId;
  label: string;
  execution: Execution;

  /**
   * True only when the provider has everything required to make
   * a request safely from the server.
   */
  isConfigured(): boolean;

  /**
   * Stream assistant text incrementally.
   * Providers without native streaming may yield a single final chunk.
   */
  stream(request: ChatRequest): AsyncGenerator<string>;
}

export interface ToolResult {
  ok: boolean;

  /** Text handed back to the model/agent. */
  content: string;

  /** Optional structured payload consumed by the UI. */
  data?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;

  /** Human-readable description of the single string input. */
  argument: string;

  run(input: string): Promise<ToolResult>;
}

export interface Source {
  title: string;
  url: string;
  snippet?: string;
}
