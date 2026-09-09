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

export type Mode =
  | "chat"
  | "research"
  | "agent"
  | "blend";

export interface ModelInfo {
  id: string;
  label: string;
  provider: ProviderId;
  execution: Execution;
  capabilities: Capability[];
  vision?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
  isConfigured(): boolean;
  stream(request: ChatRequest): AsyncGenerator<string>;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  data?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  argument: string;
  run(input: string): Promise<ToolResult>;
}

export interface Source {
  title: string;
  url: string;
  snippet?: string;
}

export interface UiToolCall {
  name: string;
  argument: string;
  ok: boolean;
  summary: string;
}

export interface UiFile {
  dataUrl: string;
  filename: string;
}

export interface UiMessageMeta {
  model: string;
  provider: string;
  execution: Execution;
  capability?: Capability;
  mode: Mode;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
  meta?: UiMessageMeta;
  status?: string[];
  tools?: UiToolCall[];
  images?: string[];
  files?: UiFile[];
  sources?: Source[];
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;
  projectId: string;
  createdAt: number;
  updatedAt?: number;
  messages: UiMessage[];
}

export interface Project {
  id: string;
  name: string;
  context: string;
}

export interface Settings {
  model: string;
  projectId: string;
  mode: Mode;
  autoRoute: boolean;
  toolsEnabled: boolean;
  saveHistory: boolean;
  memoryEnabled: boolean;
  memory: string;
}

export interface ServerStatus {
  providers: Array<{
    id: ProviderId;
    label: string;
    execution: Execution;
  }>;
  models: ModelInfo[];
  tools: Array<{
    name: string;
    description: string;
  }>;
  imageGeneration: boolean;
  voiceInput: boolean;
  visionInput: boolean;
  searchEngine: string;
}
