/**
 * One path from a failure to something a person can read.
 *
 * There used to be two grammars. 41 sites wrapped through `describeError` into
 * "Couldn't complete that — …" and 18 passed a raw `String(err)` straight to a
 * banner, so a Rust panic string appeared verbatim in some panels and dressed
 * up in others. The wrapper was also used for *reads* — VerifyPane and
 * SpecChangeTab said "Couldn't complete that" when the user had attempted
 * nothing at all.
 */

/** What the backend now sends: `{ kind, message }`. See `src-tauri/src/error.rs`. */
export type ErrorKind =
  | "notAGitRepo"
  | "notFound"
  | "outsideProject"
  | "unknown";

export type PalisadeError = { kind: ErrorKind; message: string };

const isPalisadeError = (err: unknown): err is PalisadeError =>
  typeof err === "object" &&
  err !== null &&
  typeof (err as PalisadeError).message === "string" &&
  typeof (err as PalisadeError).kind === "string";

/**
 * The failure's kind, for branching.
 *
 * Source Control used to answer this question with `/not a git repository/i`
 * over whatever text reached it. The classification now happens once, in Rust,
 * against the words git itself printed.
 */
export function errorKind(err: unknown): ErrorKind {
  return isPalisadeError(err) ? err.kind : "unknown";
}

/** The failure's own words, with no lead-in of ours attached. */
export function errorMessage(err: unknown): string {
  if (isPalisadeError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** What the user was doing. The copy turns on this as much as on the kind. */
export type ErrorContext =
  /** Something the user asked for: a click, a save, a run. */
  | { action: string }
  /** Something the app went to fetch on its own. The user attempted nothing. */
  | { loading: string };

const isLoad = (context?: ErrorContext): context is { loading: string } =>
  !!context && "loading" in context;

/**
 * A failure, in a sentence, followed by the detail verbatim.
 *
 * Nothing is hidden — the raw message is always there — it just stops reading
 * like a crash dump, and it stops claiming the user tried to do something when
 * they didn't.
 */
export function describeError(err: unknown, context?: ErrorContext): string {
  const detail = errorMessage(err);
  const kind = errorKind(err);

  if (kind === "notAGitRepo") {
    return isLoad(context)
      ? `There's no git repository here yet, so there's no ${context.loading} to show.`
      : `This project isn't a git repository yet, so that can't run.`;
  }
  if (kind === "outsideProject") {
    return `That path is outside the project — ${detail}`;
  }
  if (kind === "notFound") {
    return isLoad(context)
      ? `Couldn't find the ${context.loading} — ${detail}`
      : `That isn't there any more — ${detail}`;
  }
  if (isLoad(context)) {
    return `Couldn't load ${context.loading} — ${detail}`;
  }
  if (context) {
    return `Couldn't ${context.action} — ${detail}`;
  }
  return `Couldn't complete that — ${detail}`;
}

/** Whether the failure is one the user can do something about, and what. */
export function recoveryHint(err: unknown): string | null {
  switch (errorKind(err)) {
    case "notAGitRepo":
      return "Initialise a repository in Source Control to track changes here.";
    case "notFound":
      return "It may have been renamed or deleted since this view loaded. Refresh to see what's there now.";
    default:
      return null;
  }
}

/** Whether a surfaced error reads as "the agent's own login expired or was
 *  never completed" rather than a generic failure — the phrasing an ACP
 *  agent's CLI (Claude Code, Codex, …) uses when it isn't authenticated.
 *
 *  This regex stays, and stays a regex, on purpose. Every one of its callers
 *  reads text an *agent* produced, and those are third-party CLIs whose
 *  wording nobody here controls — no amount of typing on Palisade's side of
 *  the boundary gives them a status code. The half that was avoidable is the
 *  one Palisade wrote itself, and that now travels as `kind`. */
export function isAuthError(message: string): boolean {
  return /unauthoriz|not logged in|not authenticated|(please |needs? to be )?(log|sign)(ged)? in( for| again| to)?|authentication (failed|required|expired)|re-?auth|session expired|token (expired|invalid)|credentials (expired|invalid)|\b401\b/i.test(
    message
  );
}
