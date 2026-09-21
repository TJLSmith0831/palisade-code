import { describe, expect, it } from "vitest";
import { DevServerTracker, MISSES_BEFORE_LIVE, MISSES_WHEN_LIVE } from "../devServers";

const answering = (up: Set<string>) => async (url: string) => up.has(new URL(url).origin);

describe("DevServerTracker", () => {
  it("shows nothing for a URL that has only been seen, never answered", async () => {
    const tracker = new DevServerTracker();
    tracker.add("http://localhost:3000/", "agent");
    expect(tracker.live()).toEqual([]);
    await tracker.check(answering(new Set()));
    expect(tracker.live()).toEqual([]);
  });

  it("shows a server once it answers", async () => {
    const tracker = new DevServerTracker();
    tracker.add("http://localhost:5173/", "terminal");
    const changed = await tracker.check(answering(new Set(["http://localhost:5173"])));
    expect(changed).toBe(true);
    expect(tracker.live()).toEqual([{ url: "http://localhost:5173/", origin: "terminal" }]);
  });

  it("reports no change when nothing visible changed", async () => {
    const tracker = new DevServerTracker();
    tracker.add("http://localhost:5173/", "terminal");
    const up = answering(new Set(["http://localhost:5173"]));
    await tracker.check(up);
    expect(await tracker.check(up)).toBe(false);
  });

  it("waits out a server that prints its banner before it listens", async () => {
    const tracker = new DevServerTracker();
    tracker.add("http://localhost:5173/", "terminal");
    for (let i = 0; i < MISSES_BEFORE_LIVE - 1; i++) await tracker.check(answering(new Set()));
    await tracker.check(answering(new Set(["http://localhost:5173"])));
    expect(tracker.live()).toHaveLength(1);
  });

  it("gives up on a URL that never answers", async () => {
    const tracker = new DevServerTracker();
    tracker.add("http://localhost:9999/", "agent");
    for (let i = 0; i < MISSES_BEFORE_LIVE; i++) await tracker.check(answering(new Set()));
    expect(tracker.size).toBe(0);
  });

  it("drops a live server once it has stopped answering — the stale chip", async () => {
    const tracker = new DevServerTracker();
    tracker.add("http://localhost:5173/", "terminal");
    await tracker.check(answering(new Set(["http://localhost:5173"])));
    expect(tracker.live()).toHaveLength(1);

    const down = answering(new Set());
    for (let i = 0; i < MISSES_WHEN_LIVE - 1; i++) {
      await tracker.check(down);
      expect(tracker.live(), "one missed check is a slow reply, not a stopped server").toHaveLength(1);
    }
    const changed = await tracker.check(down);
    expect(changed).toBe(true);
    expect(tracker.live()).toEqual([]);
  });

  it("forgives a single miss", async () => {
    const tracker = new DevServerTracker();
    tracker.add("http://localhost:5173/", "terminal");
    const up = answering(new Set(["http://localhost:5173"]));
    await tracker.check(up);
    await tracker.check(answering(new Set()));
    await tracker.check(up);
    await tracker.check(answering(new Set()));
    expect(tracker.live(), "misses are consecutive, not cumulative").toHaveLength(1);
  });

  it("treats the same server named twice as one, refreshing the page it points at", async () => {
    const tracker = new DevServerTracker();
    tracker.add("http://localhost:5173/", "terminal");
    tracker.add("http://localhost:5173/admin", "agent");
    await tracker.check(answering(new Set(["http://localhost:5173"])));
    expect(tracker.live()).toEqual([{ url: "http://localhost:5173/admin", origin: "terminal" }]);
  });

  it("tracks two servers independently", async () => {
    const tracker = new DevServerTracker();
    tracker.add("http://localhost:5173/", "terminal");
    tracker.add("http://localhost:4000/", "agent");
    await tracker.check(answering(new Set(["http://localhost:5173", "http://localhost:4000"])));
    await tracker.check(answering(new Set(["http://localhost:4000"])));
    await tracker.check(answering(new Set(["http://localhost:4000"])));
    expect(tracker.live().map((s) => s.url)).toEqual(["http://localhost:4000/"]);
  });

  it("treats a probe that throws as a miss", async () => {
    const tracker = new DevServerTracker();
    tracker.add("http://localhost:5173/", "terminal");
    await tracker.check(async () => {
      throw new Error("ipc down");
    });
    expect(tracker.live()).toEqual([]);
    expect(tracker.size).toBe(1);
  });

  it("forgets a removed server even if its probe is still in flight", async () => {
    const tracker = new DevServerTracker();
    tracker.add("http://localhost:5173/", "terminal");
    const pending = tracker.check(async () => true);
    tracker.remove("http://localhost:5173/");
    await pending;
    expect(tracker.live()).toEqual([]);
  });

  it("clear() forgets everything", async () => {
    const tracker = new DevServerTracker();
    tracker.add("http://localhost:5173/", "terminal");
    await tracker.check(async () => true);
    tracker.clear();
    expect(tracker.live()).toEqual([]);
    expect(tracker.size).toBe(0);
  });
});
