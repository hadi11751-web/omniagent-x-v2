import type { ModelInfo, Source } from "@/lib/types";

export type Mode = "chat" | "research" | "blend" | "agent";

export type UiMessageRole = "user" | "assistant";

export type UiMessageStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "error";

export interface UiMessageMeta {
  model?: string;
  provider?: string;
  execution?: "cloud" | "local";
  capability?: string;
  mode?: Mode;
}

export interface UiTool {
  name: string;
  argument?: string;
  ok: boolean;
  summary?: string;
}

export interface UiFile {
  dataUrl: string;
  filename: string;
}

export interface UiMessage {
  id: string;
  role: UiMessageRole;
  content: string;
  createdAt?: number;
  meta?: UiMessageMeta;
  status?: UiMessageStatus | UiMessageStatus[];
  tools?: UiTool[];
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
  updatedAt: number;
  messages: UiMessage[];
}

export interface Project {
  id: string;
  name: string;
  context: string;
}

export interface ServerProvider {
  id: string;
  label: string;
  execution: "cloud" | "local";
}

export interface ServerTool {
  name: string;
  description: string;
}

export interface ServerStatus {
  providers: ServerProvider[];
  models: ModelInfo[];
  tools: ServerTool[];
  imageGeneration: boolean;
  voiceInput: boolean;
  visionInput: boolean;
  searchEngine: string;
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
