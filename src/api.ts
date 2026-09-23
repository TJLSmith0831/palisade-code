import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "./errors";

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
  /** Spec-type framing (Feature/Bugfix/custom text) picked on spec-mode entry (D11). */
  specType?: string | null;
  /** Archived threads drop out of the default History list; nothing is lost. */
  archived?: boolean;
  /** The thread's isolated git worktree; null until its first session runs. */
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  /** The branch the worktree was cut from — what "Merge to <base>" targets.
   *  Null on threads created before merge-back existed. */
  worktreeBaseBranch?: string | null;
  /** When Palisade merged this thread's branch into its base. A recorded
   *  fact, not an inference from an empty diff. */
  mergedAt?: string | null;
  /** True when the latest merge explicitly bypassed current-commit verify. */
  mergeOverridden?: boolean;
  /** False when the user opted out of worktree isolation at thread creation:
   *  the thread edits the project root live and has no merge/PR/prune step. */
  worktreeEnabled?: boolean;
  /** "auto" = Palisade named this thread (and may rename it while it is still
   *  a placeholder); "manual" = the user did, and it is never touched. */
  titleSource?: "auto" | "manual";
  /** Set when this thread's last turn died on the agent's own "needs
   *  authentication" signal — the detail text, so the composer can warn
   *  before the next message is typed. Cleared by the next successful turn. */
  authBlocked?: string | null;
};

export type Message = {
  seq: number;
  ts: string;
  /** `chain` is a chain run's own commentary in the thread (D7) — what the
   *  run did, or that it is waiting at a gate. Distinct from `system`, which
   *  the chat renders as a crash banner. */
  role: "user" | "assistant" | "system" | "tool" | "chain";
  mode: Mode;
  content: string;
  /** Absent on messages written before sessions had identities. */
  sessionId?: string | null;
  /** Present only for structured ACP failures; absent records use legacy UI fallback. */
  failureClass?: "authRequired" | "transientProvider" | "other" | null;
  /** Stored image paths a user turn carried; absent when it had none. */
  attachments?: string[];
  /** Skills picked into the tray for a user turn, apart from `content`. */
  skills?: string[];
};

/** Open an independent native window, initialized to this project. */
export const openProjectWindow = (hash: string) => invoke<string>("open_project_window", { hash });
/** Remove only the saved entry; source files and session history are retained. */
export const removeProject = (hash: string) => invoke<void>("remove_project", { hash });
export const listProjects = () => invoke<Project[]>("list_projects");
export const addProject = (path: string) =>
  invoke<Project>("add_project", { path });
/** Clone `url` into `parent`, then register the result as a project. */
export const cloneRepository = (url: string, parent: string) =>
  invoke<Project>("clone_repository", { url, parent });
export const switchProject = (hash: string) =>
  invoke<Project>("switch_project", { hash });
export const renameProject = (hash: string, displayName: string) =>
  invoke<Project>("rename_project", { hash, displayName });

/** Derived focused-window command state consumed by the native macOS menu. */
export type NativeMenuCommandState = {
  enabled: boolean;
  checked?: boolean;
  label?: string;
};

export const syncNativeMenu = (states: Record<string, NativeMenuCommandState>) =>
  invoke<void>("sync_native_menu", { states });

/** Reports this renderer's unsaved-buffer state to the process-wide quit guard. */
export const syncWindowDirty = (dirty: boolean) =>
  invoke<void>("sync_window_dirty", { dirty });
export const requestQuit = () => invoke<void>("request_quit");
export const confirmQuitWindow = () => invoke<void>("confirm_quit_window");
export const cancelQuit = () => invoke<void>("cancel_quit");

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
/** Archived threads keep everything; they just leave the default History
 *  list. Distinct from deleteThread, which is destructive. */
export const setThreadArchived = (
  projectHash: string,
  threadId: string,
  archived: boolean
) =>
  invoke<ThreadMeta>("set_thread_archived", { projectHash, threadId, archived });
export const deleteThread = (projectHash: string, threadId: string) =>
  invoke<void>("delete_thread", { projectHash, threadId });
/** Records that the user just looked at this thread, so the Fleet board
 *  stops listing it as "Unreviewed". Idempotent. */
export const markThreadViewed = (projectHash: string, threadId: string) =>
  invoke<void>("mark_thread_viewed", { projectHash, threadId });

/** The macOS dock badge: threads wanting a look (blocked on you, or finished
 *  and unread). App-wide; 0 clears it. */
export const setDockBadge = (count: number) => invoke<void>("set_dock_badge", { count });

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
/** A thread's history. No options: all of it. `limit` is the newest that many
 *  (only those before `beforeSeq`, for a "load earlier" page); `fromSeq` is
 *  everything from that seq on, for a refresh that keeps what is on screen.
 *  The windowed forms read only the tail of the log. */
export const readThread = (
  projectHash: string,
  threadId: string,
  opts: { beforeSeq?: number; fromSeq?: number; limit?: number } = {},
) => invoke<Message[]>("read_thread", { projectHash, threadId, ...opts });

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
  ready: boolean;
  /** False when the ACP registry could not be fetched and nothing is cached,
   *  so an empty `agents` means "unknown", not "none installed". */
  registryReachable: boolean;
  warnings: string[];
  checkedAt: string;
};

/** Mirrors the Rust `ExecutorEvent` enum, tagged by `kind`. */
export type ExecutorEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; elapsedSecs: number }
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
  /** A live fragment of a running tool call's output — a rendering signal
   *  only, never persisted; the `toolResult` that follows is the thing
   *  written to the log. Without this a command's output does not appear
   *  until it exits. */
  | { kind: "toolOutputDelta"; id: string; chunk: string }
  | { kind: "toolResult"; id: string; output: string; isError: boolean }
  | {
      kind: "permissionRequest";
      id: string;
      toolCallId: string;
      toolKind: string;
      command: string | null;
      paths: string[];
      /** Set when this command looks like it collides with another live
       *  session in the same project (same port or DATABASE_URL). */
      warning: string | null;
    }
  | { kind: "done" }
  | {
      kind: "crashed";
      exitCode: number | null;
      message: string;
      /** Whether the agent is still alive and the turn can simply be retried
       *  (an expired login, a cancelled turn) rather than the process being
       *  gone. Only a non-retryable crash drops the thread back to Spec mode.
       *  Absent on events persisted before the flag existed. */
      retryable?: boolean;
    };

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

/** One slash command the agent advertises. Skills, user-defined commands and
 *  built-ins are indistinguishable here on purpose — the agent decides what it
 *  offers, Palisade only lists it. */
export type AgentCommand = {
  name: string;
  description: string;
};

/** Payload of the `agent-commands` event. Keyed by session: two sessions can
 *  run different agents at once, with different commands. */
export type AgentCommands = {
  sessionId: string;
  threadId: string;
  commands: AgentCommand[];
};

/** The commands a thread's live sessions last advertised. `agent-commands`
 *  fires only at session start, so a reloaded webview re-seeds from this. */
