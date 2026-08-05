import { describe, expect, it } from "vitest";
import { imagePathsFrom } from "../App";

describe("imagePathsFrom", () => {
  it("keeps only image paths, dropping everything else", () => {
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
      "/Users/me/Desktop/icon.svg",
    ]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(imagePathsFrom(["/a/b.txt", "/a/b.rs"])).toEqual([]);
  });
});
