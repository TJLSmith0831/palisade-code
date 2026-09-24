import { describe, expect, it } from "vitest";
import { shouldOpenLinkedSpec } from "../specLink";

describe("shouldOpenLinkedSpec", () => {
  it("opens when the on-screen thread gains a spec link", () => {
    expect(shouldOpenLinkedSpec({ id: "t1", name: null }, { id: "t1", name: "c" })).toBe(true);
  });
  it("does not open when selecting an already-linked thread", () => {
    expect(shouldOpenLinkedSpec({ id: "t1", name: null }, { id: "t2", name: "c" })).toBe(false);
  });
  it("does not reopen an unchanged link or open without one", () => {
    expect(shouldOpenLinkedSpec({ id: "t1", name: "c" }, { id: "t1", name: "c" })).toBe(false);
    expect(shouldOpenLinkedSpec({ id: "t1", name: null }, { id: "t1", name: null })).toBe(false);
  });
});
