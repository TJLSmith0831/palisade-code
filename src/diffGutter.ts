import {
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { StructuredPatch } from "diff";

/** Which lines of the *new* file a patch added or replaced, 1-based.
 *
 *  Only the added side is marked: this decorates the file as it stands now,
 *  and a removed line is not in it to mark. The count of removals is what the
 *  file list is for. */
export function addedLines(patch: StructuredPatch | undefined): number[] {
  if (!patch) return [];
  const lines: number[] = [];
  for (const hunk of patch.hunks) {
    let line = hunk.newStart;
    for (const raw of hunk.lines) {
      if (raw.startsWith("-")) continue;
      if (raw.startsWith("+")) lines.push(line);
      line += 1;
    }
  }
  return lines;
}

/** Replace the marked lines — dispatched when the pane re-reads the diff. */
export const setDiffLines = StateEffect.define<number[]>();

class ChangeMarker extends GutterMarker {
  elementClass = "ds-diff-gutter-mark";
  toDOM() {
    const mark = document.createElement("span");
    mark.className = "ds-diff-gutter-mark";
    mark.textContent = "+";
    mark.title = "Changed in this working tree";
    return mark;
  }
}

const marker = new ChangeMarker();
const lineDecoration = Decoration.line({ class: "ds-diff-changed-line" });

/** Positions of the marked lines, kept as a RangeSet so ordinary typing moves
 *  them along with the text instead of leaving the marks behind on whatever
 *  line numbers they started on. */
const diffField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(set, transaction) {
    set = set.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setDiffLines)) continue;
      const total = transaction.state.doc.lines;
      const ranges = effect.value
        .filter((line) => line >= 1 && line <= total)
        .map((line) => marker.range(transaction.state.doc.line(line).from));
      return RangeSet.of(ranges, true);
    }
    return set;
  },
  provide: (field) =>
    EditorView.decorations.compute([field], (state) => {
      const set = state.field(field);
      const ranges: ReturnType<typeof lineDecoration.range>[] = [];
      const cursor = set.iter();
      while (cursor.value) {
        ranges.push(lineDecoration.range(cursor.from));
        cursor.next();
      }
      return Decoration.set(ranges, true);
    }),
});

/** Which lines the view currently has marked, 1-based — the field is the
 *  single source, the same way `testMarkersFor` reads the test gutter's. */
export function markedLines(state: EditorState): number[] {
  const lines: number[] = [];
  const set = state.field(diffField, false);
  if (!set) return lines;
  set.between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number);
  });
  return lines;
}

/** A diff gutter over an ordinary editable buffer: the file is the file, with
 *  what changed marked in place — not a separate read-only "diff mode" the
 *  reviewer has to leave to fix a typo. */
export function diffGutter(): Extension {
  return [
    diffField,
    gutter({
      class: "ds-diff-gutter-col",
      markers: (view) => view.state.field(diffField),
      initialSpacer: () => marker,
    }),
  ];
}
