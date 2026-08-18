import { describe, expect, it } from "vitest";
import { rowsFromChange, rowsFromHunk, pairRows } from "../diffLines";

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

  // An added line exists only in the new file and a removed one only in the
  // old, so each side's numbering advances independently — numbering both
  // off one counter is what makes a gutter drift out of step with the file.
  it("numbers each side from the hunk header, skipping the side a line is absent from", () => {
    const rows = rowsFromHunk({
      oldStart: 10,
      newStart: 20,
      lines: [" ctx", "-gone", "+fresh", " tail"],
    });
    expect(rows).toEqual([
      { type: "context", content: "ctx", oldLine: 10, newLine: 20 },
      { type: "remove", content: "gone", oldLine: 11 },
      { type: "add", content: "fresh", newLine: 21 },
      { type: "context", content: "tail", oldLine: 12, newLine: 22 },
    ]);
  });

  it("omits numbers entirely when the hunk carries no header", () => {
    const rows = rowsFromHunk({ lines: [" a"] });
    expect(rows).toEqual([{ type: "context", content: "a" }]);
  });
});

describe("pairRows", () => {
  it("puts a context line on both sides", () => {
    expect(pairRows([{ type: "context", content: "a" }])).toEqual([
      { left: { type: "context", content: "a" }, right: { type: "context", content: "a" } },
    ]);
  });

  // A rewrite should read as a replacement, not as a block of deletes
  // followed by a block of inserts — old and new sit on the same row.
  it("zips a removed run against the added run that replaces it", () => {
    const pairs = pairRows([
      { type: "remove", content: "old1" },
      { type: "remove", content: "old2" },
      { type: "add", content: "new1" },
      { type: "add", content: "new2" },
    ]);
    expect(pairs).toEqual([
      { left: { type: "remove", content: "old1" }, right: { type: "add", content: "new1" } },
      { left: { type: "remove", content: "old2" }, right: { type: "add", content: "new2" } },
    ]);
  });

  it("leaves the shorter side blank when the runs are uneven", () => {
    const pairs = pairRows([
      { type: "remove", content: "old" },
      { type: "add", content: "new1" },
      { type: "add", content: "new2" },
    ]);
    expect(pairs).toEqual([
      { left: { type: "remove", content: "old" }, right: { type: "add", content: "new1" } },
      { left: null, right: { type: "add", content: "new2" } },
    ]);
  });

  it("handles a pure insertion with nothing removed before it", () => {
    expect(pairRows([{ type: "add", content: "new" }])).toEqual([
      { left: null, right: { type: "add", content: "new" } },
    ]);
  });

  it("handles a pure deletion with nothing added after it", () => {
    expect(pairRows([{ type: "remove", content: "gone" }])).toEqual([
      { left: { type: "remove", content: "gone" }, right: null },
    ]);
  });

  it("never loses or duplicates a line", () => {
    const rows = rowsFromHunk({
      oldStart: 1,
      newStart: 1,
      lines: [" a", "-b", "-c", "+B", " d", "+e"],
    });
    const pairs = pairRows(rows);
    const seen = pairs.flatMap((p) =>
      [p.left, p.right].filter((r): r is NonNullable<typeof r> => r !== null),
    );
    for (const row of rows) expect(seen).toContainEqual(row);
  });
});
