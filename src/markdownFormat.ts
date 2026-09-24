import type { EditorView } from "@codemirror/view";

export type MarkdownFormat = "bold" | "italic" | "link" | "heading" | "list" | "task" | "quote" | "code" | "image" | "table";

/** Formatting changes only the selected source range; the rest of the file
 * keeps its original bytes and CodeMirror records one undoable transaction. */
export function formatMarkdown(view: EditorView, kind: MarkdownFormat) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.doc.sliceString(from, to);
  const line = view.state.doc.lineAt(from);
  const wrap = (before: string, after: string, placeholder: string) => {
    const content = selected || placeholder;
    view.dispatch({
      changes: { from, to, insert: before + content + after },
      selection: { anchor: from + before.length, head: from + before.length + content.length },
    });
  };
  if (kind === "bold") wrap("**", "**", "bold text");
  else if (kind === "italic") wrap("*", "*", "italic text");
  else if (kind === "code") wrap("`", "`", "code");
  else if (kind === "link") wrap("[", "](https://example.com)", "link text");
  else if (kind === "image") wrap("![", "](image.png)", "image description");
  else if (kind === "table") {
    const table = "| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |";
    view.dispatch({ changes: { from, to, insert: table }, selection: { anchor: from + 2, head: from + 10 } });
  } else {
    const prefix = { heading: "## ", list: "- ", task: "- [ ] ", quote: "> " }[kind];
    const existing = /^(?:- \[[ xX]\]|#{1,6}|[-*+]|\d+[.)]|>)\s+/.exec(line.text);
    const end = line.from + (existing?.[0].length ?? 0);
    view.dispatch({ changes: { from: line.from, to: end, insert: prefix } });
  }
  view.focus();
}
