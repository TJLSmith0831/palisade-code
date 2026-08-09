import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useOpenTabs } from "../openTabs";

/** Opens each path in order and returns the hook handle. */
const withTabs = (...paths: string[]) => {
  const view = renderHook(() => useOpenTabs());
  act(() => paths.forEach((path) => view.result.current.open(path)));
  return view;
};

const paths = (view: ReturnType<typeof withTabs>) =>
  view.result.current.tabs.map((tab) => tab.path);

describe("useOpenTabs", () => {
  it("opens files as tabs and makes the newest active", () => {
    const view = withTabs("a.ts", "b.ts");
    expect(paths(view)).toEqual(["a.ts", "b.ts"]);
    expect(view.result.current.activePath).toBe("b.ts");
  });

  it("re-selects an already open file instead of opening it twice", () => {
    const view = withTabs("a.ts", "b.ts");
    act(() => view.result.current.open("a.ts"));
    expect(paths(view)).toEqual(["a.ts", "b.ts"]);
    expect(view.result.current.activePath).toBe("a.ts");
  });

  it("selects the tab to the right when the active one closes", () => {
    const view = withTabs("a.ts", "b.ts", "c.ts");
    act(() => view.result.current.open("b.ts"));
    act(() => view.result.current.close("b.ts"));
    expect(paths(view)).toEqual(["a.ts", "c.ts"]);
    expect(view.result.current.activePath).toBe("c.ts");
  });

  it("falls back to the left when the last tab closes", () => {
    const view = withTabs("a.ts", "b.ts");
    act(() => view.result.current.close("b.ts"));
    expect(view.result.current.activePath).toBe("a.ts");
  });

  it("leaves nothing active once the last tab is gone", () => {
    const view = withTabs("a.ts");
    act(() => view.result.current.close("a.ts"));
    expect(paths(view)).toEqual([]);
    expect(view.result.current.activePath).toBeNull();
  });

  it("keeps the selection put when a background tab closes", () => {
    const view = withTabs("a.ts", "b.ts", "c.ts");
    act(() => view.result.current.close("a.ts"));
    expect(view.result.current.activePath).toBe("c.ts");
  });

  it("tracks dirtiness per tab rather than globally", () => {
    const view = withTabs("a.ts", "b.ts");
    act(() => view.result.current.setDirty("a.ts", true));

    expect(view.result.current.tabs.find((t) => t.path === "a.ts")?.dirty).toBe(true);
    expect(view.result.current.tabs.find((t) => t.path === "b.ts")?.dirty).toBe(false);
    expect(view.result.current.anyDirty).toBe(true);
    // b.ts is the active tab, and it is clean — a global flag would have
    // reported the editor as dirty here.
    expect(view.result.current.activeIsDirty).toBe(false);
  });

  it("ignores dirty reports for a file that isn't open", () => {
    const view = withTabs("a.ts");
    act(() => view.result.current.setDirty("gone.ts", true));
    expect(view.result.current.anyDirty).toBe(false);
  });

  it("follows a renamed file, keeping it active and dirty", () => {
    const view = withTabs("old.ts");
    act(() => view.result.current.setDirty("old.ts", true));
    act(() => view.result.current.rename("old.ts", "new.ts"));

    expect(paths(view)).toEqual(["new.ts"]);
    expect(view.result.current.activePath).toBe("new.ts");
    expect(view.result.current.tabs[0].dirty).toBe(true);
  });

  it("follows a renamed directory into the files under it", () => {
    const view = withTabs("src/a.ts", "src/nested/b.ts", "other.ts");
    act(() => view.result.current.rename("src", "lib"));
    expect(paths(view)).toEqual(["lib/a.ts", "lib/nested/b.ts", "other.ts"]);
  });

  it("does not rewrite a path that merely starts with the same characters", () => {
    const view = withTabs("src-gen/a.ts");
    act(() => view.result.current.rename("src", "lib"));
    expect(paths(view)).toEqual(["src-gen/a.ts"]);
  });

  it("drops every tab under a deleted directory", () => {
    const view = withTabs("src/a.ts", "src/b.ts", "other.ts");
    act(() => view.result.current.dropPath("src"));
    expect(paths(view)).toEqual(["other.ts"]);
    expect(view.result.current.activePath).toBe("other.ts");
  });

  it("reopens the most recently closed tab", () => {
    const view = withTabs("a.ts", "b.ts");
    act(() => view.result.current.close("b.ts"));
    act(() => view.result.current.reopenLast());

    expect(paths(view)).toEqual(["a.ts", "b.ts"]);
    expect(view.result.current.activePath).toBe("b.ts");
  });

  it("does not offer to reopen a file that was deleted rather than closed", () => {
    const view = withTabs("a.ts", "gone.ts");
    act(() => view.result.current.dropPath("gone.ts"));
    act(() => view.result.current.reopenLast());
    expect(paths(view)).toEqual(["a.ts"]);
  });

  it("cycles forward and backward, wrapping at both ends", () => {
    const view = withTabs("a.ts", "b.ts", "c.ts");
    act(() => view.result.current.open("a.ts"));

    act(() => view.result.current.cycle(1));
    expect(view.result.current.activePath).toBe("b.ts");

    act(() => view.result.current.cycle(-1));
    expect(view.result.current.activePath).toBe("a.ts");

    act(() => view.result.current.cycle(-1));
    expect(view.result.current.activePath).toBe("c.ts");
  });

  it("clears everything on a project switch", () => {
    const view = withTabs("a.ts", "b.ts");
    act(() => view.result.current.closeAll());
    act(() => view.result.current.reopenLast());

    expect(paths(view)).toEqual([]);
    expect(view.result.current.activePath).toBeNull();
    expect(view.result.current.anyDirty).toBe(false);
  });
});
