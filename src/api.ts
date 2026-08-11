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
  /** Per-thread executor override (ACP registry agent id); null = project default. */
  executor?: string | null;
  /** Per-thread model choice (the agent's config value id); null = agent default. */
  model?: string | null;
};

export type Message = {
  seq: number;
  ts: string;
  role: "user" | "assistant" | "system" | "tool";
  mode: Mode;
  content: string;
  /** Absent on messages written before sessions had identities. */
  sessionId?: string | null;
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
  title: string
) => invoke<ThreadMeta>("rename_thread", { projectHash, threadId, title });
export const setThreadMode = (
  projectHash: string,
  threadId: string,
  mode: Mode
) => invoke<ThreadMeta>("set_thread_mode", { projectHash, threadId, mode });
export const deleteThread = (projectHash: string, threadId: string) =>
  invoke<void>("delete_thread", { projectHash, threadId });

export const appendMessage = (
  projectHash: string,
  threadId: string,
  role: Message["role"],
  mode: Mode,
  content: string
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

/** Detection status for one ACP agent discovered via the registry. */
export type AgentStatus = {
  id: string;
  name: string;
  version: string | null;
  path: string | null;
  cmd: string;
};

export type Preflight = {
  /** One entry per discovered ACP agent available on PATH. */
  agents: AgentStatus[];
  /** The id of the first available agent. */
  selected: string | null;
  openspec: boolean;
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

/**
 * What the `executor-event` listener actually receives. Every event names the
 * session and thread that produced it, so two concurrent sessions can be told
 * apart instead of collapsing into one global stream.
 */
export type Envelope = {
  sessionId: string;
  threadId: string;
  event: ExecutorEvent;
};

export const preflight = (refresh = false) =>
  invoke<Preflight>("preflight", { refresh });

/** One selectable model an agent reported through its ACP config options. */
export type ModelInfo = { id: string; name: string };

/**
 * The agent's model selector as reported at session start. `configId` is
 * null when the agent has no model selector — it manages its own model.
 */
export type ModelState = {
  configId: string | null;
  current: string | null;
  models: ModelInfo[];
};

/**
 * The thread's executor picker choice. Both null reverts to the project
 * default, then auto-detection. Applies to the next session — a live session
 * under a different agent is handed off on the next turn.
 */
export const setThreadExecutor = (
  projectHash: string,
  threadId: string,
  executor: string | null,
  model: string | null
) =>
  invoke<ThreadMeta>("set_thread_executor", {
    projectHash,
    threadId,
    executor,
    model,
  });

/**
 * Probe an installed agent for the models it actually offers: spawns it for
 * a throwaway `session/new` and reads its model config option.
 */
export const listModels = (projectHash: string, agentId: string) =>
  invoke<ModelState>("list_models", { projectHash, agentId });
export const sendMessage = (
  projectHash: string,
  threadId: string,
  content: string,
  mode: Mode,
  bypass: boolean
) =>
  invoke<Message>("send_message", {
    projectHash,
    threadId,
    content,
    mode,
    model: null,
    bypass,
  });
export const goMode = (
  projectHash: string,
  threadId: string,
  bypass: boolean
) =>
  invoke<ThreadMeta>("go_mode", { projectHash, threadId, model: null, bypass });
export const specMode = (
  projectHash: string,
  threadId: string,
  bypass: boolean
) => invoke<ThreadMeta>("spec_mode", { projectHash, threadId, bypass });
export const propose = (
  projectHash: string,
  threadId: string,
  bypass: boolean
) => invoke<void>("propose", { projectHash, threadId, model: null, bypass });

/** UI-triggered one-shot grill-apply injection in spec-mode. */
export const applySkill = (
  projectHash: string,
  threadId: string,
  bypass: boolean
) => invoke<void>("apply_skill", { projectHash, threadId, bypass });

/** Whether a change's planning artifacts are all complete (openspec status). */
export const changeStatus = (projectHash: string, changeName: string) =>
  invoke<boolean | null>("change_status", { projectHash, changeName });
/** Stop one session, or every live session when no id is given. */
export const stopExecutor = (sessionId?: string) =>
  invoke<void>("stop_executor", { sessionId: sessionId ?? null });

/** One run of one agent against one thread. */
export type SessionRecord = {
  id: string;
  threadId: string;
  projectHash: string;
  agentId: string;
  mode: Mode;
  providerHandle: string | null;
  startedAt: string;
  endedAt: string | null;
  outcome: "done" | "crashed" | "cancelled" | "interrupted" | null;
  gitHeadBefore: string | null;
  gitHeadAfter: string | null;
};

/** What each live session is doing. A list, not one global busy flag. */
export type SessionStatus = {
  id: string;
  threadId: string;
  agentId: string;
  mode: Mode;
  busy: boolean;
};

export const executorStatus = () => invoke<SessionStatus[]>("executor_status");
export const listSessions = (projectHash: string, threadId: string) =>
  invoke<SessionRecord[]>("list_sessions", { projectHash, threadId });
/** Release a thread's idle sessions. Sessions mid-turn keep running. */
export const leaveThread = (threadId: string) =>
  invoke<void>("leave_thread", { threadId });

// ------------------------------------------------------------ verification

/**
 * One run of one verify command. This is the only evidence Floo accepts that
 * something works: a named command exited with a given code at a given commit.
 * Render the code and the commit — never summarise a set of these into
 * "complete" or "satisfied".
 */
export type VerificationRun = {
  id: string;
  projectHash: string;
  threadId: string | null;
  sessionId: string | null;
  name: string;
  command: string;
  exitCode: number;
  outputTail: string;
  gitHead: string | null;
  at: string;
};

/** What a session changed, with its own uncertainty attached. */
export type Attribution = {
  sessionId: string;
  committed: string[];
  uncommitted: string[];
  concurrentSessions: number;
  /** True while more than one session shares the root — the dirty set can't
   * honestly be split, so the UI must say so rather than pick. */
  ambiguous: boolean;
};

/** Resolves as soon as the run *starts*; the result arrives as an event. */
export const runVerify = (
  projectHash: string,
  name: string,
  threadId?: string | null,
  sessionId?: string | null
) =>
  invoke<void>("run_verify", {
    projectHash,
    name,
    threadId: threadId ?? null,
    sessionId: sessionId ?? null,
  });
export const listVerifications = (projectHash: string) =>
  invoke<VerificationRun[]>("list_verifications", { projectHash });
/** `[name, command]` pairs from the project's `.project-settings.json`. */
export const verifyCommands = (projectHash: string) =>
  invoke<[string, string][]>("verify_commands", { projectHash });
export const sessionAttribution = (
  projectHash: string,
  threadId: string,
  sessionId: string
) =>
  invoke<Attribution>("session_attribution", {
    projectHash,
    threadId,
    sessionId,
  });

// ----------------------------------------------------------- spec reference

/**
 * One OpenSpec change, as the `openspec` CLI reports it. `completedTasks` is
 * the agent's own checkbox self-report — render it as such, never as a claim
 * that the change is done.
 */
export type SpecChange = {
  name: string;
  completedTasks: number;
  totalTasks: number;
  lastModified: string | null;
  status: string | null;
};

/** A propose turn produced more than one change; the user picks which. */
export type SpecLinkAmbiguous = { threadId: string; names: string[] };

export const listSpecChanges = (projectHash: string) =>
  invoke<SpecChange[]>("list_spec_changes", { projectHash });
export const showSpecChange = (projectHash: string, name: string) =>
  invoke<unknown | null>("show_spec_change", { projectHash, name });
/** `null` means "openspec isn't installed, so we can't tell" — not "invalid". */
export const validateSpecChanges = (projectHash: string) =>
  invoke<boolean | null>("validate_spec_changes", { projectHash });
export const archiveSpecChange = (projectHash: string, name: string) =>
  invoke<string>("archive_spec_change", { projectHash, name });
export const setSpecChange = (
  projectHash: string,
  threadId: string,
  name: string | null
) => invoke<ThreadMeta>("set_spec_change", { projectHash, threadId, name });

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

export const runGraphify = (
  projectHash: string,
  subpath: string,
  options: GraphifyOptions
) =>
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
  args: string[]
) => invoke<string>("query_graphify", { projectHash, subcommand, args });

// ---------------------------------------------------------------- terminal

/** Resolves to the display name of a project whose shell was killed to make
 * room for this one, or `null` when nothing was replaced. */
export const terminalSpawn = (projectHash: string) =>
  invoke<string | null>("terminal_spawn", { projectHash });
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

export type BranchInfo = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
};

