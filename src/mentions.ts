// The `@file` mention menu's pure half (#32). Kept out of App.tsx so the
// grammar — what counts as a mention, and what a pick does to the draft —
// can be tested without rendering the composer.
import { scorePath } from "./fuzzyMatch";

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
  // Don't stack a second space on one the user already typed.
  const gap = /^\s/.test(rest) ? "" : " ";
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
