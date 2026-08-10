import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { tabKey, useOpenTabs } from "../openTabs";

/** Opens each path in order and returns the hook handle. */
const withTabs = (...paths: string[]) => {
  const view = renderHook(() => useOpenTabs());
  act(() => paths.forEach((path) => view.result.current.open(path)));
  return view;
};

const keys = (view: ReturnType<typeof withTabs>) =>
  view.result.current.tabs.map((tab) => tabKey(tab));

describe("useOpenTabs", () => {
  it("opens files as tabs and makes the newest active", () => {
    const view = withTabs("a.ts", "b.ts");
    expect(keys(view)).toEqual(["a.ts", "b.ts"]);
    expect(view.result.current.activePath).toBe("b.ts");
  });

  it("re-selects an already open file instead of opening it twice", () => {
    const view = withTabs("a.ts", "b.ts");
    act(() => view.result.current.open("a.ts"));
    expect(keys(view)).toEqual(["a.ts", "b.ts"]);
    expect(view.result.current.activePath).toBe("a.ts");
  });

  it("selects the tab to the right when the active one closes", () => {
    const view = withTabs("a.ts", "b.ts", "c.ts");
    act(() => view.result.current.open("b.ts"));
    act(() => view.result.current.close("b.ts"));
    expect(keys(view)).toEqual(["a.ts", "c.ts"]);
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
    expect(keys(view)).toEqual([]);
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

    expect(
      view.result.current.tabs.find((t) => tabKey(t) === "a.ts")?.dirty
    ).toBe(true);
    expect(
      view.result.current.tabs.find((t) => tabKey(t) === "b.ts")?.dirty
    ).toBe(false);
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

    expect(keys(view)).toEqual(["new.ts"]);
    expect(view.result.current.activePath).toBe("new.ts");
    expect(view.result.current.tabs[0].dirty).toBe(true);
  });

  it("follows a renamed directory into the files under it", () => {
    const view = withTabs("src/a.ts", "src/nested/b.ts", "other.ts");
    act(() => view.result.current.rename("src", "lib"));
    expect(keys(view)).toEqual(["lib/a.ts", "lib/nested/b.ts", "other.ts"]);
  });

  it("does not rewrite a path that merely starts with the same characters", () => {
    const view = withTabs("src-gen/a.ts");
    act(() => view.result.current.rename("src", "lib"));
    expect(keys(view)).toEqual(["src-gen/a.ts"]);
  });

  it("drops every tab under a deleted directory", () => {
    const view = withTabs("src/a.ts", "src/b.ts", "other.ts");
    act(() => view.result.current.dropPath("src"));
    expect(keys(view)).toEqual(["other.ts"]);
    expect(view.result.current.activePath).toBe("other.ts");
  });

  it("reopens the most recently closed tab", () => {
    const view = withTabs("a.ts", "b.ts");
    act(() => view.result.current.close("b.ts"));
    act(() => view.result.current.reopenLast());

    expect(keys(view)).toEqual(["a.ts", "b.ts"]);
    expect(view.result.current.activePath).toBe("b.ts");
  });

  it("does not offer to reopen a file that was deleted rather than closed", () => {
    const view = withTabs("a.ts", "gone.ts");
    act(() => view.result.current.dropPath("gone.ts"));
    act(() => view.result.current.reopenLast());
    expect(keys(view)).toEqual(["a.ts"]);
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

    expect(keys(view)).toEqual([]);
    expect(view.result.current.activePath).toBeNull();
    expect(view.result.current.anyDirty).toBe(false);
  });

  describe("Markdown preview mode", () => {
    it("defaults to false for a newly opened .md tab", () => {
      const view = withTabs("README.md");
      expect(
        view.result.current.tabs.find((t) => tabKey(t) === "README.md")
          ?.mdPreview
      ).toBe(false);
      expect(view.result.current.activeMdPreview).toBe(false);
    });

    it("defaults to false for a non-markdown tab", () => {
      const view = withTabs("src/foo.ts");
      expect(
        view.result.current.tabs.find((t) => tabKey(t) === "src/foo.ts")
          ?.mdPreview
      ).toBe(false);
      expect(view.result.current.activeMdPreview).toBe(false);
    });

    it("flips preview on for a tab and reports it as active", () => {
      const view = withTabs("README.md");
      act(() => view.result.current.setMdPreview("README.md", true));
      expect(
        view.result.current.tabs.find((t) => tabKey(t) === "README.md")
          ?.mdPreview
      ).toBe(true);
      expect(view.result.current.activeMdPreview).toBe(true);
    });

    it("ignores preview reports for a file that isn't open", () => {
      const view = withTabs("README.md");
      act(() => view.result.current.setMdPreview("gone.md", true));
      expect(view.result.current.activeMdPreview).toBe(false);
    });

    it("preserves preview state across a rename", () => {
      const view = withTabs("old.md");
      act(() => view.result.current.setMdPreview("old.md", true));
      act(() => view.result.current.rename("old.md", "new.md"));
      expect(
        view.result.current.tabs.find((t) => tabKey(t) === "new.md")?.mdPreview
      ).toBe(true);
      expect(view.result.current.activeMdPreview).toBe(true);
    });

    it("re-defaults to false when a .md tab is reopened after closeAll", () => {
      const view = withTabs("README.md");
      act(() => view.result.current.setMdPreview("README.md", true));
      act(() => view.result.current.closeAll());
      act(() => view.result.current.open("README.md"));
      expect(view.result.current.activeMdPreview).toBe(false);
    });
  });

  describe("spec tabs (mixed with file tabs)", () => {
    it("opens a spec tab with a spec:<name> key and makes it active", () => {
      const view = renderHook(() => useOpenTabs());
      act(() => {
        view.result.current.open("a.ts");
        view.result.current.openSpec("vibe-spec-tabs");
      });
      expect(keys(view)).toEqual(["a.ts", "spec:vibe-spec-tabs"]);
      expect(view.result.current.activePath).toBe("spec:vibe-spec-tabs");
      const specTab = view.result.current.tabs.find(
        (t) => tabKey(t) === "spec:vibe-spec-tabs"
      );
      expect(specTab?.type).toBe("spec");
    });

    it("re-selects an already open spec tab instead of duplicating", () => {
      const view = renderHook(() => useOpenTabs());
      act(() => {
        view.result.current.openSpec("vibe-spec-tabs");
        view.result.current.open("a.ts");
        view.result.current.openSpec("vibe-spec-tabs");
      });
      expect(keys(view)).toEqual(["spec:vibe-spec-tabs", "a.ts"]);
      expect(view.result.current.activePath).toBe("spec:vibe-spec-tabs");
    });

    it("closes a spec tab by its key and selects the neighbour", () => {
      const view = renderHook(() => useOpenTabs());
      act(() => {
        view.result.current.open("a.ts");
        view.result.current.openSpec("vibe-spec-tabs");
        view.result.current.open("b.ts");
      });
      act(() => view.result.current.close("spec:vibe-spec-tabs"));
      expect(keys(view)).toEqual(["a.ts", "b.ts"]);
      expect(view.result.current.activePath).toBe("b.ts");
    });

    it("cycles through mixed file and spec tabs", () => {
      const view = renderHook(() => useOpenTabs());
      act(() => {
        view.result.current.open("a.ts");
        view.result.current.openSpec("vibe-spec-tabs");
        view.result.current.open("b.ts");
      });
      // active is b.ts; cycle back -> spec tab
      act(() => view.result.current.cycle(-1));
      expect(view.result.current.activePath).toBe("spec:vibe-spec-tabs");
      // cycle back again -> a.ts
      act(() => view.result.current.cycle(-1));
      expect(view.result.current.activePath).toBe("a.ts");
    });

    it("reopens a closed spec tab via reopenLast", () => {
      const view = renderHook(() => useOpenTabs());
      act(() => {
        view.result.current.open("a.ts");
        view.result.current.openSpec("vibe-spec-tabs");
      });
      act(() => view.result.current.close("spec:vibe-spec-tabs"));
      act(() => view.result.current.reopenLast());
      expect(keys(view)).toEqual(["a.ts", "spec:vibe-spec-tabs"]);
      expect(view.result.current.activePath).toBe("spec:vibe-spec-tabs");
    });

    it("does not mark a spec tab as dirty", () => {
      const view = renderHook(() => useOpenTabs());
      act(() => view.result.current.openSpec("vibe-spec-tabs"));
      act(() => view.result.current.setDirty("spec:vibe-spec-tabs", true));
      expect(view.result.current.anyDirty).toBe(false);
      expect(view.result.current.activeIsDirty).toBe(false);
    });

    it("does not rename a spec tab when a file path is renamed", () => {
      const view = renderHook(() => useOpenTabs());
      act(() => {
        view.result.current.open("src/old.ts");
        view.result.current.openSpec("vibe-spec-tabs");
      });
      act(() => view.result.current.rename("src", "lib"));
      expect(keys(view)).toEqual(["lib/old.ts", "spec:vibe-spec-tabs"]);
    });

    it("does not drop a spec tab when a directory is deleted", () => {
      const view = renderHook(() => useOpenTabs());
      act(() => {
        view.result.current.open("src/a.ts");
        view.result.current.openSpec("vibe-spec-tabs");
      });
      act(() => view.result.current.dropPath("src"));
      expect(keys(view)).toEqual(["spec:vibe-spec-tabs"]);
    });
  });
});
