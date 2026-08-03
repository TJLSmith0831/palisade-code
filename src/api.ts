import { invoke } from "@tauri-apps/api/core";

export type Mode = "spec" | "go";

export type Project = {
  hash: string;
  root: string;
  displayName: string;
  createdAt: string;
  lastAccessedAt: string;
};

export type ThreadMeta = {
  id: string;
  projectHash: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  currentMode: Mode;
  openSpecChangeName: string | null;
  executorSessionId: string | null;
};

export type Message = {
  seq: number;
  ts: string;
  role: "user" | "assistant" | "system" | "tool";
  mode: Mode;
  content: string;
};

export const listProjects = () => invoke<Project[]>("list_projects");
export const addProject = (path: string) => invoke<Project>("add_project", { path });
export const switchProject = (hash: string) => invoke<Project>("switch_project", { hash });
export const renameProject = (hash: string, displayName: string) =>
  invoke<Project>("rename_project", { hash, displayName });

export const createThread = (projectHash: string, title: string) =>
  invoke<ThreadMeta>("create_thread", { projectHash, title });
export const listThreads = (projectHash: string) =>
  invoke<ThreadMeta[]>("list_threads", { projectHash });
export const renameThread = (projectHash: string, threadId: string, title: string) =>
  invoke<ThreadMeta>("rename_thread", { projectHash, threadId, title });
export const setThreadMode = (projectHash: string, threadId: string, mode: Mode) =>
  invoke<ThreadMeta>("set_thread_mode", { projectHash, threadId, mode });

export const appendMessage = (
  projectHash: string,
  threadId: string,
  role: Message["role"],
  mode: Mode,
  content: string,
) => invoke<Message>("append_message", { projectHash, threadId, role, mode, content });
export const readThread = (projectHash: string, threadId: string) =>
  invoke<Message[]>("read_thread", { projectHash, threadId });

// ------------------------------------------------------- executor handoff

export type Preflight = {
  claude: string | null;
  codex: string | null;
  selected: "claude" | "codex" | null;
  openspec: boolean;
  grillApply: boolean;
  ponytail: boolean;
  ready: boolean;
  warnings: string[];
  checkedAt: string;
};

/** Mirrors the Rust `ExecutorEvent` enum, tagged by `kind`. */
export type ExecutorEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "fileEdit"; id: string; path: string; before: string; after: string }
  | { kind: "toolCall"; id: string; name: string; command: string }
  | { kind: "toolResult"; id: string; output: string; isError: boolean }
  | { kind: "done" }
  | { kind: "crashed"; exitCode: number | null; message: string };

export const preflight = (refresh = false) => invoke<Preflight>("preflight", { refresh });
export const sendMessage = (projectHash: string, threadId: string, content: string, mode: Mode) =>
  invoke<Message>("send_message", { projectHash, threadId, content, mode });
export const goMode = (projectHash: string, threadId: string) =>
  invoke<ThreadMeta>("go_mode", { projectHash, threadId });
export const specMode = (projectHash: string, threadId: string) =>
  invoke<ThreadMeta>("spec_mode", { projectHash, threadId });
export const propose = (projectHash: string, threadId: string) =>
  invoke<void>("propose", { projectHash, threadId });
export const stopExecutor = () => invoke<void>("stop_executor");

// ----------------------------------------------------------------- graphify

export type GraphifyOptions = { incremental: boolean; codeOnly: boolean; deep: boolean };

export type GraphifyRun = {
  outDir: string;
  report: string;
  graph: { nodes?: unknown[]; links?: unknown[] } | null;
  summary: string;
};

export const runGraphify = (
  projectHash: string,
  threadId: string,
  subpath: string,
  options: GraphifyOptions,
) => invoke<GraphifyRun>("run_graphify", { projectHash, threadId, subpath, options });
export const loadGraphify = (projectHash: string) =>
  invoke<GraphifyRun>("load_graphify", { projectHash });
export const queryGraphify = (projectHash: string, subcommand: string, question: string) =>
  invoke<string>("query_graphify", { projectHash, subcommand, question });

export const createNote = (projectHash: string, name: string) =>
  invoke<string>("create_note", { projectHash, name });
export const listNotes = (projectHash: string) => invoke<string[]>("list_notes", { projectHash });
export const readNote = (projectHash: string, name: string) =>
  invoke<string>("read_note", { projectHash, name });
export const writeNote = (projectHash: string, name: string, content: string) =>
  invoke<void>("write_note", { projectHash, name, content });
