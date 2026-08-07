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
export const addProject = (path: string) =>
  invoke<Project>("add_project", { path });
export const switchProject = (hash: string) =>
  invoke<Project>("switch_project", { hash });
export const renameProject = (hash: string, displayName: string) =>
  invoke<Project>("rename_project", { hash, displayName });

export const createThread = (projectHash: string, title: string) =>
  invoke<ThreadMeta>("create_thread", { projectHash, title });
export const listThreads = (projectHash: string) =>
  invoke<ThreadMeta[]>("list_threads", { projectHash });
export const renameThread = (
  projectHash: string,
  threadId: string,
  title: string,
) => invoke<ThreadMeta>("rename_thread", { projectHash, threadId, title });
export const setThreadMode = (
  projectHash: string,
  threadId: string,
  mode: Mode,
) => invoke<ThreadMeta>("set_thread_mode", { projectHash, threadId, mode });
export const deleteThread = (projectHash: string, threadId: string) =>
  invoke<void>("delete_thread", { projectHash, threadId });

export const appendMessage = (
  projectHash: string,
  threadId: string,
  role: Message["role"],
  mode: Mode,
  content: string,
) =>
  invoke<Message>("append_message", {
    projectHash,
    threadId,
    role,
    mode,
    content,
  });
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
  graphify: boolean;
  ready: boolean;
  warnings: string[];
  checkedAt: string;
};

/** Mirrors the Rust `ExecutorEvent` enum, tagged by `kind`. */
export type ExecutorEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "textDelta"; text: string }
  | { kind: "reasoningDelta"; text: string }
  | {
      kind: "fileEdit";
      id: string;
      path: string;
      before: string;
      after: string;
    }
  | { kind: "toolCall"; id: string; name: string; command: string }
  | { kind: "toolResult"; id: string; output: string; isError: boolean }
  | { kind: "done" }
  | { kind: "crashed"; exitCode: number | null; message: string };

export const preflight = (refresh = false) =>
  invoke<Preflight>("preflight", { refresh });
export const sendMessage = (
  projectHash: string,
  threadId: string,
  content: string,
  mode: Mode,
) => invoke<Message>("send_message", { projectHash, threadId, content, mode });
export const goMode = (projectHash: string, threadId: string) =>
  invoke<ThreadMeta>("go_mode", { projectHash, threadId });
export const specMode = (projectHash: string, threadId: string) =>
  invoke<ThreadMeta>("spec_mode", { projectHash, threadId });
export const propose = (projectHash: string, threadId: string) =>
  invoke<void>("propose", { projectHash, threadId });
export const stopExecutor = () => invoke<void>("stop_executor");

// ----------------------------------------------------------------- graphify

export type GraphifyOptions = {
  incremental: boolean;
  codeOnly: boolean;
  deep: boolean;
};

export type GraphifyRun = {
  outDir: string;
  report: string;
  graph: { nodes?: unknown[]; links?: unknown[] } | null;
  summary: string;
};

export const runGraphify = (projectHash: string, subpath: string, options: GraphifyOptions) =>
  invoke<GraphifyRun>("run_graphify", {
    projectHash,
    subpath,
    options,
  });
export const loadGraphify = (projectHash: string) =>
  invoke<GraphifyRun>("load_graphify", { projectHash });
export const queryGraphify = (
  projectHash: string,
  subcommand: string,
  args: string[],
) => invoke<string>("query_graphify", { projectHash, subcommand, args });

// ---------------------------------------------------------------- terminal

export const terminalSpawn = (projectHash: string) =>
  invoke<void>("terminal_spawn", { projectHash });
export const terminalInput = (data: string) =>
  invoke<void>("terminal_input", { data });
export const terminalResize = (cols: number, rows: number) =>
  invoke<void>("terminal_resize", { cols, rows });
export const terminalKill = () => invoke<void>("terminal_kill");

// --------------------------------------------------------------------- git

export type FileStatus = { path: string; code: string };

export const gitStatus = (projectHash: string) =>
  invoke<FileStatus[]>("git_status", { projectHash });
export const gitWorkingDiff = (projectHash: string) =>
  invoke<string>("git_working_diff", { projectHash });
export const gitStagedDiff = (projectHash: string) =>
  invoke<string>("git_staged_diff", { projectHash });
export const gitStageHunk = (projectHash: string, patch: string) =>
  invoke<void>("git_stage_hunk", { projectHash, patch });
export const gitUnstageHunk = (projectHash: string, patch: string) =>
  invoke<void>("git_unstage_hunk", { projectHash, patch });
export const gitStageFile = (projectHash: string, path: string) =>
  invoke<void>("git_stage_file", { projectHash, path });
export const gitCommit = (projectHash: string, message: string) =>
  invoke<void>("git_commit", { projectHash, message });

export type BranchInfo = { name: string; isCurrent: boolean; isRemote: boolean };

export const gitBranches = (projectHash: string) =>
  invoke<BranchInfo[]>("git_branches", { projectHash });
export const gitCheckoutBranch = (projectHash: string, name: string) =>
  invoke<void>("git_checkout_branch", { projectHash, name });
export const gitCreateBranch = (projectHash: string, name: string) =>
  invoke<void>("git_create_branch", { projectHash, name });
export const gitDeleteBranch = (projectHash: string, name: string) =>
  invoke<void>("git_delete_branch", { projectHash, name });
export const gitFetch = (projectHash: string) => invoke<void>("git_fetch", { projectHash });
export const gitPull = (projectHash: string) => invoke<string>("git_pull", { projectHash });
export const gitPush = (projectHash: string) => invoke<string>("git_push", { projectHash });
export const gitAheadBehind = (projectHash: string) =>
  invoke<[number, number] | null>("git_ahead_behind", { projectHash });
export const gitDiscardFile = (projectHash: string, path: string, untracked: boolean) =>
  invoke<void>("git_discard_file", { projectHash, path, untracked });
export const gitIsRepo = (projectHash: string) => invoke<boolean>("git_is_repo", { projectHash });
export const gitInit = (projectHash: string) => invoke<void>("git_init", { projectHash });

// --------------------------------------------------------------- file tree

export type DirEntry = {
  name: string;
  is_dir: boolean;
  path: string;
};

export const listDirectory = (projectHash: string, relativePath: string, includeHidden = false) =>
  invoke<DirEntry[]>("list_directory", { projectHash, relativePath, includeHidden });

export const listAllFiles = (projectHash: string) =>
  invoke<string[]>("list_all_files", { projectHash });

export type TextMatch = { path: string; line: number; text: string };

export const searchText = (projectHash: string, query: string) =>
  invoke<TextMatch[]>("search_text", { projectHash, query });

export const readFileContent = (projectHash: string, relativePath: string) =>
  invoke<string>("read_file_content", { projectHash, relativePath });

export const readFileBase64 = (projectHash: string, relativePath: string) =>
  invoke<string>("read_file_base64", { projectHash, relativePath });

/** Resolves to a format-on-save summary (D14), or `null` if nothing matched. */
export const writeFileContent = (
  projectHash: string,
  relativePath: string,
  content: string,
) => invoke<string | null>("write_file_content", { projectHash, relativePath, content });

/** Renames or moves a file/directory — a full path edit doubles as a move. */
export const renamePath = (projectHash: string, from: string, to: string) =>
  invoke<void>("rename_path", { projectHash, from, to });

export const deletePath = (projectHash: string, relativePath: string) =>
  invoke<void>("delete_path", { projectHash, relativePath });

export const createDirectory = (projectHash: string, relativePath: string) =>
  invoke<void>("create_directory", { projectHash, relativePath });
