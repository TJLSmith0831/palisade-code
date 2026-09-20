import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("../api", () => new Proxy({}, { get: () => vi.fn() }));

import { useAppCommands, type AppCommandDeps } from "../hooks/useAppCommands";
import { matchesChord } from "../commands";

const noop = () => {};
const ref = <T,>(current: T) => ({ current });

const deps = (over: Partial<AppCommandDeps> = {}): AppCommandDeps =>
  ({
    project: { hash: "h", root: "/p", displayName: "p" },
    projects: [],
    shell: {
      centerShell: "vibe",
      theme: "auto",
      activePanel: "explorer",
      editorCollapsed: false,
      rightPanel: { toggleCollapsed: noop },
      toggleChat: noop,
      toggleEditor: noop,
      selectPanel: noop,
      toggleTerminal: noop,
      setCenterShell: noop,
      setTheme: noop,
    },
    tabs: { activePath: null, activeIsDirty: false, tabs: [] },
    codeEditorActive: false,
    updateReady: false,
    debugLive: false,
    liveSessionId: null,
    runList: [],
    runLast: null,
    openFilePalette: noop,
    openTextSearch: noop,
    newFileAtRoot: noop,
    onNewThread: noop,
    onCloneRepository: noop,
    onOpenProjectWindow: noop,
    clearRecentProjects: noop,
    closeWindow: noop,
    quitApplication: noop,
    selectProject: noop,
    runCommand: noop,
    onStop: noop,
    onAddProject: noop,
    onOpenSettings: noop,
    selectedFile: null,
    setCommandPaletteOpen: noop,
    setSettingsOpen: noop,
    activePathRef: ref<string | null>(null),
    closeTabRef: ref((_: string) => {}),
    tabsRef: ref({ tabs: [] }),
    ...over,
  }) as unknown as AppCommandDeps;

const list = (over: Partial<AppCommandDeps> = {}) =>
  renderHook(() => useAppCommands(deps(over))).result.current;

describe("useAppCommands", () => {
  it("builds a registry with unique ids", () => {
    const commands = list();
    expect(commands.length).toBeGreaterThan(20);
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every command a label and something to run", () => {
    for (const command of list()) {
      expect(command.label, command.id).toBeTruthy();
      expect(command.group, command.id).toBeTruthy();
      expect(typeof command.run, command.id).toBe("function");
    }
  });

  it("declares no chord twice, since one keystroke cannot mean two things", () => {
    const chords = list()
      .filter((c) => c.chord)
      .map((c) => c.chord as string);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it("writes chords the keyboard handler can actually match", () => {
    // The registry and the global keydown handler read the same list, so a
    // chord that matchesChord cannot parse is a shortcut that silently does
    // nothing.
    for (const command of list().filter((c) => c.chord)) {
      const chord = command.chord as string;
      expect(() => matchesChord(new KeyboardEvent("keydown"), chord), chord).not.toThrow();
    }
  });

  // "Close tab" is only offered when there is one. It reads the ref rather
  // than the memoised value so the answer is current at the moment the
  // palette renders, which is why tabs.activePath is also a dependency —
  // a stale memo would keep hiding a tab that had since opened.
  it("chat.focus reveals a collapsed chat and hands focus to the composer", () => {
    const toggleChat = vi.fn();
    const heard = vi.fn();
    window.addEventListener("palisade-chat-command", heard);
    const base = deps();
    list({ shell: { ...base.shell, chatOpen: false, toggleChat } as typeof base.shell })
      .find((c) => c.id === "chat.focus")!
      .run();
    expect(toggleChat).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener("palisade-chat-command", heard);
  });

  it("offers tab commands only when a tab is open", () => {
    const withNoTab = list().find((c) => c.id === "tab.close");
    const withTab = list({
      activePathRef: ref<string | null>("a.ts"),
      tabs: { activePath: "a.ts", activeIsDirty: false, tabs: [] },
    } as unknown as Partial<AppCommandDeps>).find((c) => c.id === "tab.close");
    expect(withNoTab?.enabled).toBe(false);
    expect(withTab?.enabled).toBe(true);
  });
});
