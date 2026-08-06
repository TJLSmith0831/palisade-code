import { diffLines } from "diff";

export type DiffRow = {
  type: "context" | "add" | "remove";
  content: string;
};

/** Line-level diff between two full file contents (no git involved). */
export function rowsFromChange(before: string, after: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const change of diffLines(before, after)) {
    const type = change.added ? "add" : change.removed ? "remove" : "context";
    const lines = change.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const content of lines) rows.push({ type, content });
  }
  return rows;
}

/** A unified-diff hunk's body ([jsdiff's `StructuredPatchHunk.lines`]) into rows. */
export function rowsFromHunk(hunk: { lines: string[] }): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const line of hunk.lines) {
    const marker = line[0];
    if (marker === "\\") continue; // "\ No newline at end of file" — not a content line
    const type = marker === "+" ? "add" : marker === "-" ? "remove" : "context";
    rows.push({ type, content: line.slice(1) });
  }
  return rows;
}
