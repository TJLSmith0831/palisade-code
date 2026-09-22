// The `@file` mention menu's pure half (#32). Kept out of App.tsx so the
// grammar — what counts as a mention, and what a pick does to the draft —
// can be tested without rendering the composer.
import { fuzzyMatch, scorePath } from "./fuzzyMatch";

/** The mention the caret is currently inside. `start` indexes the `@`. */
export type Mention = { query: string; start: number };

/** How many files the menu offers at once. Beyond this the user should type. */
const MENTION_LIMIT = 50;

/**
 * The `@file` mention under `caret`, or `null` when there isn't one.
 *
 * Only an `@` that opens a word counts. Mid-word it is an email address or an
 * npm scope (`@mantine/core` pasted after a package name), and popping a file
 * menu over either would be the composer arguing with what the user typed.
 * The first space closes it: the path is one token, and the rest of the
 * sentence is prose the agent should read as prose.
 */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, start: at };
}

/**
 * The draft with `mention` replaced by `path`, and where the caret goes.
 *
 * The trailing space is deliberate: it closes the menu, so picking a file and
 * carrying on typing never re-opens it over the next word.
 */
export function applyMention(
  text: string,
  mention: Mention,
  path: string
): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length;
  const rest = text.slice(end);
  // Don't stack a second space on one the user already typed. A folder keeps
  // the mention open instead, so the next level lists straight away.
  const gap = path.endsWith("/") || /^\s/.test(rest) ? "" : " ";
  return {
    text: `${text.slice(0, mention.start)}@${path}${gap}${rest}`,
    caret: mention.start + 1 + path.length + gap.length,
  };
}

/** Project files matching `query`, best first. Empty query offers the head of the list. */
export function rankMentions(files: string[], query: string): string[] {
  if (!query) return files.slice(0, MENTION_LIMIT);
  return files
    .map((path) => ({ path, score: scorePath(query, path) }))
    .filter((row): row is { path: string; score: number } => row.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, MENTION_LIMIT)
    .map((row) => row.path);
}

/** A readable suffix for a thread mention, whitespace as `-`.
 *  Mirrors `store::thread_slug`. The ID before it keeps duplicate titles distinct. */
export const THREAD_PREFIX = "thread:";
export const threadSlug = (title: string) => title.trim().split(/\s+/).join("-");

/** Threads whose title matches `query`, best first. */
export function rankThreads<T extends { title: string }>(threads: T[], query: string, limit = 8): T[] {
  const q = query.startsWith(THREAD_PREFIX) ? query.slice(THREAD_PREFIX.length) : query;
  if (!q) return threads.slice(0, limit);
  return threads
    .map((thread) => ({ thread, score: fuzzyMatch(q.replace(/-/g, " "), thread.title) }))
    .filter((row): row is { thread: T; score: number } => row.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.thread);
}

/** True when the mention is a path outside the project: `@/…` or `@~/…`. */
export const isPathQuery = (query: string) =>
  query.startsWith("/") || query === "~" || query.startsWith("~/");

/** A path query split into the folder to list and the name typed so far. */
export function splitPathQuery(query: string): { dir: string; filter: string } {
  if (query === "~") return { dir: "~/", filter: "" };
  const slash = query.lastIndexOf("/");
  return { dir: query.slice(0, slash + 1), filter: query.slice(slash + 1) };
}

/** One row of the `@` menu. */
export type MentionOption<T> =
  | { kind: "file"; path: string }
  | { kind: "thread"; thread: T }
  | { kind: "path"; entry: { name: string; is_dir: boolean; path: string } }
  | { kind: "browse" };

export type MentionScope = "all" | "threads" | "files";

/**
 * Every row the `@` menu offers for `query`, in order. A path query lists
 * that folder's entries by name prefix; anything else offers recent threads
 * first, then project files. Browse… is always last.
 */
export function mentionOptions<T extends { title: string }>(
  query: string,
  sources: {
    files: string[];
    threads: T[];
    /** The listed folder, for a path query; `null` while it loads. */
    entries: { name: string; is_dir: boolean; path: string }[] | null;
  },
  scope: MentionScope = "all"
): MentionOption<T>[] {
  const browse: MentionOption<T> = { kind: "browse" };
  if (isPathQuery(query)) {
    const filter = splitPathQuery(query).filter.toLowerCase();
    return [
      ...(sources.entries ?? [])
        .filter((entry) => entry.name.toLowerCase().startsWith(filter))
        .slice(0, MENTION_LIMIT)
        .map((entry): MentionOption<T> => ({ kind: "path", entry })),
      browse,
    ];
  }
  return [
    ...(scope === "files" ? [] : rankThreads(sources.threads, query, scope === "threads" ? MENTION_LIMIT : query ? 8 : 4)
      .map((thread): MentionOption<T> => ({ kind: "thread", thread }))),
    ...(scope === "threads" ? [] : rankMentions(sources.files, query)
      .map((path): MentionOption<T> => ({ kind: "file", path }))),
    ...(scope === "threads" ? [] : [browse]),
  ];
}

/** What a picked row puts after the `@` (Browse… is resolved by the caller). */
export function mentionTarget<T extends { title: string; id: string }>(
  option: Exclude<MentionOption<T>, { kind: "browse" }>
): string {
  if (option.kind === "file") return option.path;
  if (option.kind === "thread") return `${THREAD_PREFIX}${option.thread.id}::${threadSlug(option.thread.title)}`;
  return option.entry.is_dir ? `${option.entry.path}/` : option.entry.path;
}

/**
 * A path short enough for a menu header or card footer: the macOS home
 * folder as `~`, and past `max` characters only the last two folders, so
 * the part that tells two paths apart is the part that stays visible.
 */
export function shortPath(path: string, max = 40): string {
  const home = path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
  if (home.length <= max) return home;
  const trailing = home.endsWith("/");
  const parts = home.split("/").filter(Boolean);
  return `…/${parts.slice(-2).join("/")}${trailing ? "/" : ""}`;
}

/**
 * A sent turn's markdown with each `@` mention shown as a compact code
 * token: a thread by its title, an outside path by `shortPath`. Display
 * only — what the agent received is unchanged. Only a word-start `@` counts,
 * the same rule `mentionAt` uses, so an email address is left alone.
 */
export function displayMentions(markdown: string): string {
  return markdown.replace(/(^|\s)@(\S+)/g, (_, lead: string, target: string) => {
    const shown = target.startsWith(THREAD_PREFIX)
      ? (target.slice(THREAD_PREFIX.length).split("::")[1] ?? target.slice(THREAD_PREFIX.length)).replace(/-/g, " ")
      : isPathQuery(target)
        ? shortPath(target)
        : target;
    return `${lead}\`@${shown}\``;
  });
}