export const agentCommands = (threadId: string) =>
  invoke<AgentCommand[]>("agent_commands", { threadId });

export const preflight = (refresh = false) =>
  invoke<Preflight>("preflight", { refresh });

/** One plan-usage window an agent reports. `usedPercent` is 0–100. */
export type AgentUsageWindow = {
  label: "5h" | "Week" | "Month";
  usedPercent: number;
  resetsAt?: string;
};

/**
 * Plan usage for one agent, or an honest reason there is none. Sources are
 * undocumented per-agent surfaces, so every provider fails soft rather than
 * claiming a number it doesn't have.
 */
export type AgentUsage =
  | {
      agentId: string;
      state: "ok";
      plan?: string;
      windows: AgentUsageWindow[];
      balanceUsd?: number;
      fetchedAt: string;
      source: string;
    }
  | { agentId: string; state: "not_signed_in" | "unavailable"; reason: string };

/** One entry per agent the cached preflight reports as installed. Cached 60s. */
/** `force` bypasses the backend's 60s per-agent cache — pass it from the
 *  manual refresh and while a sign-in is unconfirmed so a completed login
 *  doesn't sit behind a stale `not_signed_in` hit for up to a minute. */
export const agentUsage = (force?: boolean) => invoke<AgentUsage[]>("agent_usage", { force });

/** A user-level skill directory containing a `SKILL.md`. */
export type Skill = {
  name: string;
  path: string;
  description?: string;
  owner: "claude" | "agents" | "other";
};

/** Skills installed under `~/.claude/skills` and `~/.agents/skills`, by name.
 *  Read-only: the CLIs own these files, Palisade only mirrors them. */
export const listSkills = () => invoke<Skill[]>("list_skills");

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
/** `projectHash` is null on the onboarding screen, where no project is open
 *  yet — the backend probes from the home directory in that case. */
export const listModels = (projectHash: string | null, agentId: string) =>
  invoke<ModelState>("list_models", { projectHash, agentId });
export const sendMessage = (
  projectHash: string,
  threadId: string,
  content: string,
  mode: Mode,
  bypass: boolean,
  attachments: string[] = [],
  skills: string[] = []
) =>
  invoke<Message>("send_message", {
    projectHash,
    threadId,
    content,
    mode,
    model: null,
    bypass,
    attachments,
    skills,
  });

/** Copy a dropped image (`path`) or pasted bytes (`dataBase64` + `ext`) into
 *  the project's attachments dir; resolves to the stored path. */
export const saveAttachment = (
  projectHash: string,
  source: { path: string } | { dataBase64: string; ext: string }
) =>
  invoke<string>("save_attachment", {
    projectHash,
    path: "path" in source ? source.path : null,
    dataBase64: "dataBase64" in source ? source.dataBase64 : null,
    ext: "ext" in source ? source.ext : null,
  });

/** A stored attachment as a `data:` URL, for thumbnails. */
export const readAttachment = (projectHash: string, path: string) =>
  invoke<string>("read_attachment", { projectHash, path });
/** Retry an already-persisted user turn without adding a duplicate row. */
export const retryMessage = (projectHash: string, threadId: string, messageSeq: number) =>
  invoke<void>("retry_message", { projectHash, threadId, messageSeq });
export const goMode = (
  projectHash: string,
  threadId: string,
  bypass: boolean
) =>
  invoke<ThreadMeta>("go_mode", { projectHash, threadId, model: null, bypass });
/** `start` is the deliberate "begin exploring" act — picking a spec type in
 *  the framing menu. The Spec/Go toggle passes false: it records the thread's
 *  mode and must not spawn a session or send a turn (#17). */
/** One interactive login an agent advertised at `initialize`. */
export type AgentLogin = {
  methodId: string;
  label: string;
  /** How the login runs: "terminal" means execute `shellLine`; "protocol"
   *  means call `agentAuthenticate` and let the agent run its own flow. */
  kind: "terminal" | "protocol";
  /** The agent's own login command, ready to run in a terminal. Empty for a
   *  protocol login. */
  shellLine: string;
};

/** Runs an agent's protocol-driven login (`authenticate`). The agent keeps the
 *  credential itself; the next turn's handshake picks it up. */
export const agentAuthenticate = (
  projectHash: string,
  threadId: string | null,
  agentId: string | null,
  methodId: string
) =>
  invoke<void>("agent_authenticate", { projectHash, threadId, agentId, methodId });

/** Interactive logins the thread's agent advertises over ACP. Agents that own
 *  a login expect the *client* to run it — Palisade runs it in a terminal, so
 *  an expired agent login is fixable without leaving the app (#19). */
export const agentLogins = (
  projectHash: string,
  threadId: string | null,
  agentId: string | null = null
) => invoke<AgentLogin[]>("agent_logins", { projectHash, threadId, agentId });

export const specMode = (
  projectHash: string,
  threadId: string,
  specType: string,
  /** What the user actually asked for. The framing card supplies the
   *  questions that kind of work always has to answer; this supplies the
   *  work. Null only for older threads framed before it was required. */
  description: string | null,
  bypass: boolean,
  start: boolean,
  skills: string[] = []
) =>
  invoke<ThreadMeta>("spec_mode", {
    projectHash,
    threadId,
    specType,
    description,
    bypass,
    start,
    skills,
  });
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
/** Stop one session. With no id, stop `threadId`'s sessions — the Stop
 *  button's fallback before a turn has streamed anything to aim at. With
 *  neither, stop every live session. */
export const stopExecutor = (sessionId?: string, threadId?: string) =>
  invoke<void>("stop_executor", {
    sessionId: sessionId ?? null,
    threadId: threadId ?? null,
  });

/** Resolve a pending `permissionRequest` event: "allow" (once), "deny", or
 *  "allow_session" (auto-allow that tool kind for the rest of the session). */
export const answerPermissionPrompt = (
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny" | "allow_session"
) =>
  invoke<void>("answer_permission_prompt", { sessionId, requestId, decision });

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
  /** The model the agent settled on for this session, as it reported it. */
  model?: string | null;
};

export const executorStatus = () => invoke<SessionStatus[]>("executor_status");

/** A thread's isolated worktree and what has changed inside it. Keyed by
 *  thread, not session: uncommitted work outlives the session that made it. */
export type WorktreeStatus = {
  threadId: string;
  branch: string;
  added: number;
  removed: number;
  /** The branch this thread merges back into. */
  baseBranch: string;
  /** Whether the checked-out base branch can safely take a local merge. */
  baseState?: "clean" | "dirty" | "unavailable";
  /** Number of changed/untracked files in the checked-out base worktree. */
  baseChangeCount?: number | null;
  /** Commits the base branch does not have yet. */
  ahead: number;
  /** Nothing uncommitted or untracked in the worktree. */
  clean: boolean;
  /** A real trial merge said this lands without conflicts. */
  mergeable: boolean;
  /** What the sidebar dot shows. */
  state: "merged" | "conflict" | "ahead" | "clean";
  /** The worktree's HEAD — what a verification run has to have run at for
   *  its result to still be about this code. */
  head: string | null;
  setupState?: "running" | "ready" | "failed" | null;
  setupOutput?: string | null;
};

