import { afterEach, describe, expect, it } from "vitest";
import { clearSession, loadSession, saveSession, sessionKey } from "../session";

afterEach(() => localStorage.clear());

const full = {
  openPaths: ["a.ts", "b.ts"],
  activePath: "b.ts",
  cursors: { "a.ts": 42 },
  expandedDirs: ["src"],
  diffOpen: true,
  includeHidden: true,
};

describe("editor session", () => {
  it("round-trips everything the editor was showing", () => {
    saveSession("proj", full);
    expect(loadSession("proj")).toEqual(full);
  });

  it("starts empty for a project that has never been opened", () => {
    const session = loadSession("unseen");
    expect(session.openPaths).toEqual([]);
    expect(session.activePath).toBeNull();
    expect(session.diffOpen).toBe(false);
  });

  it("keeps sessions separate per project", () => {
    saveSession("one", { ...full, openPaths: ["only-in-one.ts"], activePath: "only-in-one.ts" });
    saveSession("two", { ...full, openPaths: ["only-in-two.ts"], activePath: "only-in-two.ts" });

    expect(loadSession("one").openPaths).toEqual(["only-in-one.ts"]);
    expect(loadSession("two").openPaths).toEqual(["only-in-two.ts"]);
  });

  it("falls back to an empty session rather than throwing on corrupt storage", () => {
    localStorage.setItem(sessionKey("proj"), "{not json");
    expect(loadSession("proj").openPaths).toEqual([]);
  });

  it("drops an active path that isn't among the open tabs", () => {
    saveSession("proj", { ...full, openPaths: ["a.ts"], activePath: "gone.ts" });
    // Falls back to a tab that does exist rather than pointing at nothing.
    expect(loadSession("proj").activePath).toBe("a.ts");
  });

  it("survives a session written by an older build missing fields", () => {
    localStorage.setItem(
      sessionKey("proj"),
      JSON.stringify({ openPaths: ["a.ts"], activePath: "a.ts" }),
    );
    const session = loadSession("proj");

    expect(session.openPaths).toEqual(["a.ts"]);
    expect(session.cursors).toEqual({});
    expect(session.expandedDirs).toEqual([]);
  });

  it("discards junk inside otherwise-valid fields", () => {
    localStorage.setItem(
      sessionKey("proj"),
      JSON.stringify({
        openPaths: ["a.ts", 7, null],
        cursors: { "a.ts": "not a number", "b.ts": -5, "c.ts": 3 },
        expandedDirs: ["src", 12],
      }),
    );
    const session = loadSession("proj");

    expect(session.openPaths).toEqual(["a.ts"]);
    expect(session.cursors).toEqual({ "c.ts": 3 });
    expect(session.expandedDirs).toEqual(["src"]);
  });

  it("forgets a project on request", () => {
    saveSession("proj", full);
    clearSession("proj");
    expect(loadSession("proj").openPaths).toEqual([]);
  });
});

describe("hidden-file default", () => {
  it("shows dotfiles for a project with no saved session", () => {
    localStorage.clear();
    expect(loadSession("never-opened").includeHidden).toBe(true);
  });

  it("keeps dotfiles visible for a session written before the field existed", () => {
    localStorage.setItem(
      sessionKey("legacy"),
      JSON.stringify({ openPaths: [], activePath: null })
    );
    expect(loadSession("legacy").includeHidden).toBe(true);
  });

  it("honours an explicit off", () => {
    localStorage.setItem(
      sessionKey("off"),
      JSON.stringify({ openPaths: [], includeHidden: false })
    );
    expect(loadSession("off").includeHidden).toBe(false);
  });
});
