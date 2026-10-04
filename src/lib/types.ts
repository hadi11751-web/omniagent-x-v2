export type Execution = "cloud" | "local";

/**
 * The only model OmniAgent exposes. There is no model picker, no provider
 * list and no routing between models: Nexus is the one reasoning model and
 * everything else (search, files, images, memory) is a tool it calls.
 */
export interface ModelInfo {
  id: "nexus";
  label: "Nexus";

  /** Where Nexus's backend runs. Decides what a private request may do. */
  execution: Execution;

  /** True when this deployment's Nexus backend can read images. */
  vision: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;

  /** Data URLs of images attached to this message. */
  images?: string[];
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  signal?: AbortSignal;
  /** Native tool definitions for providers that support function calling. */
  tools?: ProviderToolDefinition[];
}

export interface ChatProvider {
  id: "nexus";
  label: string;
  execution: Execution;

  /** True when the server has everything required to call this provider. */
  isConfigured(): boolean;

  /**
   * Yields incremental text chunks.
   * Providers without native streaming may yield one final chunk.
   */
  stream(request: ChatRequest): AsyncGenerator<string>;
}

export interface ToolResult {
  ok: boolean;

  /** Text handed back to the model. */
  content: string;

  /** Optional structured payload the UI can render. */
  data?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;

  /** Human-readable description of the single string argument. */
  argument: string;

  /**
   * `signal` is the requesting turn's abort signal, so a tool that spends
   * minutes and money upstream stops when nobody is listening any more. Tools
   * that finish in process can ignore it.
   */
  run(input: string, signal?: AbortSignal): Promise<ToolResult>;
}

export interface Source {
  title: string;
  url: string;
  snippet?: string;
}