export const gitBranches = (projectHash: string) =>
  invoke<BranchInfo[]>("git_branches", { projectHash });
export const gitCheckoutBranch = (projectHash: string, name: string) =>
  invoke<void>("git_checkout_branch", { projectHash, name });
export const gitCreateBranch = (projectHash: string, name: string) =>
  invoke<void>("git_create_branch", { projectHash, name });
export const gitDeleteBranch = (projectHash: string, name: string) =>
  invoke<void>("git_delete_branch", { projectHash, name });
export const gitFetch = (projectHash: string) =>
  invoke<void>("git_fetch", { projectHash });
export const gitPull = (projectHash: string) =>
  invoke<string>("git_pull", { projectHash });
export const gitPush = (projectHash: string) =>
  invoke<string>("git_push", { projectHash });
export const gitAheadBehind = (projectHash: string) =>
  invoke<[number, number] | null>("git_ahead_behind", { projectHash });
export const gitDiscardFile = (
  projectHash: string,
  path: string,
  untracked: boolean
) => invoke<void>("git_discard_file", { projectHash, path, untracked });
export const gitIsRepo = (projectHash: string) =>
  invoke<boolean>("git_is_repo", { projectHash });
export const gitInit = (projectHash: string) =>
  invoke<void>("git_init", { projectHash });

