import type { Extension } from "@codemirror/state";
import { rust } from "@codemirror/lang-rust";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";

/** File extension (lowercase, no dot) -> CodeMirror language extension. */
const byExtension: Record<string, () => Extension> = {
  rs: () => rust(),
  js: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  mjs: () => javascript(),
  cjs: () => javascript(),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  py: () => python(),
  go: () => go(),
  json: () => json(),
  md: () => markdown(),
  markdown: () => markdown(),
  css: () => css(),
};

/** Extensions for the file at `path`, or `[]` (plain text) if unrecognized.
 *
 * Synchronous, and covers the languages bundled directly. Anything else
 * goes through `loadLanguageFor`, which can't answer until a chunk has
 * loaded — going async for these too would flash unhighlighted text on
 * every open of the file types this app is mostly used on. */
export function languageExtensionFor(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase();
  const make = ext ? byExtension[ext] : undefined;
  return make ? [make()] : [];
}

/** Display name for the status bar, e.g. "TypeScript". Falls back to the
 *  bare extension so an unusual file still says what it is, rather than
 *  claiming to be plain text when it isn't. */
export function languageLabelFor(path: string | null): string | null {
  if (!path) return null;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const names: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript",
    mts: "TypeScript",
    cts: "TypeScript",
    js: "JavaScript",
    jsx: "JavaScript",
    mjs: "JavaScript",
    cjs: "JavaScript",
    py: "Python",
    rs: "Rust",
    go: "Go",
    json: "JSON",
    css: "CSS",
    scss: "SCSS",
    html: "HTML",
    htm: "HTML",
    yaml: "YAML",
    yml: "YAML",
    md: "Markdown",
    markdown: "Markdown",
    toml: "TOML",
    sh: "Shell",
  };
  if (names[ext]) return names[ext];
  // No dot at all (Makefile, Dockerfile) — the filename is the best label.
  const filename = path.slice(path.lastIndexOf("/") + 1);
  return filename.includes(".") ? ext.toUpperCase() : "Plain text";
}

/** Highlighting for everything `languageExtensionFor` doesn't bundle —
 * HTML, YAML, TOML, SQL, shell, C/C++, Java and the rest of CodeMirror's
 * catalogue, each loaded on demand the first time such a file is opened.
 * Resolves `null` when the file genuinely has no known language. */
export async function loadLanguageFor(path: string): Promise<Extension | null> {
  if (languageExtensionFor(path).length > 0) return null;
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const { languages } = await import("@codemirror/language-data");
  const { LanguageDescription } = await import("@codemirror/language");
  const found = LanguageDescription.matchFilename(languages, filename);
  if (!found) return null;
  try {
    return await found.load();
  } catch {
    // A missing or broken language chunk is not worth failing the file
    // open over — plain text still edits fine.
    return null;
  }
}

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const videoExtensions = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

const mimeByExtension: Record<string, string> = {
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mov: "video/quicktime",
  m4v: "video/mp4",
};

export type MediaKind = "image" | "video" | null;

/** Whether `path`'s extension is an image/video the editor should preview
 * rather than try to render as text. */
export function mediaKindFor(path: string): MediaKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (imageExtensions.has(ext)) return "image";
  if (videoExtensions.has(ext)) return "video";
  return null;
}

/** MIME type for a `data:` URL, derived from the file extension. */
export function mimeTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return mimeByExtension[ext] ?? `${mediaKindFor(path) ?? "application"}/${ext}`;
}
