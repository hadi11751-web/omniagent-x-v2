export type Execution = "cloud" | "local";

export type Mode = "chat" | "research" | "agent";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
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
  model: "Nexus";
  execution: Execution;
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
  projectId: string;
  mode: Mode;
  toolsEnabled: boolean;
  saveHistory: boolean;
  memoryEnabled: boolean;
  memory: string;
}

export interface ServerStatus {
  /** Nexus is the only model. Nothing here says what engine runs it. */
  nexus: {
    label: "Nexus";
    ready: boolean;
    vision: boolean;
    execution: Execution | null;
  };
  tools: Array<{
    name: string;
    description: string;
  }>;
  imageGeneration: boolean;
  voiceInput: boolean;
  visionInput: boolean;
  searchEngine: string;
}
