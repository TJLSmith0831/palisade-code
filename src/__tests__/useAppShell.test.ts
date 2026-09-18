import { describe, it, expect, beforeEach } from "vitest";
import { createElement } from "react";
import { MantineProvider } from "@mantine/core";
import { act, renderHook } from "@testing-library/react";
import { useAppShell, PANEL_IDS } from "../hooks/useAppShell";

// The shared-shell contract from openspec/explore/shell-redesign: one panel
// inventory, two presets. These tests pin the state transitions the layout
// depends on — the layout itself is checked visually, but "which panel is
// open" and "does switching presets lose state" are branches, so they get
// tests (MEGA_PROMPT Process Rules: TDD for anything with a branch).

beforeEach(() => localStorage.clear());

const render = () =>
  renderHook(() => useAppShell("proj"), {
    wrapper: ({ children }) => createElement(MantineProvider, null, children),
  });

describe("left rail panel selection", () => {
  it("exposes the rail panels the redesign specifies, plus MCP, Database and Chains", () => {
    expect(PANEL_IDS).toEqual([
      "fleet",
      "review",
      "explorer",
      "search",
      "git",
      "specs",
      "run",
      "mcp",
      "database",
      "chains",
      "history",
      "workspace",
      "settings",
    ]);
  });

  it("opens on the Fleet board — an ADE's first question is what the runs are doing", () => {
    expect(render().result.current.activePanel).toBe("fleet");
  });

  it("opens a panel when its rail icon is selected", () => {
    const { result } = render();
    act(() => result.current.selectPanel("git"));
    expect(result.current.activePanel).toBe("git");
  });

  it("closes the panel when the already-active icon is selected again", () => {
    const { result } = render();
    act(() => result.current.selectPanel("git"));
    act(() => result.current.selectPanel("git"));
    expect(result.current.activePanel).toBeNull();
  });

  it("swaps panels without closing when a different icon is selected", () => {
    const { result } = render();
    act(() => result.current.selectPanel("git"));
    act(() => result.current.selectPanel("specs"));
    expect(result.current.activePanel).toBe("specs");
  });

  it("opens the board panels like any other rail selection", () => {
    const { result } = render();
    act(() => result.current.selectPanel("review"));
    expect(result.current.activePanel).toBe("review");
  });
});

describe("session list (Vibe preset only)", () => {
  it("is open by default so the browse surface is discoverable", () => {
    expect(render().result.current.sessionListOpen).toBe(true);
  });

  it("toggles from the title-bar control", () => {
    const { result } = render();
    act(() => result.current.toggleSessionList());
    expect(result.current.sessionListOpen).toBe(false);
    act(() => result.current.toggleSessionList());
    expect(result.current.sessionListOpen).toBe(true);
  });
});

describe("chat rail collapse (Editor preset only)", () => {
  it("starts expanded", () => {
    expect(render().result.current.chatCollapsed).toBe(false);
  });

  it("toggles from the title-bar control", () => {
    const { result } = render();
    act(() => result.current.toggleChat());
    expect(result.current.chatCollapsed).toBe(true);
  });
});

describe("bottom panel", () => {
  it("defaults to the Terminal tab", () => {
    expect(render().result.current.bottomTab).toBe("terminal");
  });

  it("switches to the Problems tab", () => {
    const { result } = render();
    act(() => result.current.setBottomTab("problems"));
    expect(result.current.bottomTab).toBe("problems");
  });

  // Amendment 9: the title-bar terminal toggle and the panel's own inline
  // chevron are two entry points onto ONE state, not two states.
  it("shares one collapsed state between the title bar and the inline chevron", () => {
    const { result } = render();
    const collapsedAtStart = result.current.terminalPanel.collapsed;
    act(() => result.current.toggleTerminal());
    expect(result.current.terminalPanel.collapsed).toBe(!collapsedAtStart);
    act(() => result.current.terminalPanel.toggleCollapsed());
    expect(result.current.terminalPanel.collapsed).toBe(collapsedAtStart);
  });
});

describe("opening the diff reclaims the pane that renders it", () => {
  // The diff is a mode of the editor column, which Vibe lets you collapse.
  // Before this, "View diff" in the chat, a Source Control click and the
  // turn-start auto-open all set diffOpen against an unmounted pane and
  // looked inert. Every one of those callers goes through setDiffOpen.
  it("uncollapses the editor column when the diff is opened", () => {
    const { result } = render();
    act(() => result.current.toggleEditor());
    expect(result.current.editorCollapsed).toBe(true);

    act(() => result.current.setDiffOpen(true));
    expect(result.current.diffOpen).toBe(true);
    expect(result.current.editorCollapsed).toBe(false);
  });

  it("reclaims it for the updater form too, as the tab bar's toggle uses", () => {
    const { result } = render();
    act(() => result.current.toggleEditor());
    expect(result.current.editorCollapsed).toBe(true);

    act(() => result.current.setDiffOpen((open) => !open));
    expect(result.current.diffOpen).toBe(true);
    expect(result.current.editorCollapsed).toBe(false);
  });

  it("leaves a deliberate collapse alone when the diff is being closed", () => {
    const { result } = render();
    act(() => result.current.setDiffOpen(true));
    act(() => result.current.toggleEditor());
    expect(result.current.editorCollapsed).toBe(true);

    act(() => result.current.setDiffOpen(false));
    expect(result.current.diffOpen).toBe(false);
    expect(result.current.editorCollapsed).toBe(true);
  });
});

describe("opening a thread reclaims a collapsed chat pane", () => {
  // Editor lets you send the chat pane away, and every route to a thread
  // ends up in openThread — so that is where the reclaim belongs.
  it("uncollapses the chat pane when a thread is opened", () => {
    const { result } = render();
    act(() => result.current.toggleChat());
    expect(result.current.chatCollapsed).toBe(true);

    act(() => result.current.openThread("t1"));
    expect(result.current.openThreadIds).toContain("t1");
    expect(result.current.chatCollapsed).toBe(false);
  });
});