/** What a merge-back attempt did. A conflict is not an error: the half-merged
 *  state is parked in `conflictPath` for a session to resolve in place. */
export type MergeResult = {
  merged: boolean;
  conflictPath: string | null;
  conflictBranch: string | null;
  detail: string;
};

/** Only threads that have a worktree appear — never-run threads and non-git
 *  projects are simply absent. */
export const threadWorktrees = (projectHash: string) =>
  invoke<WorktreeStatus[]>("thread_worktrees", { projectHash });
export const rerunWorktreeSetup = (projectHash: string, threadId: string) =>
  invoke<void>("rerun_worktree_setup", { projectHash, threadId });
/** Merge a thread's branch into the branch it was cut from. Rejects a busy
 *  thread and an uncommitted worktree — what lands must be what was reviewed. */
export const mergeThreadWorktree = (
  projectHash: string,
  threadId: string,
  overrideVerify = false,
) =>
  invoke<MergeResult>("merge_thread_worktree", {
    projectHash,
    threadId,
    overrideVerify,
  });
export const cancelMergeVerification = (projectHash: string, threadId: string) =>
  invoke<void>("cancel_merge_verification", { projectHash, threadId });

/** Push the thread's branch and open a PR for it, returning the URL to open.
 *  Uses `gh` when it is on PATH, and the host's compare page when it isn't. */
export const openThreadPr = (projectHash: string, threadId: string) =>
  invoke<string>("open_thread_pr", { projectHash, threadId });

/** Remove an archived thread's worktree. Without `force` this only proceeds
 *  when the work has provably landed; `force` is the confirmed clean-up. */
export const pruneThreadWorktree = (
  projectHash: string,
  threadId: string,
  force = false,
) => invoke<void>("prune_thread_worktree", { projectHash, threadId, force });

/** Turn a thread's worktree isolation on or off. Only before its first
 *  session — once a worktree exists the choice is fixed for the thread. */
export const setThreadWorktreeEnabled = (
  projectHash: string,
  threadId: string,
  enabled: boolean,
) => invoke<ThreadMeta>("set_thread_worktree_enabled", { projectHash, threadId, enabled });

// ------------------------------------------------------------------ fleet

/** `attention` always carries a reason — a dot that says "look" without
 *  saying why is noise. `unreviewed` is a turn that ended and has not been
 *  opened since: nothing blocked, something waiting to be read. */
export type FleetStatus = "attention" | "running" | "unreviewed" | "idle";
export type FleetAttention =
  | "permission"
  /** A playbook run is suspended at a human approval gate. */
  | "gate"
  | "verify_failed"
  | "merge_conflict"
  | "crashed";
/** Evidence, never opinion: a pass is a named command that exited 0 at a
 *  named commit. `not_run` is the honest default. */
export type FleetVerify = {
  state: "pass" | "fail" | "not_run" | "unconfigured";
  command?: string;
  commit?: string;
  at?: string;
};
/** Measured, not inferred: `conflicts` is a real trial merge and `behind` a
 *  rev-list count — the same probes the merge gate runs. */
export type FleetMerge = "clean" | "conflicts" | "behind" | "no_worktree";

export type FleetRow = {
  /** A thread someone is working in, or one run of a playbook. */
  kind: "thread" | "playbook";
  /** The thread — or, on a playbook row, the run id. One key either way. */
  threadId: string;
  /** Playbook rows only: the run this row is. */
  runId?: string;
  /** Playbook rows only: the saved playbook the run came from. */
  playbookName?: string;
  /** Playbook rows only: the prompt the run was seeded with. */
  seed?: string;
  title: string;
  projectId: string;
  projectName: string;
  agentId?: string;
  agentName?: string;
  mode: Mode;
  status: FleetStatus;
  attention?: FleetAttention;
  branch?: string;
  worktreePath?: string;
  /** The branch a merge lands in, present only when it is not the branch
   *  checked out in the project now. */
  mergeTarget?: string;
  /** `files` counts tracked files that differ from the thread's merge base;
   *  `added` also includes the lines of untracked files.
   *  `untracked` is the files the thread created that git does not track yet
   *  — they contribute no line counts. Optional only so fixtures written
   *  before it existed still typecheck; the backend always sends it. */
  diff: { added: number; removed: number; files: number; untracked?: number };
  filesTouched: string[];
  /** Other threads in the same project writing some of the same files. */
  overlap: { threadId: string; files: string[] }[];
  verify: FleetVerify;
  merge: FleetMerge;
  /** Last touched — a message or the user opening the thread, whichever is
   *  newer. The board's sort key, not a time to show. */
  updatedAt: string;
  createdAt: string;
  /** When the thread last spoke. Absent if it has never run. */
  lastActivityAt?: string;
  archivable?: boolean;
};

/** Every unarchived thread in every open project, newest first. One call for
 *  the whole board: cross-thread file overlap can only be computed with all
 *  the rows in hand. */
export const fleetOverview = () => invoke<FleetRow[]>("fleet_overview");

/** One changed file in a thread's tree, as the Review lane lists it. */
export type ReviewFileRow = {
  path: string;
  added: number;
  removed: number;
  status: "added" | "modified" | "deleted";
};

/** The files one thread changed, measured by the same helper the Fleet board
 *  uses — untracked files included, machine-local paths excluded. The lane
 *  used to parse the working diff itself, which sees neither. */
export const threadReviewFiles = (projectHash: string, threadId: string) =>
  invoke<ReviewFileRow[]>("thread_review_files", { projectHash, threadId });

/** The full merge-base patch behind `threadReviewFiles`, including work the
 * thread already committed. */
export const threadReviewDiff = (projectHash: string, threadId: string) =>
  invoke<string>("thread_review_diff", { projectHash, threadId });

export const listSessions = (projectHash: string, threadId: string) =>
  invoke<SessionRecord[]>("list_sessions", { projectHash, threadId });
/** Release a thread's idle sessions. Sessions mid-turn keep running. */
export const leaveThread = (threadId: string) =>
  invoke<void>("leave_thread", { threadId });

// ------------------------------------------------------------ verification

/**
 * One run of one verify command. This is the only evidence Palisade accepts that
 * something works: a named command exited with a given code at a given commit.
 * Render the code and the commit — never summarise a set of these into
 * "complete" or "satisfied".
 */
// ---------------------------------------------------------------- debugger

/**
 * A breakpoint the user set.
 *
 * `verified` is tri-state on purpose: `null` means no adapter has been asked
 * yet, which is not the same as rejected and must not be drawn as one.
 */
export type Breakpoint = {
  path: string;
  /** 1-based, where the user placed it. Never overwritten by the adapter. */
  line: number;
  enabled: boolean;
  condition: string | null;
  /** What the adapter said last: true bound, false refused, null unasked. */
  verified: boolean | null;
  /** Where it actually bound, when the adapter moved it off `line`. */
  actualLine: number | null;
  message: string | null;
};

