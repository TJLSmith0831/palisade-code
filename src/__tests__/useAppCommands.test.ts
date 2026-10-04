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
      openPanel: noop,
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
    onNewWindow: noop,
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
    unreviewedCount: 0,
    onNextUnreviewed: noop,
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

  it("offers Next unreviewed thread only while the Unreviewed band has rows", () => {
    const off = list().find((c) => c.id === "fleet.nextUnreviewed")!;
    expect(off.enabled).toBe(false);
    expect(off.label).toBe("Next unreviewed thread");

    const onNextUnreviewed = vi.fn();
    const on = list({ unreviewedCount: 3, onNextUnreviewed }).find(
      (c) => c.id === "fleet.nextUnreviewed"
    )!;
    expect(on.enabled).toBe(true);
    expect(on.label).toBe("Next unreviewed thread (3)");
    on.run();
    expect(onNextUnreviewed).toHaveBeenCalledTimes(1);
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
  it("chat.focus hands focus to the composer (chat is always on screen)", () => {
    const heard = vi.fn();
    window.addEventListener("palisade-chat-command", heard);
    list().find((c) => c.id === "chat.focus")!.run();
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener("palisade-chat-command", heard);
  });

  // A thread is a page inside Fleet, so Mod+K is the way back out of it.
  it("Mod+K goes back to Fleet from a thread page, and is off on Fleet itself", () => {
    const openPanel = vi.fn();
    const base = deps();
    const onThread = list({ shell: { ...base.shell, openPanel } as typeof base.shell })
      .find((c) => c.id === "view.backToFleet")!;
    expect(onThread.chord).toBe("Mod+K");
    expect(onThread.enabled).toBe(true);
    onThread.run();
    expect(openPanel).toHaveBeenCalledWith("fleet");

    const onFleet = list({
      shell: { ...base.shell, activePanel: "fleet", openPanel } as typeof base.shell,
    }).find((c) => c.id === "view.backToFleet")!;
    expect(onFleet.enabled).toBe(false);
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
