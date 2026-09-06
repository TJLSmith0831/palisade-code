import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import type { StructuredPatch } from "diff";

import { addedLines, diffGutter, markedLines, setDiffLines } from "../diffGutter";

const patch = (lines: string[], newStart = 1): StructuredPatch =>
  ({
    oldFileName: "a",
    newFileName: "b",
    oldHeader: "",
    newHeader: "",
    hunks: [
      {
        oldStart: newStart,
        oldLines: lines.filter((l) => !l.startsWith("+")).length,
        newStart,
        newLines: lines.filter((l) => !l.startsWith("-")).length,
        lines,
      },
    ],
  }) as StructuredPatch;

describe("addedLines", () => {
  // Line numbers count against the *new* side: a removed line is not in the
  // buffer being decorated, so counting it would shift every later mark.
  it("numbers additions against the new file, skipping removals", () => {
    expect(addedLines(patch([" ctx", "-gone", "+one", "+two", " ctx"]))).toEqual([2, 3]);
  });

  it("respects a hunk that starts partway down the file", () => {
    expect(addedLines(patch([" ctx", "+new"], 40))).toEqual([41]);
  });

  it("has nothing to mark without a patch", () => {
    expect(addedLines(undefined)).toEqual([]);
  });
});

describe("diffGutter", () => {
  const withMarks = (doc: string, lines: number[]) =>
    EditorState.create({ doc, extensions: [diffGutter()] }).update({
      effects: setDiffLines.of(lines),
    }).state;

  it("marks the lines it is given", () => {
    expect(markedLines(withMarks("one\ntwo\nthree\n", [1, 3]))).toEqual([1, 3]);
  });

  // Results outlive the edits that invalidate them; a mark past the last line
  // would throw in doc.line().
  it("drops a mark past the end of the document", () => {
    expect(markedLines(withMarks("one\ntwo\n", [1, 99]))).toEqual([1]);
  });

  it("moves marks along with the text as it is edited", () => {
    const state = withMarks("one\ntwo\n", [2]);
    const after = state.update({ changes: { from: 0, insert: "zero\n" } }).state;
    expect(markedLines(after)).toEqual([3]);
  });
});
