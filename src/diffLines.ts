import { diffLines } from "diff";

export type DiffRow = {
  type: "context" | "add" | "remove";
  content: string;
  /** Line numbers in the old and new file. Absent on the side where the line
   *  does not exist (an added line has no old number), and absent entirely
   *  when the source had no hunk header to count from. */
  oldLine?: number;
  newLine?: number;
};

/** One row of the side-by-side view: the old file's line on the left, the
 *  new file's on the right. Either side is null where a line was purely
 *  added or purely removed. */
export type DiffPair = { left: DiffRow | null; right: DiffRow | null };

/** Pairs a unified row list into side-by-side rows.
 *
 *  A replaced block reads as a replacement rather than a delete followed by
 *  an insert: each run of removes is zipped against the adds that follow it,
 *  so the old and new versions of the same line sit on one row. Uneven runs
 *  leave a blank cell on the shorter side. */
export function pairRows(rows: DiffRow[]): DiffPair[] {
  const pairs: DiffPair[] = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type === "context") {
      pairs.push({ left: rows[i], right: rows[i] });
      i++;
      continue;
    }
    const removes: DiffRow[] = [];
    const adds: DiffRow[] = [];
    while (i < rows.length && rows[i].type === "remove") removes.push(rows[i++]);
    while (i < rows.length && rows[i].type === "add") adds.push(rows[i++]);
    for (let k = 0; k < Math.max(removes.length, adds.length); k++) {
      pairs.push({ left: removes[k] ?? null, right: adds[k] ?? null });
    }
  }
  return pairs;
}

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

/** A unified-diff hunk's body ([jsdiff's `StructuredPatchHunk.lines`]) into
 *  rows, numbered from the hunk header when it carries one. */
export function rowsFromHunk(hunk: {
  lines: string[];
  oldStart?: number;
  newStart?: number;
}): DiffRow[] {
  const numbered = hunk.oldStart !== undefined || hunk.newStart !== undefined;
  let oldLine = hunk.oldStart ?? 1;
  let newLine = hunk.newStart ?? 1;
  const rows: DiffRow[] = [];
  for (const line of hunk.lines) {
    const marker = line[0];
    if (marker === "\\") continue; // "\ No newline at end of file" — not a content line
    const type = marker === "+" ? "add" : marker === "-" ? "remove" : "context";
    const row: DiffRow = { type, content: line.slice(1) };
    // An added line exists only in the new file, a removed one only in the
    // old — each advances just its own side's counter.
    if (numbered && type !== "add") row.oldLine = oldLine++;
    if (numbered && type !== "remove") row.newLine = newLine++;
    rows.push(row);
  }
  return rows;
}
