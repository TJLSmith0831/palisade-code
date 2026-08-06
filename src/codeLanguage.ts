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
