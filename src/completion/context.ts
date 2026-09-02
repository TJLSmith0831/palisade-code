/**
 * Cross-file context for FIM completion (GH#9 Phase 1).
 *
 * The model's worst failures are the ones where the answer was never in the
 * prompt: completing against a type, helper or constant that lives in another
 * file. This module picks the neighbouring files most likely to hold it.
 *
 * Selection lives here, in the frontend, because this is the side that knows
 * about open tabs, edit recency and the buffers' *unsaved* contents — the
 * backend would only see what is on disk. Ordering, budgeting and
 * serialization are the backend's job (`build_context_block` in
 * `completion.rs`), which sorts by path so the prompt's token prefix stays
 * stable across keystrokes and llama.cpp's KV cache keeps hitting.
 */

export type ContextFile = { path: string; text: string };

/**
 * How many neighbouring files ride along. Three fits comfortably inside the
 * backend's ~512-token context budget for typical source files, and keeps
 * membership stable enough that the cached prefix survives a tab switch.
 */
export const MAX_CONTEXT_FILES = 3;

/** How many edited paths the session remembers. */
const RECENT_EDIT_LIMIT = 16;

let recent: string[] = [];

/** Most-recently-edited first. Session-scoped; never persisted. */
export function recentEdits(): string[] {
  return [...recent];
}

export function recordEdit(path: string): void {
  if (!path) return;
  recent = [path, ...recent.filter((p) => p !== path)].slice(0, RECENT_EDIT_LIMIT);
}

export function resetRecentEdits(): void {
  recent = [];
}

/**
 * Module specifiers this file imports, limited to ones that could name a file
 * in this project. Bare specifiers (`react`, `std::io`) resolve to
 * dependencies or the toolchain and are never worth spending prompt budget on.
 *
 * Deliberately a regex rather than a parser: this runs on the completion hot
 * path, and a missed import costs one context file, not correctness.
 */
export function extractImportSpecifiers(text: string): string[] {
  const found: string[] = [];
  const add = (spec: string | undefined) => {
    if (spec && !found.includes(spec)) found.push(spec);
  };

  // JS/TS: import ... from "x", export ... from "x", require("x")
  for (const m of text.matchAll(/(?:from|require\s*\()\s*["']([^"']+)["']/g)) {
    if (m[1].startsWith(".")) add(m[1]);
  }
  // Python: `from .models import X` / `import util.helpers`
  for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s/gm)) {
    if (!PY_STDLIB.has(m[1].replace(/^\.+/, "").split(".")[0])) add(m[1]);
  }
  // Anchored to the end of the statement so it does not also swallow the
  // JS form (`import React from "react"`), which the clause above owns.
  for (const m of text.matchAll(/^\s*import\s+([.\w]+)(?:\s+as\s+\w+)?\s*$/gm)) {
    const root = m[1].split(".")[0];
    if (!PY_STDLIB.has(root)) add(m[1]);
  }
  // Rust: `use crate::store::Res;` — keep the module path, drop the item.
  for (const m of text.matchAll(/^\s*use\s+((?:crate|super|self)(?:::\w+)*)/gm)) {
    const segments = m[1].split("::");
    add(segments.length > 1 ? segments.slice(0, -1).join("::") : m[1]);
  }
  return found;
}

/** Python roots that are never project files. Not exhaustive — a miss only
 *  costs a wasted lookup that resolves to nothing. */
const PY_STDLIB = new Set([
  "typing", "os", "sys", "json", "re", "math", "time", "datetime", "pathlib",
  "collections", "itertools", "functools", "dataclasses", "abc", "enum",
  "asyncio", "logging", "subprocess", "unittest", "random", "io",
]);

/** True when `candidate` plausibly is the file `spec` refers to. Specifiers
 *  omit extensions and directory prefixes, so match on the tail. */
function specifierMatches(spec: string, candidate: string): boolean {
  const stem = spec
    .replace(/^\.+\/?/, "")
    .replace(/^(crate|super|self)::/, "")
    .split(/[/.:]+/)
    .filter(Boolean)
    .pop();
  if (!stem) return false;
  const base = candidate.split("/").pop()?.replace(/\.[^.]+$/, "");
  return base === stem;
}

/**
 * Picks the neighbouring files to send with a completion request, ranked
 * imports → open tabs → recent edits.
 *
 * Imports come first because they are the highest-precision answer to the
 * failure this feature exists to fix: the model completing against a symbol
 * it has never seen. Open tabs and edit recency are what is left when the
 * file has no project-local imports.
 */
export function gatherContext(opts: {
  currentPath: string;
  currentText: string;
  openPaths: string[];
  contentFor: (path: string) => string | undefined;
}): ContextFile[] {
  const { currentPath, currentText, openPaths, contentFor } = opts;

  const candidates = [...openPaths, ...recent];
  const specs = extractImportSpecifiers(currentText);
  const imported = candidates.filter((p) => specs.some((s) => specifierMatches(s, p)));

  const out: ContextFile[] = [];
  const seen = new Set<string>([currentPath]);

  for (const path of [...imported, ...openPaths, ...recent]) {
    if (out.length >= MAX_CONTEXT_FILES) break;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = contentFor(path);
    // A tab whose buffer is not loaded yet has nothing to contribute;
    // sending an empty entry would only spend budget.
    if (!text || !text.trim()) continue;
    out.push({ path, text });
  }
  return out;
}
