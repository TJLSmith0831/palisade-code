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

/** Extensions for the file at `path`, or `[]` (plain text) if unrecognized. */
export function languageExtensionFor(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase();
  const make = ext ? byExtension[ext] : undefined;
  return make ? [make()] : [];
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