export type StackFrame = {
  id: number;
  name: string;
  /** Project-relative inside the project, absolute outside, null with no source. */
  path: string | null;
  line: number;
  column: number;
  /** Not the user's code — a dependency, the stdlib, or a frame with no source. */
  isLibrary: boolean;
};

export type StoppedState = {
  threadId: number;
  /** The adapter's own word: "breakpoint", "step", "exception", "pause". */
  reason: string;
  description: string | null;
  frames: StackFrame[];
};

export type DebugVariable = {
  name: string;
  value: string;
  type: string | null;
  variablesReference: number;
  expandable: boolean;
};

export type Watch = {
  expression: string;
  /** null when it could not be evaluated — never a stale value. */
  value: string | null;
  type: string | null;
  variablesReference: number;
  expandable: boolean;
  error: string | null;
};

export type DebugAdapterInfo = {
  language: string;
  command: string;
  args: string[];
  installed: boolean;
};

export type DebugStatus = {
  sessionId: string | null;
  language: string | null;
  stopped: StoppedState | null;
  /** Every breakpoint in the project, keyed by project-relative path. */
  breakpoints: Record<string, Breakpoint[]>;
};

export const debugBreakpoints = (projectHash: string) =>
  invoke<Record<string, Breakpoint[]>>("debug_breakpoints", { projectHash });
/** A gutter click: places a breakpoint or removes the one already there. */
export const debugToggleBreakpoint = (projectHash: string, path: string, line: number) =>
  invoke<Breakpoint[]>("debug_toggle_breakpoint", { projectHash, path, line });
export const debugSetBreakpointEnabled = (
  projectHash: string,
  path: string,
  line: number,
  enabled: boolean
) => invoke<Breakpoint[]>("debug_set_breakpoint_enabled", { projectHash, path, line, enabled });
export const debugClearBreakpoints = (projectHash: string) =>
  invoke<void>("debug_clear_breakpoints", { projectHash });
/** Which adapter Palisade would use for a language, and whether it is there. */
export const debugAdapter = (language: string) =>
  invoke<DebugAdapterInfo | null>("debug_adapter", { language });
/** What Start would launch: derived from the project's `run` map rather than
 *  a second config surface of its own. Empty means nothing in this project
 *  can be debugged, which the panel says rather than hanging on a launch. */
export type DebugLaunch = {
  /** The key from the project's `run` map. */
  name: string;
  command: string;
  configuration: Record<string, unknown>;
};

export const debugLaunchOptions = (projectHash: string, language: string) =>
  invoke<DebugLaunch[]>("debug_launch_options", { projectHash, language });

export const debugStatus = (projectHash: string) =>
  invoke<DebugStatus>("debug_status", { projectHash });
export const debugStart = (
  projectHash: string,
  language: string,
  configuration: Record<string, unknown>
) => invoke<DebugStatus>("debug_start", { projectHash, language, configuration });
export const debugStop = () => invoke<void>("debug_stop");
export type DebugAction = "continue" | "stepOver" | "stepIn" | "stepOut" | "pause" | "restart";
export const debugStep = (action: DebugAction, threadId?: number) =>
  invoke<void>("debug_step", { action, threadId: threadId ?? null });
export const debugScopes = (frameId: number) =>
  invoke<[string, number][]>("debug_scopes", { frameId });
export const debugVariables = (variablesReference: number) =>
  invoke<DebugVariable[]>("debug_variables", { variablesReference });
/** Batched: watches are re-evaluated together on every stop, and one
 *  failure must not take the others with it. */
export const debugEvaluate = (expressions: string[], frameId?: number) =>
  invoke<Watch[]>("debug_evaluate", { expressions, frameId: frameId ?? null });

/** How one test finished. `errored` is a crash, not a failed assertion. */
export type TestStatus = "passed" | "failed" | "skipped" | "errored";

export type TestCase = {
  name: string;
  status: TestStatus;
  /** Source file the runner named, relative to wherever it ran. */
  file: string | null;
  /** 1-based. */
  line: number | null;
  message: string | null;
};

/**
 * Per-test results parsed out of one verify run's output.
 *
 * A view of a run, never evidence in its own right: the run's exit code and
 * commit remain the only thing that says a spec is green (D3). `parsed:
 * false` means no runner was recognised — the UI must show the raw log
 * rather than an empty explorer, because "no failures parsed" is not "no
 * failures".
 */
export type TestReport = {
  framework: string;
  cases: TestCase[];
  parsed: boolean;
  /** Non-zero exit with no failing test — a crash before the first verdict. */
  unexplainedFailure: boolean;
};

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
  tests: TestReport | null;
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
/** `[name, command]` pairs from the project's `.palisade/project-settings.json`. */
export const verifyCommands = (projectHash: string) =>
  invoke<[string, string][]>("verify_commands", { projectHash });
export const detectVerifyCommands = (projectHash: string) =>
  invoke<[string, string][]>("detect_verify_commands", { projectHash });
export const saveVerifyCommands = (projectHash: string, commands: [string, string][]) =>
  invoke<void>("save_verify_commands", { projectHash, commands });

// ------------------------------------------------------------ agent chains

/** What has to happen on an edge before the run crosses it (D3/D22). */
export type ChainGate =
  | { type: "verify"; command: string }
  | { type: "approval" };

export type ChainNode = {
  /** Doubles as the node's key in `nodes` and the edge endpoint reference. */
  role: string;
  /** Persistent behavioural guideline, applied every turn this node takes. */
  guideline: string;
  /** ACP agent id — user-picked, unlike a normal thread's executor (D16). */
  agent: string;
  /** Model this node's agent runs on. Unset follows the thread's model. */
  model?: string | null;
  retry?: { maxAttempts: number };
};

export type ChainEdge = {
  from: string;
  to: string;
  /** Optional on a forward pipe, required on a loop-closing edge. */
  gate?: ChainGate;
  maxIterations?: number;
};

export type Chain = {
  name: string;
  nodes: Record<string, ChainNode>;
  edges: ChainEdge[];
  entry: string;
  timeoutSeconds: number;
  retry: { maxAttempts: number };
  /** Optional cap for a run frontier; omitted or 0 means unbounded. */
  maxParallel?: number;
  /** Canvas positions, keyed by role. Presentation only. */
  layout?: Record<string, { x: number; y: number }>;
};

/**
 * How a thread's executor slot names a chain instead of an agent (D5).
 * Reusing that slot is what keeps chains inside go mode rather than adding a
 * third mode.
 */
export const CHAIN_EXECUTOR_PREFIX = "chain:";

export const listChains = (projectHash: string) =>
  invoke<Chain[]>("list_chains", { projectHash });
/** Rejects an invalid chain (e.g. an ungated loop edge) rather than saving it. */
export const saveChain = (projectHash: string, chain: Chain) =>
  invoke<void>("save_chain", { projectHash, chain });
export const deleteChain = (projectHash: string, name: string) =>
  invoke<void>("delete_chain", { projectHash, name });

