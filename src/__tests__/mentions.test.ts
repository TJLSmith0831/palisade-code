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
