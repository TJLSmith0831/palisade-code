import { describe, it, expect } from "vitest";
import { relativeTime, filterThreads } from "../SessionList";
import type { ThreadMeta } from "../api";

// Amendment 3's session list. Grouping is by workspace and rendered from
// props, but the relative-timestamp formatter and the search filter both
// branch, so they get tests.

const thread = (over: Partial<ThreadMeta>): ThreadMeta => ({
  id: "t1",
  projectHash: "p",
  title: "Add a status-bar indicator",
  createdAt: "2026-08-14T09:00:00Z",
  updatedAt: "2026-08-14T09:00:00Z",
  currentMode: "go",
  openSpecChangeName: null,
  ...over,
});

describe("relativeTime", () => {
  const now = new Date("2026-08-14T12:00:00Z").getTime();

  it("reads just now under a minute", () => {
    expect(relativeTime("2026-08-14T11:59:30Z", now)).toBe("just now");
  });

  it("reads minutes under an hour", () => {
    expect(relativeTime("2026-08-14T11:58:00Z", now)).toBe("2m ago");
  });

  it("reads hours under a day", () => {
    expect(relativeTime("2026-08-14T10:00:00Z", now)).toBe("2h ago");
  });

  it("reads days beyond that", () => {
    expect(relativeTime("2026-08-12T12:00:00Z", now)).toBe("2d ago");
  });

  // A clock skew between machines must not render "-3m ago".
  it("clamps a future timestamp to just now rather than a negative age", () => {
    expect(relativeTime("2026-08-14T12:05:00Z", now)).toBe("just now");
  });

  it("renders an unparseable timestamp as empty rather than NaN", () => {
    expect(relativeTime("not-a-date", now)).toBe("");
  });
});

describe("filterThreads", () => {
  const threads = [
    thread({ id: "a", title: "Add LSP status bar" }),
    thread({ id: "b", title: "Fix chat auto-scroll" }),
  ];

  it("returns everything for an empty query", () => {
    expect(filterThreads(threads, "")).toHaveLength(2);
  });

  it("matches case-insensitively on the title", () => {
    expect(filterThreads(threads, "lsp").map((t) => t.id)).toEqual(["a"]);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(filterThreads(threads, "  chat  ").map((t) => t.id)).toEqual(["b"]);
  });

  it("returns nothing when the query matches no title", () => {
    expect(filterThreads(threads, "zzz")).toEqual([]);
  });
});