/** Where one node is in its turn. Only one node is `executing` at a time. */
/** Includes legacy compact forms while Wave E updates the canvas renderer. */
export type ChainNodeState =
  | "queued"
  | "executing"
  | { retrying: number }
  | { retrying?: never; blocked: { met: number; required: number } }
  | "done"
  | "failed"
  | "cancelled"
  | {
      kind: "queued" | "executing" | "retrying" | "blocked" | "done" | "failed" | "cancelled";
      attempt?: number;
      met?: number;
      required?: number;
      // Compatibility fields keep the existing canvas compiling until Wave E
      // becomes the single owner of its state-label renderer.
      retrying?: number;
      blocked?: { met: number; required: number };
    };

/** Why a run stopped. Every terminal state names a reason. */
export type ChainOutcome =
  | { kind: "completed"; output: string }
  | { kind: "rejected"; at: string }
  | { kind: "gateFailed"; at: string; command: string }
  | { kind: "capReached"; at: string; maxIterations: number }
  | { kind: "timedOut"; at: string; afterSeconds: number }
  | { kind: "retriesExhausted"; at: string; attempts: number; message: string }
  | { kind: "cancelled"; at: string[] }
  | { kind: "blocked"; reason: string };

/** Payload of the `chain-event` window event the live DAG view listens on. */
export type ChainEvent = {
  runId: string;
  threadId: string;
  chain: string;
  /** Absent on run-level events (outcome, gate). */
  role: string | null;
  state: ChainNodeState | null;
  outcome: ChainOutcome | null;
  awaitingApproval: {
    from: string;
    to: string;
    /** `from`'s actual output — rendered inline; a link is not evidence. */
    output: string;
  } | null;
  /** The session backing this node's turn — click-through to its transcript. */
  sessionId: string | null;
  /** ACP-billed cost when this node's agent reported it; never fabricated as 0. */
  cost?: { amount: number; currency: string } | null;
};

/** Durable node-state form used inside a past run record. */
export type ChainNodeStateSnapshot =
  | { kind: "queued" }
  | { kind: "executing" }
  | { kind: "retrying"; attempt: number }
  | { kind: "blocked"; met: number; required: number }
  | { kind: "done" }
  | { kind: "failed" }
  | { kind: "cancelled" };

export type ChainRunOutcome =
  | ChainOutcome
  | { kind: "interrupted" };

export type ChainRunNodeHistory = {
  transitions: Array<{ state: ChainNodeStateSnapshot; at: string }>;
  sessionId: string | null;
  iterations: number;
  /** Latest completed output, retained for re-run-from-node. */
  output: string | null;
  /** Unknown rather than zero when an agent did not report billed cost. */
  cost: { amount: number; currency: string } | null;
};

/** Persisted chain definition, node timeline, outputs, and terminal result. */
export type ChainRunRecord = {
  id: string;
  projectHash: string;
  threadId: string;
  chainName: string;
  chainSnapshot: Chain;
  seed: string;
  startedAt: string;
  endedAt: string | null;
  outcome: ChainRunOutcome | null;
  nodes: Record<string, ChainRunNodeHistory>;
  /** Soft-flag archive (issue #53) — never a delete; hidden from the default list. */
  archived: boolean;
};

/**
 * Starts a run and returns its id. Rejects up front when a node's bound agent
 * isn't installed (D17) rather than failing partway through.
 */
export const runChain = (
  projectHash: string,
  chainName: string,
  seedInput: string,
  threadId: string
) =>
  invoke<string>("run_chain", { projectHash, chainName, seedInput, threadId });

/**
 * Replays a durable run's saved definition. With `fromRole`, upstream roles
 * are not re-executed: the selected node receives their recorded outputs.
 */
export const rerunChainRun = (
  projectHash: string,
  runId: string,
  fromRole: string | undefined,
  threadId: string
) =>
  invoke<string>("rerun_chain_run", {
    projectHash,
    runId,
    fromRole: fromRole ?? null,
    threadId,
  });

/** Stops an active chain, including a turn parked at a human approval gate. */
export const cancelChainRun = (runId: string) =>
  invoke<void>("cancel_chain_run", { runId });

/**
 * Durable history, optionally restricted to one chain definition. Archived
 * runs are excluded unless `includeArchived` is true (default excludes,
 * mirroring `listThreads`'s archive convention).
 */
export const listChainRuns = (projectHash: string, chainName?: string, includeArchived?: boolean) =>
  invoke<ChainRunRecord[]>("list_chain_runs", {
    projectHash,
    chainName: chainName ?? null,
    includeArchived: includeArchived ?? null,
  });

/** One durable run by id, or null when it does not belong to this project. */
export const getChainRun = (projectHash: string, runId: string) =>
  invoke<ChainRunRecord | null>("get_chain_run", { projectHash, runId });

/** Soft-flags a run archived or unarchived (issue #53) — never a delete. */
export const setChainRunArchived = (projectHash: string, runId: string, archived: boolean) =>
  invoke<ChainRunRecord>("set_chain_run_archived", { projectHash, runId, archived });

/** The three things a human can do at a paused approval gate (D9). */
export const resolveChainGate = (
  runId: string,
  decision: "approve" | "reject" | "sendBack",
  note?: string
) => invoke<void>("resolve_chain_gate", { runId, decision, note: note ?? null });

// --------------------------------------------------------- language servers

/** Every state D14 distinguishes, so the status bar never says just "off". */
export type LspState =
  | "unsupported"
  | "notInstalled"
  | "starting"
  | "running"
  | "crashed"
  | "disabled";

export type LspStatus = {
  language: string;
  state: LspState;
  /** The binary Palisade looked for — names what to install when missing. */
  server: string | null;
  restarts: number;
  detail: string | null;
};

export const lspStart = (projectHash: string, language: string) =>
  invoke<LspStatus>("lsp_start", { projectHash, language });
export const lspSend = (projectHash: string, language: string, body: string) =>
  invoke<void>("lsp_send", { projectHash, language, body });
export const lspStatus = (projectHash: string, language: string) =>
  invoke<LspStatus>("lsp_status", { projectHash, language });
export const lspShutdown = (projectHash: string) =>
  invoke<void>("lsp_shutdown", { projectHash });
/** The command Palisade would run to install this language's server, or null when
 *  it knows none or the tool that would run it isn't on this machine. */
export const lspInstallCommand = (language: string) =>
  invoke<string | null>("lsp_install_command", { language });
/** Installs the language server, using the toolchain already on the machine.
 *  Rejects with the installer's own output when it fails. */
export const lspInstall = (language: string) =>
  invoke<void>("lsp_install", { language });

// ------------------------------------------------------------- run commands

/** Amendment 1's `run` map: the title bar runs these, the Run panel edits them. */
export const runCommands = (projectHash: string) =>
  invoke<[string, string][]>("run_commands", { projectHash });
