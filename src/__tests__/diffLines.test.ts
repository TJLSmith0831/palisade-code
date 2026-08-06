import { describe, expect, it } from "vitest";
import { rowsFromChange, rowsFromHunk } from "../diffLines";

describe("rowsFromChange", () => {
  it("marks unchanged, added, and removed lines", () => {
    const rows = rowsFromChange("a\nb\nc\n", "a\nx\nc\n");
    expect(rows).toEqual([
      { type: "context", content: "a" },
      { type: "remove", content: "b" },
      { type: "add", content: "x" },
      { type: "context", content: "c" },
    ]);
  });

  it("handles pure additions with no prior content", () => {
    expect(rowsFromChange("", "new\n")).toEqual([{ type: "add", content: "new" }]);
  });
});

describe("rowsFromHunk", () => {
  it("maps unified-diff hunk line prefixes to row types", () => {
    const rows = rowsFromHunk({
      lines: [" context line", "-removed line", "+added line", " more context"],
    });
    expect(rows).toEqual([
      { type: "context", content: "context line" },
      { type: "remove", content: "removed line" },
      { type: "add", content: "added line" },
      { type: "context", content: "more context" },
    ]);
  });

  it("drops the 'no newline at end of file' marker line", () => {
    const rows = rowsFromHunk({ lines: [" a", "+b", "\\ No newline at end of file"] });
    expect(rows).toEqual([
      { type: "context", content: "a" },
      { type: "add", content: "b" },
    ]);
  });
});