// --------------------------------------------------------------- file tree

export type DirEntry = {
  name: string;
  is_dir: boolean;
  path: string;
};

export const listDirectory = (
  projectHash: string,
  relativePath: string,
  includeHidden = false
) =>
  invoke<DirEntry[]>("list_directory", {
    projectHash,
    relativePath,
    includeHidden,
  });

export const listAllFiles = (projectHash: string) =>
  invoke<string[]>("list_all_files", { projectHash });

export type TextMatch = { path: string; line: number; text: string };

export type SearchOptions = {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
};

export type TextSearchResult = {
  matches: TextMatch[];
  /** The walk stopped at the cap — there are more matches than these. */
  truncated: boolean;
};

export const searchText = (
  projectHash: string,
  query: string,
  options?: SearchOptions
) =>
  invoke<TextSearchResult>("search_text", {
    projectHash,
    query,
    options: options ?? null,
  });

export const readFileContent = (projectHash: string, relativePath: string) =>
  invoke<string>("read_file_content", { projectHash, relativePath });

export const readFileBase64 = (projectHash: string, relativePath: string) =>
  invoke<string>("read_file_base64", { projectHash, relativePath });

/** Emitted when the project's files change for a reason that wasn't us —
 * an agent turn, a `git checkout`, or another editor. `paths` are
 * project-relative and already filtered by the file tree's skip list. */
export type FsChanged = { projectHash: string; paths: string[] };

/** Rust prefixes a refused stale save with this (`CONFLICT_PREFIX` in
 * `lib.rs`) so a buffer that's out of date can offer a reload instead of
 * being reported as a generic write failure. */
export const CONFLICT_PREFIX = "CONFLICT:";

export const isConflictError = (err: unknown) =>
  String(err).includes(CONFLICT_PREFIX);

/** Files the editor deliberately won't open. Both carry a prefix so the UI
 * can explain the reason rather than showing a raw read failure. */
export const TOO_LARGE_PREFIX = "TOO_LARGE:";
export const BINARY_PREFIX = "BINARY:";

export const isBinaryError = (err: unknown) =>
  String(err).includes(BINARY_PREFIX);

/** Size in bytes of a file refused for being too large, or `null`. */
export function tooLargeBytes(err: unknown): number | null {
  const match = String(err).match(new RegExp(`${TOO_LARGE_PREFIX}\\s*(\\d+)`));
  return match ? Number(match[1]) : null;
}

/** Resolves to a format-on-save summary (D14), or `null` if nothing matched.
 *
 * `expectedPrevious` is the content the caller believes is on disk; the save
 * is refused with a `CONFLICT_PREFIX` error if that's no longer true. Pass
 * `null` (the default) to write unconditionally, which is what creating a
 * file does. */
export const writeFileContent = (
  projectHash: string,
  relativePath: string,
  content: string,
  expectedPrevious: string | null = null
) =>
  invoke<string | null>("write_file_content", {
    projectHash,
    relativePath,
    content,
    expectedPrevious,
  });

/** Renames or moves a file/directory — a full path edit doubles as a move. */
export const renamePath = (projectHash: string, from: string, to: string) =>
  invoke<void>("rename_path", { projectHash, from, to });

export const deletePath = (projectHash: string, relativePath: string) =>
  invoke<void>("delete_path", { projectHash, relativePath });

export const createDirectory = (projectHash: string, relativePath: string) =>
  invoke<void>("create_directory", { projectHash, relativePath });
