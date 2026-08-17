import type { Capability, Execution, ModelInfo, Source } from "@/lib/types";

export type Mode = "chat" | "research" | "blend" | "agent";

export interface ToolTrace {
  name: string;
  argument: string;
  ok: boolean;
  summary: string;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  images?: string[];
  tools?: ToolTrace[];
  status?: string[];
  error?: string;
  meta?: { model: string; provider: string; execution: Execution; capability?: Capability; mode: Mode };
}

export interface Conversation {
  id: string;
  title: string;
  projectId: string;
  createdAt: number;
  messages: UiMessage[];
}

export interface Project {
  id: string;
  name: string;
  context: string;
}

export interface Settings {
  model: string;
  mode: Mode;
  autoRoute: boolean;
  toolsEnabled: boolean;
  saveHistory: boolean;
  memoryEnabled: boolean;
  memory: string;
}

export interface ServerStatus {
  providers: { id: string; label: string; execution: Execution }[];
  models: ModelInfo[];
  tools: { name: string; description: string }[];
  imageGeneration: boolean;
  searchEngine: string;
}