/** Replaces the whole map — a delete is an absent key. */
export const saveRunCommands = (
  projectHash: string,
  commands: [string, string][]
) => invoke<void>("save_run_commands", { projectHash, commands });
/** What the project root suggests. A proposal: it writes nothing. */
export const detectRunCommands = (projectHash: string) =>
  invoke<[string, string][]>("detect_run_commands", { projectHash });
/** Replaces the whole `verifyPins` map — the single writer for this field. */
export const saveVerifyPins = (
  projectHash: string,
  pins: Record<string, string[]>
) => invoke<void>("save_verify_pins", { projectHash, pins });
/** Replaces the whole `appearance` object — opaque to the backend. */
export const saveAppearance = (projectHash: string, appearance: unknown) =>
  invoke<void>("save_appearance", { projectHash, appearance });
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
/** `thread-title-pending`: a thread's title is being written in the
 *  background (`pending`), or has landed. */
export type TitlePending = { threadId: string; pending: boolean };

// threadId: an agent's proposal lands in the thread's isolated worktree, not
// the project root (OPE-01) — pass it so the backend reads the tree that
// actually has the change on disk, not always the main checkout.
export const listSpecChanges = (projectHash: string, threadId?: string | null) =>
  invoke<SpecChange[]>("list_spec_changes", { projectHash, threadId: threadId ?? null });
export const showSpecChange = (projectHash: string, name: string, threadId?: string | null) =>
  invoke<unknown | null>("show_spec_change", { projectHash, threadId: threadId ?? null, name });
/** `null` means "openspec isn't installed, so we can't tell" — not "invalid". */
export const validateSpecChanges = (projectHash: string, threadId?: string | null) =>
  invoke<boolean | null>("validate_spec_changes", { projectHash, threadId: threadId ?? null });
export const archiveSpecChange = (projectHash: string, name: string, threadId?: string | null) =>
  invoke<string>("archive_spec_change", { projectHash, threadId: threadId ?? null, name });
export const setSpecChange = (
  projectHash: string,
  threadId: string,
  name: string | null
) => invoke<ThreadMeta>("set_spec_change", { projectHash, threadId, name });

// ---------------------------------------------------------------- preview

/** Where the Preview pane's native webview sits, in the window's CSS pixels. */
export type PreviewBounds = { x: number; y: number; width: number; height: number };

/** What the previewed page reports about itself (`preview-state` event). */
export type PreviewState = { projectHash: string; url: string; loading: boolean; title: string | null };

/** Shows `projectHash`'s preview at `bounds`, navigating only if `url`
 *  differs from what it already shows. Each project has its own browser, with
 *  its own cookies and storage. */
export const previewOpen = (projectHash: string, url: string, bounds: PreviewBounds) =>
  invoke<void>("preview_open", { projectHash, url, bounds });
/** Whether anything answers at `url`: `null` if so (any HTTP status counts),
 *  otherwise why not. Only loopback addresses are checked. */
export const previewProbe = (url: string) => invoke<string | null>("preview_probe", { url });
export const previewBounds = (projectHash: string, bounds: PreviewBounds) =>
  invoke<void>("preview_bounds", { projectHash, bounds });
/** Hides the view but keeps its page alive. */
export const previewHide = (projectHash: string) => invoke<void>("preview_hide", { projectHash });
/** Destroys the view and its page; the next open starts a fresh one. */
export const previewClose = (projectHash: string) => invoke<void>("preview_close", { projectHash });
export const previewReload = (projectHash: string) => invoke<void>("preview_reload", { projectHash });
/** `-1` back, `1` forward. */
export const previewHistory = (projectHash: string, delta: -1 | 1) =>
  invoke<void>("preview_history", { projectHash, delta });

// ---------------------------------------------------------------- terminal

/** Resolves to the display name of a project whose shell was killed to make
 * room for this one, or `null` when nothing was replaced. */
/** What attaching to a tab returns: whether a shell was started, and the
 *  tab's recent output (base64) so a late view can catch up. Live
 *  `terminal-output` chunks with `offset < end` are already in `backlog`. */
export type TerminalAttach = { spawned: boolean; backlog: string; end: number };

/** Ensures tab `terminalId`'s shell is running — starting a new one if the
 *  previous shell exited — and returns what the view needs to attach. */
export const terminalSpawn = (projectHash: string, terminalId: string) =>
  invoke<TerminalAttach>("terminal_spawn", { projectHash, terminalId });
export const terminalInput = (terminalId: string, data: string) =>
  invoke<void>("terminal_input", { terminalId, data });
export const terminalResize = (terminalId: string, cols: number, rows: number) =>
  invoke<void>("terminal_resize", { terminalId, cols, rows });
/** Closes one tab's shell; every other tab keeps running. */
export const terminalKill = (terminalId: string) =>
  invoke<void>("terminal_kill", { terminalId });
/** Closes every shell belonging to one project — what a project switch does. */
export const terminalKillProject = (projectHash: string) =>
  invoke<void>("terminal_kill_project", { projectHash });
/** Which of a project's tabs still have a live shell behind them. */
export const terminalList = (projectHash: string) =>
  invoke<string[]>("terminal_list", { projectHash });

// ----------------------------------------------------------------- notebook

/** Runs one cell against the notebook's kernel, spawning it first if this is
 *  the notebook's first execution (design.md D8/D9). Results arrive as
 *  `notebook-event`/`notebook-warning` window events, not this call's return
 *  value — execution can outlive the request/response round trip. */
export const runNotebookCell = (
  projectHash: string,
  relativePath: string,
  kernelspecName: string | null,
  cellId: string,
  source: string
) =>
  invoke<void>("run_notebook_cell", {
    projectHash,
    relativePath,
    kernelspecName,
    cellId,
    source,
  });

export const interruptNotebookKernel = (projectHash: string, relativePath: string) =>
  invoke<void>("interrupt_notebook_kernel", { projectHash, relativePath });

/** Discards the kernel's in-process state; a fresh kernel starts on the next run. */
export const restartNotebookKernel = (projectHash: string, relativePath: string) =>
  invoke<void>("restart_notebook_kernel", { projectHash, relativePath });

/** Stops and drops a notebook's kernel — call on tab close. A no-op if no
 *  cell was ever run in this notebook (D8: opening one doesn't spawn a kernel). */
export const closeNotebookKernel = (projectHash: string, relativePath: string) =>
  invoke<void>("close_notebook_kernel", { projectHash, relativePath });

/** One driver event forwarded verbatim (see notebook_driver.py's docstring
 *  for the `event` field's possible shapes: Started/Stream/ExecuteResult/
 *  DisplayData/Error/ExecuteReply/Restarted/Crashed). */
export type NotebookEnvelope = {
  notebookId: string;
  event: Record<string, unknown>;
};

export type NotebookWarning = {
  notebookId: string;
  message: string;
};

// --------------------------------------------------------------------- git

export type FileStatus = { path: string; code: string };

/** Every call below takes an optional `threadId` naming the working tree it
 *  acts on: that thread's isolated worktree when it has one, the project root
 *  otherwise. Reads and writes alike — a thread's worktree is committable, it
 *  is not a museum. The contract for callers is to pass the same `threadId`
 *  they *rendered* from, so the tree written to is the tree on screen. */
