import { describe, expect, it } from "vitest";
import { filterCommands, formatChord, matchesChord, type Command } from "../commands";

const key = (init: Partial<KeyboardEvent> & { key: string }) =>
  ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

const command = (over: Partial<Command>): Command => ({
  id: "x",
  label: "Do a thing",
  group: "Test",
  run: () => {},
  ...over,
});

describe("matchesChord", () => {
  it("matches a plain Mod chord", () => {
    expect(matchesChord(key({ key: "p", metaKey: true }), "Mod+P")).toBe(true);
  });

  it("accepts Ctrl as Mod, for a non-mac keyboard", () => {
    expect(matchesChord(key({ key: "p", ctrlKey: true }), "Mod+P")).toBe(true);
  });

  it("does not fire a Mod chord when Shift is also held", () => {
    // Otherwise Mod+Shift+P would open the file palette as well as the
    // command palette.
    expect(matchesChord(key({ key: "p", metaKey: true, shiftKey: true }), "Mod+P")).toBe(false);
  });

  it("matches the Shift variant only when Shift is held", () => {
    expect(matchesChord(key({ key: "p", metaKey: true, shiftKey: true }), "Mod+Shift+P")).toBe(true);
    expect(matchesChord(key({ key: "p", metaKey: true }), "Mod+Shift+P")).toBe(false);
  });

  it("keeps Ctrl+Tab distinct from Ctrl+Shift+Tab", () => {
    expect(matchesChord(key({ key: "Tab", ctrlKey: true }), "Ctrl+Tab")).toBe(true);
    expect(matchesChord(key({ key: "Tab", ctrlKey: true, shiftKey: true }), "Ctrl+Tab")).toBe(false);
    expect(matchesChord(key({ key: "Tab", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+Tab")).toBe(true);
  });

  it("handles the punctuation chords", () => {
    expect(matchesChord(key({ key: "\\", metaKey: true }), "Mod+Backslash")).toBe(true);
    expect(matchesChord(key({ key: "`", metaKey: true }), "Mod+Backtick")).toBe(true);
  });

  it("ignores an unmodified keypress", () => {
    expect(matchesChord(key({ key: "p" }), "Mod+P")).toBe(false);
  });
});

describe("formatChord", () => {
  it("renders chords the way macOS writes them", () => {
    expect(formatChord("Mod+Shift+P")).toBe("⌘⇧P");
    expect(formatChord("Ctrl+Tab")).toBe("⌃⇥");
    expect(formatChord("Mod+Backtick")).toBe("⌘`");
    expect(formatChord("Mod+Backslash")).toBe("⌘\\");
  });
});

describe("filterCommands", () => {
  const commands = [
    command({ id: "a", label: "Go to file…", group: "Go", keywords: "open quick" }),
    command({ id: "b", label: "Toggle terminal", group: "View" }),
    command({ id: "c", label: "Close tab", group: "Tabs", enabled: false }),
  ];

  it("lists everything available when the query is empty", () => {
    expect(filterCommands(commands, "").map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("matches on label, group and hidden keywords", () => {
    expect(filterCommands(commands, "terminal").map((c) => c.id)).toEqual(["b"]);
    expect(filterCommands(commands, "view").map((c) => c.id)).toEqual(["b"]);
    expect(filterCommands(commands, "quick").map((c) => c.id)).toEqual(["a"]);
  });

  it("hides a command that isn't currently available", () => {
    expect(filterCommands(commands, "close")).toEqual([]);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(filterCommands(commands, "zzz")).toEqual([]);
  });
});
