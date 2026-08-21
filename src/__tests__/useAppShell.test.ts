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
  it("exposes the rail panels the redesign specifies, plus MCP and Database", () => {
    expect(PANEL_IDS).toEqual([
      "explorer",
      "search",
      "git",
      "specs",
      "codemap",
      "run",
      "mcp",
      "database",
      "history",
      "workspace",
      "settings",
    ]);
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

  // Governing rule: the panel inventory is identical in both presets, so the
  // open panel must survive a preset switch rather than resetting.
  it("keeps the open panel across a Vibe/Editor preset switch", () => {
    const { result } = render();
    act(() => result.current.selectPanel("codemap"));
    act(() => result.current.setCenterShell("vibe"));
    expect(result.current.activePanel).toBe("codemap");
    act(() => result.current.setCenterShell("editor"));
    expect(result.current.activePanel).toBe("codemap");
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
