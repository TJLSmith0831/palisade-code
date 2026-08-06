import { formatPatch, parsePatch, type StructuredPatch, type StructuredPatchHunk } from "diff";

/**
 * `parsePatch("")` returns one degenerate hunk-less entry rather than `[]`
 * (verified: jsdiff 9.0.0) — filtering those out keeps ".length > 0" a
 * reliable "does this diff have real changes" check for callers.
 */
export function parseFilePatches(diffText: string): StructuredPatch[] {
  return parsePatch(diffText).filter((patch) => patch.hunks.length > 0);
}

/** A standalone patch for just `hunk`, applyable independent of the file's other hunks. */
export function patchForHunk(patch: StructuredPatch, hunk: StructuredPatchHunk): string {
  return formatPatch({ ...patch, hunks: [hunk] });
}

/** The plain relative path a patch is for, stripped of git's a/ b/ prefixes. */
export function pathFromPatch(patch: StructuredPatch): string {
  const name = patch.newFileName === "/dev/null" ? patch.oldFileName : patch.newFileName;
  return (name ?? "").replace(/^[ab]\//, "");
}
