import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { TestReport, TestStatus } from "./api";

/** One failing test, pinned to the line the runner blamed. */
export type TestMarker = {
  /** 1-based, as the runner reported it. */
  line: number;
  status: TestStatus;
  name: string;
  message: string | null;
};

/**
 * The failures a report has for one file.
 *
 * Path matching is suffix-based in both directions: a runner reports paths
 * relative to wherever it ran (`cargo test` inside `src-tauri/` says
 * `src/lib.rs`), while the editor knows files relative to the project root.
 * The match is on whole path segments, so `src/lib.rs` can't claim
 * `vendor/other/lib.rs`.
 *
 * Only non-passing tests get a marker: a tick beside every line is noise,
 * and the point of the gutter is to say where something broke.
 */
export function markersForFile(
  report: TestReport | null | undefined,
  path: string
): TestMarker[] {
  if (!report?.parsed) return [];
  return report.cases.flatMap((testCase) => {
    if (testCase.status === "passed" || testCase.status === "skipped") return [];
    if (!testCase.file || testCase.line == null) return [];
    if (!samePath(testCase.file, path)) return [];
    return [
      {
        line: testCase.line,
        status: testCase.status,
        name: testCase.name,
        message: testCase.message,
      },
    ];
  });
}

/**
 * Turns a path a test runner reported into one the editor can open.
 *
 * Runners report paths relative to wherever they ran, which for a workspace
 * with a nested crate (`cargo test` in `src-tauri/`) is not the project root.
 * Matched against the project's own file list on whole segments; the
 * shallowest match wins, and an unmatched path is handed back unchanged so
 * the editor reports "not found" instead of opening something unrelated.
 */
export function resolveTestPath(reported: string, projectFiles: string[]): string {
  const clean = reported.replace(/^\.\//, "");
  if (projectFiles.includes(clean)) return clean;
  const suffix = `/${clean}`;
  let best: string | null = null;
  for (const file of projectFiles) {
    if (!file.endsWith(suffix)) continue;
    if (best === null || file.length < best.length) best = file;
  }
  return best ?? reported;
}

/** True when one path is a whole-segment suffix of the other. */
function samePath(reported: string, editorPath: string): boolean {
  const a = reported.replace(/^\.\//, "");
  const b = editorPath.replace(/^\.\//, "");
  if (a === b) return true;
  return b.endsWith(`/${a}`) || a.endsWith(`/${b}`);
}

/** Replaces every marker in the view. An empty array clears them, so a
 *  green re-run doesn't leave the previous run's red marks behind. */
export const setTestMarkers = StateEffect.define<TestMarker[]>();

const testMarkerField = StateField.define<TestMarker[]>({
  create: () => [],
  update(markers, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setTestMarkers)) continue;
      // Clamped to the document: results outlive the edits that invalidate
      // them, and a marker past the last line would throw in `doc.line()`.
      const lines = transaction.state.doc.lines;
      return effect.value.filter((m) => m.line >= 1 && m.line <= lines);
    }
    return markers;
  },
});

/** What the editor currently has marked — the field is the single source. */
export function testMarkersFor(state: { field: (f: typeof testMarkerField) => TestMarker[] }) {
  return state.field(testMarkerField);
}

class FailureMarker extends GutterMarker {
  constructor(private readonly marker: TestMarker) {
    super();
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = `ds-test-gutter is-${this.marker.status}`;
    dot.textContent = this.marker.status === "errored" ? "!" : "×";
    dot.title = this.marker.message
      ? `${this.marker.name}\n${this.marker.message}`
      : this.marker.name;
    return dot;
  }
}

/** A gutter column showing which tests failed, and where. */
export function testMarkerGutter(): Extension {
  return [
    testMarkerField,
    gutter({
      class: "ds-test-gutter-col",
      lineMarker(view, block) {
        const markers = view.state.field(testMarkerField);
        if (markers.length === 0) return null;
        const line = view.state.doc.lineAt(block.from).number;
        const hit = markers.find((m) => m.line === line);
        return hit ? new FailureMarker(hit) : null;
      },
      // Without this the gutter never re-renders when the markers change.
      lineMarkerChange: (update) =>
        update.transactions.some((t) => t.effects.some((e) => e.is(setTestMarkers))),
      initialSpacer: () => new FailureMarker({ line: 0, status: "failed", name: "", message: null }),
    }),
    EditorView.baseTheme({
      ".ds-test-gutter-col": { minWidth: "12px" },
      ".ds-test-gutter": { fontWeight: "bold", cursor: "default" },
      ".ds-test-gutter.is-failed": { color: "var(--danger, #e5484d)" },
      ".ds-test-gutter.is-errored": { color: "var(--warn)" },
    }),
  ];
}
