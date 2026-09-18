import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import { loadViewed, setViewed, clearViewed } from "../reviewState";

describe("reviewState", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("starts empty and persists a viewed file per thread", () => {
    expect(loadViewed("t1").size).toBe(0);
    setViewed("t1", "src/a.ts", true);
    expect([...loadViewed("t1")]).toEqual(["src/a.ts"]);
    expect(loadViewed("t2").size).toBe(0);
    expect(localStorage.getItem("palisade.review.t1")).toBe('["src/a.ts"]');
  });

  it("unsets and clears", () => {
    setViewed("t1", "a", true);
    setViewed("t1", "b", true);
    expect(setViewed("t1", "a", false).has("a")).toBe(false);
    expect([...loadViewed("t1")]).toEqual(["b"]);
    clearViewed("t1");
    expect(loadViewed("t1").size).toBe(0);
  });

  it("returns an empty set for corrupt data and survives a throwing store", () => {
    localStorage.setItem("palisade.review.t1", "{not json");
    expect(loadViewed("t1").size).toBe(0);

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(setViewed("t1", "a", true).has("a")).toBe(true);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadViewed("t1").size).toBe(0);
    expect(() => clearViewed("t1")).not.toThrow();
  });
});
