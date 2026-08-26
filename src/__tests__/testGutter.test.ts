import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  markersForFile,
  resolveTestPath,
  setTestMarkers,
  testMarkerGutter,
  testMarkersFor,
} from "../testGutter";
import type { TestReport } from "../api";

const report = (cases: TestReport["cases"]): TestReport => ({
  framework: "cargo",
  cases,
  parsed: true,
  unexplainedFailure: false,
});

const failing = {
  name: "tests::fails",
  status: "failed" as const,
  file: "src/lib.rs",
  line: 9,
  message: "assertion `left == right` failed",
};

describe("markersForFile", () => {
  it("returns the failures reported for this file", () => {
    const markers = markersForFile(report([failing]), "src/lib.rs");
    expect(markers).toEqual([
      { line: 9, status: "failed", name: "tests::fails", message: failing.message },
    ]);
  });

  it("matches a runner path that is relative to a subdirectory of the project", () => {
    // `cargo test` run inside `src-tauri/` reports `src/lib.rs`; the editor
    // knows the file as `src-tauri/src/lib.rs`.
    expect(markersForFile(report([failing]), "src-tauri/src/lib.rs")).toHaveLength(1);
  });

  it("does not match a file that merely ends with the same basename", () => {
    // `src/lib.rs` must not light up markers meant for `vendor/other/lib.rs`.
    expect(markersForFile(report([failing]), "vendor/other/lib.rs")).toHaveLength(0);
  });

  it("ignores passing tests — a gutter tick on every line is noise", () => {
    const passing = { ...failing, name: "tests::passes", status: "passed" as const, message: null };
    expect(markersForFile(report([passing, failing]), "src/lib.rs")).toHaveLength(1);
  });

  it("ignores cases with no location: there is no line to mark", () => {
    const located = { ...failing, file: null, line: null };
    expect(markersForFile(report([located]), "src/lib.rs")).toHaveLength(0);
  });

  it("keeps a crashed test's marker, distinguished from a clean failure", () => {
    const crashed = { ...failing, name: "boom", status: "errored" as const, line: 14 };
    const markers = markersForFile(report([failing, crashed]), "src/lib.rs");
    expect(markers.map((m) => m.status)).toEqual(["failed", "errored"]);
  });

  it("has nothing to show for an unparsed report", () => {
    const unparsed: TestReport = {
      framework: "none",
      cases: [],
      parsed: false,
      unexplainedFailure: true,
    };
    expect(markersForFile(unparsed, "src/lib.rs")).toHaveLength(0);
    expect(markersForFile(null, "src/lib.rs")).toHaveLength(0);
  });

  it("drops a marker pointing past the end of the file rather than throwing", () => {
    const beyond = { ...failing, line: 9999 };
    const view = new EditorView({
      state: EditorState.create({ doc: "one\ntwo\n", extensions: [testMarkerGutter()] }),
    });
    // A stale result from before a big deletion: clamped away, never a crash.
    view.dispatch({ effects: setTestMarkers.of(markersForFile(report([beyond]), "src/lib.rs")) });
    expect(testMarkersFor(view.state)).toHaveLength(0);
    view.destroy();
  });

  it("holds the markers it was given in editor state", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n",
        extensions: [testMarkerGutter()],
      }),
    });
    expect(testMarkersFor(view.state)).toHaveLength(0);
    view.dispatch({ effects: setTestMarkers.of(markersForFile(report([failing]), "src/lib.rs")) });
    expect(testMarkersFor(view.state).map((m) => m.line)).toEqual([9]);
    // Replacing with an empty set clears them — a green re-run must not leave
    // the previous run's red marks behind.
    view.dispatch({ effects: setTestMarkers.of([]) });
    expect(testMarkersFor(view.state)).toHaveLength(0);
    view.destroy();
  });
});

describe("resolveTestPath", () => {
  const files = [
    "src/App.tsx",
    "src-tauri/src/lib.rs",
    "src-tauri/src/terminal.rs",
    "vendor/other/lib.rs",
  ];

  it("passes a path that is already project-relative straight through", () => {
    expect(resolveTestPath("src/App.tsx", files)).toBe("src/App.tsx");
  });

  it("resolves a path a runner reported from a subdirectory", () => {
    // `cargo test` inside `src-tauri/` reports `src/lib.rs`.
    expect(resolveTestPath("src/lib.rs", files)).toBe("src-tauri/src/lib.rs");
  });

  it("prefers the shallowest match when several files could fit", () => {
    expect(resolveTestPath("lib.rs", ["a/b/c/lib.rs", "x/lib.rs"])).toBe("x/lib.rs");
  });

  it("hands back the reported path when nothing matches, rather than guessing", () => {
    // Better a clear "file not found" than opening an unrelated file.
    expect(resolveTestPath("gone/missing.rs", files)).toBe("gone/missing.rs");
  });

  it("works with no file list at all", () => {
    expect(resolveTestPath("src/lib.rs", [])).toBe("src/lib.rs");
  });
});
