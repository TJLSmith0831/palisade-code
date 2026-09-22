import { describe, expect, it } from "vitest";
import { applyMention, mentionAt, rankMentions } from "../mentions";

describe("mentionAt (#32)", () => {
  it("opens on an `@` that starts a word, anywhere in the line", () => {
    expect(mentionAt("@App", 4)).toEqual({ query: "App", start: 0 });
    expect(mentionAt("look at @src/Ap", 15)).toEqual({
      query: "src/Ap",
      start: 8,
    });
  });

  it("stays closed for text that only looks like a mention", () => {
    // An email address, and an npm scope typed mid-word — neither is a file.
    expect(mentionAt("me@example.com", 14)).toBeNull();
    expect(mentionAt("install pkg@1.2", 15)).toBeNull();
    // The space ended the mention: the user moved on to prose.
    expect(mentionAt("@src/App.tsx and", 16)).toBeNull();
    expect(mentionAt("no mention here", 15)).toBeNull();
  });

  it("reads the mention under the caret, not the last one in the line", () => {
    const text = "@one @two";
    expect(mentionAt(text, 4)).toEqual({ query: "one", start: 0 });
    expect(mentionAt(text, 9)).toEqual({ query: "two", start: 5 });
  });

  it("opens on a bare `@` so the menu can offer everything", () => {
    expect(mentionAt("fix @", 5)).toEqual({ query: "", start: 4 });
  });
});

describe("applyMention (#32)", () => {
  it("replaces the typed fragment with the full path and a trailing space", () => {
    const text = "look at @src/Ap and fix it";
    const mention = mentionAt(text, 15)!;
    expect(applyMention(text, mention, "src/App.tsx")).toEqual({
      text: "look at @src/App.tsx and fix it",
      caret: "look at @src/App.tsx".length,
    });
  });

  it("doesn't stack a second space, and lands the caret right after the path", () => {
    // No trailing text at all: a space is inserted, and the caret sits after it.
    const bare = "look at @src/Ap";
    const bareMention = mentionAt(bare, 15)!;
    expect(applyMention(bare, bareMention, "src/App.tsx")).toEqual({
      text: "look at @src/App.tsx ",
      caret: "look at @src/App.tsx ".length,
    });
  });
});

describe("rankMentions (#32)", () => {
  it("ranks fuzzy matches and caps the list", () => {
    const files = ["src/App.tsx", "src/api.ts", "docs/PREVIEW.md"];
    expect(rankMentions(files, "app")).toEqual(["src/App.tsx"]);
    expect(rankMentions(files, "")).toEqual(files);
    expect(rankMentions(files, "zzz")).toEqual([]);
    expect(rankMentions(Array.from({ length: 200 }, (_, i) => `f${i}.ts`), "")).
      toHaveLength(50);
  });
});

import { isPathQuery, rankThreads, splitPathQuery, threadSlug } from "../mentions";

describe("@ threads and outside paths", () => {
  it("slugs a title into one token", () => {
    expect(threadSlug("  Auth  token refresh fix ")).toBe("Auth-token-refresh-fix");
  });

  it("ranks threads by title, with or without the thread: prefix", () => {
    const threads = [{ title: "Auth token refresh fix" }, { title: "Preview pane" }];
    expect(rankThreads(threads, "auth")).toEqual([threads[0]]);
    expect(rankThreads(threads, "thread:Preview")).toEqual([threads[1]]);
    expect(rankThreads(threads, "")).toEqual(threads);
  });

  it("recognises paths outside the project and splits them", () => {
    expect(isPathQuery("~/Doc")).toBe(true);
    expect(isPathQuery("/Users")).toBe(true);
    expect(isPathQuery("~")).toBe(true);
    expect(isPathQuery("src/App")).toBe(false);
    expect(splitPathQuery("~/Documents/api")).toEqual({ dir: "~/Documents/", filter: "api" });
    expect(splitPathQuery("~")).toEqual({ dir: "~/", filter: "" });
    expect(splitPathQuery("/")).toEqual({ dir: "/", filter: "" });
  });

  it("keeps a picked folder open for the next level", () => {
    const text = "see @~/Doc";
    const mention = mentionAt(text, text.length)!;
    expect(applyMention(text, mention, "/Users/me/Documents/")).toEqual({
      text: "see @/Users/me/Documents/",
      caret: "see @/Users/me/Documents/".length,
    });
  });
});

import { mentionOptions, mentionTarget } from "../mentions";

describe("mentionOptions", () => {
  const threads = [{ title: "Auth token refresh fix" }];

  it("offers files, then threads, then Browse… for a project query", () => {
    const rows = mentionOptions("auth", { files: ["src/auth.ts"], threads, entries: null });
    expect(rows.map((r) => r.kind)).toEqual(["file", "thread", "browse"]);
    expect(mentionTarget(rows[1] as Exclude<(typeof rows)[number], { kind: "browse" }>)).toBe(
      "thread:Auth-token-refresh-fix"
    );
  });

  it("lists a folder by name prefix for a path query, folders keeping the menu open", () => {
    const entries = [
      { name: "Documents", is_dir: true, path: "/Users/me/Documents" },
      { name: "Downloads", is_dir: true, path: "/Users/me/Downloads" },
      { name: "notes.pdf", is_dir: false, path: "/Users/me/notes.pdf" },
    ];
    const rows = mentionOptions("~/Doc", { files: ["src/a.ts"], threads, entries });
    expect(rows.map((r) => r.kind)).toEqual(["path", "browse"]);
    expect(mentionTarget(rows[0] as Exclude<(typeof rows)[number], { kind: "browse" }>)).toBe(
      "/Users/me/Documents/"
    );
    // Still loading: only Browse… is offered.
    expect(mentionOptions("~/", { files: [], threads, entries: null })).toEqual([{ kind: "browse" }]);
  });
});

import { shortPath } from "../mentions";

describe("shortPath", () => {
  it("shows home as ~ and keeps the distinguishing tail of a long path", () => {
    expect(shortPath("/Users/me/.claude/skills/tdd")).toBe("~/.claude/skills/tdd");
    expect(shortPath("/Users/me")).toBe("~");
    expect(shortPath("/private/tmp/a/very/long/chain/of/folders/fixtures/", 20)).toBe("…/folders/fixtures/");
    expect(shortPath("/tmp/x")).toBe("/tmp/x");
  });
});

import { displayMentions } from "../mentions";

describe("displayMentions", () => {
  it("shows threads by title and outside paths short, leaving emails alone", () => {
    expect(displayMentions("redo @thread:Auth-token-fix now")).toBe("redo `@Auth token fix` now");
    expect(displayMentions("read @/Users/me/a/b/spec.md")).toBe("read `@~/a/b/spec.md`");
    expect(displayMentions("read @/private/tmp/some-long-session-folder/scratchpad/fixtures/spec.md")).toBe("read `@…/fixtures/spec.md`");
    expect(displayMentions("@src/App.tsx and me@example.com")).toBe("`@src/App.tsx` and me@example.com");
  });
});
