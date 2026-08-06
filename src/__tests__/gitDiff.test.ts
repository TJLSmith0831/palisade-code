import { describe, expect, it } from "vitest";
import { parsePatch } from "diff";
import { parseFilePatches, patchForHunk, pathFromPatch } from "../gitDiff";

const SAMPLE_DIFF = `diff --git a/tracked.txt b/tracked.txt
index 1234567..89abcde 100644
--- a/tracked.txt
+++ b/tracked.txt
@@ -1,3 +1,3 @@
 line one
-line two
+CHANGED
 line three
`;

describe("patchForHunk", () => {
  it("builds a standalone patch for one hunk that re-parses to just that hunk", () => {
    const [file] = parsePatch(SAMPLE_DIFF);
    const patchText = patchForHunk(file, file.hunks[0]);

    expect(patchText).toContain("--- a/tracked.txt");
    expect(patchText).toContain("+++ b/tracked.txt");
    expect(patchText).toContain("-line two");
    expect(patchText).toContain("+CHANGED");

    const [reparsed] = parsePatch(patchText);
    expect(reparsed.hunks).toHaveLength(1);
    expect(reparsed.hunks[0]).toEqual(file.hunks[0]);
  });

  it("picks out only the requested hunk when a file has multiple", () => {
    const twoHunkDiff = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 a
-b
+B
@@ -10,2 +10,2 @@
 y
-z
+Z
`;
    const [file] = parsePatch(twoHunkDiff);
    expect(file.hunks).toHaveLength(2);

    const patchText = patchForHunk(file, file.hunks[1]);
    expect(patchText).not.toContain("-b\n+B");
    expect(patchText).toContain("-z");
    expect(patchText).toContain("+Z");
  });
});

describe("pathFromPatch", () => {
  it("strips the b/ prefix for a modified file", () => {
    const [file] = parsePatch(SAMPLE_DIFF);
    expect(pathFromPatch(file)).toBe("tracked.txt");
  });

  it("falls back to the a/ (old) path for a deleted file, whose new side is /dev/null", () => {
    const deletion = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 1234567..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`;
    const [file] = parsePatch(deletion);
    expect(pathFromPatch(file)).toBe("gone.txt");
  });
});

describe("parseFilePatches", () => {
  it("returns no entries for an empty diff, unlike jsdiff's own parsePatch", () => {
    // jsdiff's parsePatch("") returns one degenerate hunk-less entry, not [] —
    // a caller checking `.length > 0` to mean "has changes" gets a false
    // positive on a clean diff without this filter.
    expect(parsePatch("").length).toBe(1);
    expect(parseFilePatches("")).toEqual([]);
  });

  it("returns one entry per real file with hunks", () => {
    const [file] = parsePatch(SAMPLE_DIFF);
    expect(parseFilePatches(SAMPLE_DIFF)).toEqual([file]);
  });
});