export const gitStatus = (projectHash: string, threadId?: string) =>
  invoke<FileStatus[]>("git_status", { projectHash, threadId });
export const gitWorkingDiff = (projectHash: string, threadId?: string) =>
  invoke<string>("git_working_diff", { projectHash, threadId });
export const gitStagedDiff = (projectHash: string, threadId?: string) =>
  invoke<string>("git_staged_diff", { projectHash, threadId });
export const gitStageHunk = (projectHash: string, patch: string, threadId?: string) =>
  invoke<void>("git_stage_hunk", { projectHash, patch, threadId });
export const gitUnstageHunk = (projectHash: string, patch: string, threadId?: string) =>
  invoke<void>("git_unstage_hunk", { projectHash, patch, threadId });
export const gitUnstageFile = (projectHash: string, path: string, threadId?: string) =>
  invoke<void>("git_unstage_file", { projectHash, path, threadId });
export const gitStageFile = (projectHash: string, path: string, threadId?: string) =>
  invoke<void>("git_stage_file", { projectHash, path, threadId });
export const gitCommit = (projectHash: string, message: string, threadId?: string) =>
  invoke<void>("git_commit", { projectHash, message, threadId });

/** One row of the Source Control panel's read-only commit graph. */
export type LogEntry = {
  hash: string;
  subject: string;
  author: string;
  /** Author date, ISO-8601 — the graph shows recency, not just a name. */
  date: string;
};

export const gitLog = (projectHash: string, limit = 20, threadId?: string) =>
  invoke<LogEntry[]>("git_log", { projectHash, limit, threadId });

export type GraphCommit = { hash: string; parents: string[]; subject: string; author: string; date: string; refs: string[] };
/** Repository-wide history; deliberately independent of the selected tree. */
export const gitGraph = (projectHash: string, limit = 80) =>
  invoke<GraphCommit[]>("git_graph", { projectHash, limit });

/** The diff one commit introduced — clicking a row in the graph. Repository-
 *  wide like `gitGraph`, not scoped to a working tree. */
export const gitCommitDiff = (projectHash: string, hash: string) =>
  invoke<string>("git_commit_diff", { projectHash, hash });

/** Source Control panel's **Generate**: drafts a message from the staged diff.
 *  `threadId` names the thread whose provider/model to draft with — the one
 *  the user picked in the chat pane. Without it the draft ran on whatever
 *  auto-detection found, on that agent's default model, which is a dead end
 *  on a machine where that agent isn't installed or is over its usage limit. */
/** A one-line commit subject from the *local* model, for pre-filling the
 *  merge gate. Resolves to "" when no local model is running — that is an
 *  ordinary state, not an error. */
export const suggestCommitMessage = (projectHash: string, threadId?: string) =>
  invoke<string>("suggest_commit_message", { projectHash, threadId });

export const draftCommitMessage = (projectHash: string, threadId: string | null) =>
  invoke<string>("draft_commit_message", { projectHash, threadId });

export type BranchInfo = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
};

export const gitBranches = (projectHash: string) =>
  invoke<BranchInfo[]>("git_branches", { projectHash });
export const gitCheckoutBranch = (projectHash: string, name: string) =>
  invoke<void>("git_checkout_branch", { projectHash, name });
/** Every branch checked out in a worktree other than the project root, as
 *  `[branch, worktree path]`. A branch lives in exactly one worktree, so this
 *  is what turns "switch to that branch" into "open the tree it is already
 *  in" — and what lets the picker say so before the user clicks. */
export const gitWorktrees = (projectHash: string) =>
  invoke<[string, string][]>("git_worktrees", { projectHash });
export const gitCreateBranch = (projectHash: string, name: string) =>
  invoke<void>("git_create_branch", { projectHash, name });
export const gitDeleteBranch = (projectHash: string, name: string) =>
  invoke<void>("git_delete_branch", { projectHash, name });
export const gitFetch = (projectHash: string, threadId?: string) =>
  invoke<void>("git_fetch", { projectHash, threadId });
export const gitPull = (projectHash: string, threadId?: string) =>
  invoke<string>("git_pull", { projectHash, threadId });
export const gitPush = (projectHash: string, threadId?: string) =>
  invoke<string>("git_push", { projectHash, threadId });
export const gitAheadBehind = (projectHash: string, threadId?: string) =>
  invoke<[number, number] | null>("git_ahead_behind", { projectHash, threadId });
export const gitDiscardFile = (
  projectHash: string,
  path: string,
  untracked: boolean,
  threadId?: string
) => invoke<void>("git_discard_file", { projectHash, path, untracked, threadId });
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

/** One directory anywhere on disk (`~` expanded), absolute paths back —
 *  for `@~/…` and `@/…` mentions of files outside the project. */
export const listAnyDirectory = (path: string, includeHidden = false, projectHash?: string | null) =>
  invoke<DirEntry[]>("list_any_directory", { path, includeHidden, projectHash });

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

/** `threadId` names the working tree to read, exactly as the `git*` calls
 *  above do: a thread's own worktree when it has one, the project root
 *  otherwise. Pass the same id the view was rendered from. */
export const readFileContent = (
  projectHash: string,
  relativePath: string,
  threadId?: string,
) => invoke<string>("read_file_content", { projectHash, relativePath, threadId });

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
  errorMessage(err).includes(CONFLICT_PREFIX);

/** Files the editor deliberately won't open. Both carry a prefix so the UI
 * can explain the reason rather than showing a raw read failure. */
export const TOO_LARGE_PREFIX = "TOO_LARGE:";
export const BINARY_PREFIX = "BINARY:";

export const isBinaryError = (err: unknown) =>
  errorMessage(err).includes(BINARY_PREFIX);

/** Size in bytes of a file refused for being too large, or `null`. */
export function tooLargeBytes(err: unknown): number | null {
  const match = errorMessage(err).match(new RegExp(`${TOO_LARGE_PREFIX}\\s*(\\d+)`));
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
  expectedPrevious: string | null = null,
  threadId?: string,
) =>
  invoke<string | null>("write_file_content", {
    projectHash,
    relativePath,
    content,
    expectedPrevious,
    threadId,
  });

/** Renames or moves a file/directory — a full path edit doubles as a move. */
export const renamePath = (projectHash: string, from: string, to: string) =>
  invoke<void>("rename_path", { projectHash, from, to });

export const deletePath = (projectHash: string, relativePath: string) =>
  invoke<void>("delete_path", { projectHash, relativePath });

export const createDirectory = (projectHash: string, relativePath: string) =>
  invoke<void>("create_directory", { projectHash, relativePath });

// --------------------------------------------------------------- completion

export type CompletionResponse = {
  completion: string;
  modelLatencyMs: number;
};

export type CompletionSettings = {
  enabled: boolean;
  acceptKeybinding: string;
};

