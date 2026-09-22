import { describe, expect, it } from "vitest";
import { imagePathsFrom } from "../App";

describe("imagePathsFrom", () => {
  it("keeps only images the agent can take as image blocks — an SVG goes as a file mention", () => {
    const paths = [
      "/Users/me/Desktop/screenshot.png",
      "/Users/me/Desktop/notes.txt",
      "/Users/me/Desktop/photo.JPEG",
      "/Users/me/dev/repo/src/App.tsx",
      "/Users/me/Desktop/icon.svg",
    ];
    expect(imagePathsFrom(paths)).toEqual([
      "/Users/me/Desktop/screenshot.png",
      "/Users/me/Desktop/photo.JPEG",
    ]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(imagePathsFrom(["/a/b.txt", "/a/b.rs"])).toEqual([]);
  });
});
