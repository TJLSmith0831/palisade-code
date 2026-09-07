import { describe, expect, it } from "vitest";
import { fuzzyMatch, scorePath } from "../fuzzyMatch";

describe("fuzzyMatch", () => {
  it("requires every query character, in order", () => {
    expect(fuzzyMatch("apt", "a-p-t.ts")).not.toBeNull();
    expect(fuzzyMatch("apt", "tpa.ts")).toBeNull();
    expect(fuzzyMatch("", "anything")).toBe(0);
  });

  it("rewards consecutive runs", () => {
    expect(fuzzyMatch("apt", "apt.ts")!).toBeGreaterThan(
      fuzzyMatch("apt", "a-p-t.ts")!
    );
  });
});

describe("scorePath — file-picker ranking", () => {
  // Found by driving the live app: typing `@rea` offered three 64-character
  // generated cache filenames before any real file, because a long path
  // gives a short query that many places to match.
  it("puts a filename hit above a hit scattered through directories", () => {
    const readme = scorePath("rea", "README.md")!;
    const cache = scorePath(
      "rea",
      "graphify-out/cache/ast/v0.9.45/5bb3c671e7c68faa52938e8918ce2a0e.json"
    );
    expect(readme).not.toBeNull();
    if (cache !== null) expect(readme).toBeGreaterThan(cache);
  });

  it("prefers the shorter of two filenames that both match", () => {
    expect(scorePath("app", "src/App.tsx")!).toBeGreaterThan(
      scorePath("app", "src/AppShellContainerLegacy.tsx")!
    );
  });

  it("still matches a query that only appears in the directories", () => {
    expect(scorePath("hooks", "src/hooks/useAppShell.ts")).not.toBeNull();
    expect(scorePath("zzz", "src/App.tsx")).toBeNull();
  });
});