export type CompletionTelemetry = {
  shown: number;
  accepted: number;
  dismissed: number;
  typedPast: number;
  /** Requests where the model declined to suggest anything (D60). */
  abstained: number;
  /** Accepted completions still present 30s later (D63). */
  retained: number;
  ttftP50: number;
  ttftP99: number;
};

export const completeCode = (
  projectHash: string,
  filePath: string,
  prefix: string,
  suffix: string
) =>
  invoke<CompletionResponse>("complete_code", {
    projectHash,
    filePath,
    prefix,
    suffix,
  });

export const setCompletionEnabled = (enabled: boolean) =>
  invoke<boolean>("set_completion_enabled", { enabled });

export const setCompletionKeybinding = (keybinding: string) =>
  invoke<string>("set_completion_keybinding", { keybinding });

export const getCompletionSettings = () =>
  invoke<CompletionSettings>("get_completion_settings");

export const flushCompletionTelemetry = (telemetry: CompletionTelemetry) =>
  invoke<void>("flush_completion_telemetry", { telemetry });

// ---------------------------------------------------------------- mcp
//
// The project's `.mcp.json` is the store; the backend also hands the enabled
// servers to each agent session over ACP `session/new`, which is what makes
// them reach non-Claude agents that never read `.mcp.json`.

/** One configured MCP server. `command`/`args`/`env` carry a stdio server,
 *  `url`/`headers` a remote one; `transport` says which. */
export type McpServer = {
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
};

/** One browsable server from the official MCP registry. `installable` is
 *  false when it needs a step Palisade won't take on the user's behalf (a
 *  docker pull, a binary download) — those link to their repo instead. */
export type McpRegistryEntry = {
  name: string;
  title: string;
  description: string;
  version: string;
  repository: string;
  installable: boolean;
  server: McpServer | null;
};

export const listMcpServers = (projectHash: string) =>
  invoke<McpServer[]>("list_mcp_servers", { projectHash });

export const saveMcpServer = (projectHash: string, server: McpServer) =>
  invoke<void>("save_mcp_server", { projectHash, server });

export const removeMcpServer = (projectHash: string, name: string) =>
  invoke<void>("remove_mcp_server", { projectHash, name });

export const setMcpServerEnabled = (
  projectHash: string,
  name: string,
  enabled: boolean
) => invoke<void>("set_mcp_server_enabled", { projectHash, name, enabled });

/** One page of a registry search — `nextCursor` is null once Browse has
 *  reached the end of the list. */
export type McpRegistryPage = {
  servers: McpRegistryEntry[];
  nextCursor: string | null;
};

export const searchMcpRegistry = (
  query: string,
  cursor?: string | null,
  limit = 30
) =>
  invoke<McpRegistryPage>("search_mcp_registry", { query, limit, cursor: cursor ?? null });

// ---------------------------------------------------------------- database
//
// Saved connections live in `~/.palisade-code`, never in the project (D5/D8).
// Connection details are discrete fields, not a URL string: the password is
// stored on its own in the OS credential store, so listing connections reads no
// secrets and opening the panel raises no OS prompt (D21/D23).

export type DbBackend = "postgres" | "sqlite";

/** Non-secret connection details. `backend` is the discriminator. */
export type DbDetails =
  | {
      backend: "postgres";
      host: string;
      port: number;
      user: string;
      database: string;
    }
  | { backend: "sqlite"; path: string };

/** No password and no assembled URL — neither crosses IPC (D16, D21). Every
 *  command addresses a connection by `id`. */
export type DbConnection = {
  id: string;
  name: string;
} & DbDetails;

/** A table or view in the schema tree. `schema` is null on SQLite. */
export type DbTable = {
  schema: string | null;
  name: string;
  kind: "table" | "view";
};

export type DbColumn = {
  name: string;
  dataType: string;
  primaryKey: boolean;
};

/** Cell values arrive as text with `null` for SQL NULL, so the grid can keep
 *  NULL and the empty string visibly apart. */
export type DbCell = string | null;

export type DbPage = {
  columns: DbColumn[];
  rows: DbCell[][];
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** False when the table has no primary key among its columns (D9). */
  editable: boolean;
};

export type DbQueryResult = {
  columns: string[];
  rows: DbCell[][];
  /** Set instead of rows for statements that report a count. */
  rowsAffected: number | null;
};

export type DbSort = { column: string; descending: boolean };
export type DbFilter = { column: string; value: string };

/** One row's pending edits: the values it was fetched with (the conflict
 *  fingerprint) plus only the columns the user changed. */
export type DbRowEdit = {
  original: Record<string, DbCell>;
  changes: Record<string, DbCell>;
};

export const dbListConnections = (projectHash: string) =>
  invoke<DbConnection[]>("db_list_connections", { projectHash });

export const dbAddConnection = (
  projectHash: string,
  name: string,
  details: DbDetails,
  password?: string
) => invoke<DbConnection>("db_add_connection", { projectHash, name, details, password });

/** Splits a pasted connection string into fields for review (D24). Parsing
 *  lives in the backend so the two sides can't disagree about a URL's shape. */
export const dbParseUrl = (url: string) =>
  invoke<{ details: DbDetails; password: string | null }>("db_parse_url", { url });

export const dbRemoveConnection = (projectHash: string, connectionId: string) =>
  invoke<void>("db_remove_connection", { projectHash, connectionId });

export const dbRenameConnection = (
  projectHash: string,
  connectionId: string,
  name: string
) => invoke<DbConnection>("db_rename_connection", { projectHash, connectionId, name });

export const dbListTables = (projectHash: string, connectionId: string) =>
  invoke<DbTable[]>("db_list_tables", { projectHash, connectionId });

export const dbFetchPage = (
  projectHash: string,
  connectionId: string,
  schema: string | null,
  table: string,
  page: number,
  sort: DbSort | null,
  filter: DbFilter | null
) =>
  invoke<DbPage>("db_fetch_page", {
    projectHash,
    connectionId,
    schema,
    table,
    page,
    sort,
    filter,
  });

export const dbRunQuery = (projectHash: string, connectionId: string, sql: string) =>
  invoke<DbQueryResult>("db_run_query", { projectHash, connectionId, sql });

/** Whether `sql` needs the confirm gate. Asked of the backend so there is one
 *  matcher, not a copy here that can drift from it (D12). */
export const dbIsDestructive = (sql: string) =>
  invoke<boolean>("db_is_destructive", { sql });

export const dbPreviewEdits = (
  projectHash: string,
  connectionId: string,
  schema: string | null,
  table: string,
  edits: DbRowEdit[]
) =>
  invoke<string[]>("db_preview_edits", { projectHash, connectionId, schema, table, edits });

export const dbApplyEdits = (
  projectHash: string,
  connectionId: string,
  schema: string | null,
  table: string,
  edits: DbRowEdit[]
) => invoke<number>("db_apply_edits", { projectHash, connectionId, schema, table, edits });

export type Diagnostics = {
  appVersion: string;
  osVersion: string;
  arch: string;
  executor: string;
  modelInstalled: boolean;
};

export const collectDiagnostics = () =>
  invoke<Diagnostics>("collect_diagnostics");
