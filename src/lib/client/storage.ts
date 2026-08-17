import type { Conversation, Project, Settings } from "./types";

const KEYS = {
  conversations: "omniagent.conversations.v1",
  projects: "omniagent.projects.v1",
  settings: "omniagent.settings.v1",
} as const;

export const DEFAULT_PROJECTS: Project[] = [
  { id: "general", name: "General", context: "" },
  { id: "coding", name: "Coding", context: "The user mostly asks about software engineering." },
  { id: "research", name: "Research", context: "Prefer sourced, factual answers." },
  { id: "school", name: "School", context: "Explain concepts step by step." },
  { id: "personal", name: "Personal", context: "" },
];

export const DEFAULT_SETTINGS: Settings = {
  model: "",
  projectId: "general",
  mode: "chat",
  autoRoute: false,
  toolsEnabled: true,
  saveHistory: true,
  memoryEnabled: false,
  memory: "",
};

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked - the app keeps working in memory */
  }
}

export const storage = {
  loadConversations: () => read<Conversation[]>(KEYS.conversations, []),
  saveConversations: (conversations: Conversation[]) => write(KEYS.conversations, conversations),
  clearConversations: () => {
    if (typeof window !== "undefined") window.localStorage.removeItem(KEYS.conversations);
  },
  loadProjects: () => read<Project[]>(KEYS.projects, DEFAULT_PROJECTS),
  saveProjects: (projects: Project[]) => write(KEYS.projects, projects),
  loadSettings: () => ({ ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(KEYS.settings, {}) }),
  saveSettings: (settings: Settings) => write(KEYS.settings, settings),
};

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 42 ? `${clean.slice(0, 42)}...` : clean || "New chat";
}
