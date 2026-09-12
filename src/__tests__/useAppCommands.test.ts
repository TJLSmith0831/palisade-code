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
  it("offers tab commands only when a tab is open", () => {
    const withNoTab = list().find((c) => c.id === "tab.close");
    const withTab = list({
      activePathRef: ref<string | null>("a.ts"),
      tabs: { activePath: "a.ts", activeIsDirty: false, tabs: [] },
    } as unknown as Partial<AppCommandDeps>).find((c) => c.id === "tab.close");
    expect(withNoTab?.enabled).toBe(false);
    expect(withTab?.enabled).toBe(true);
  });

  // Regression for PR #47 review finding: the registry's useMemo omitted
  // onAddProject, setCommandPaletteOpen, setSettingsOpen, onOpenSettings,
  // selectedFile and shell.setDiffOpen from its dependency array, so a
  // rerender that only changed one of those left every command's `run`
  // closed over the value from the render the memo last actually ran on.
  //
  // Each test below rerenders with a *mutated copy* of the exact same
  // `base` props object, rather than a second call to `deps(...)` — the
  // `deps` helper's own defaults (`runList: []`, `projects: []`, fresh
  // `shell`/`tabs` objects) are new references on every call, which would
  // force the memo to recompute for reasons unrelated to the dependency
  // under test and hide the very staleness this is checking for.
  describe("recomputes when a previously-uncovered dependency changes", () => {
    it("project.open's run — onAddProject", () => {
      const first = vi.fn();
      const second = vi.fn();
      const base = deps({ onAddProject: first });
      const { result, rerender } = renderHook(
        (props: AppCommandDeps) => useAppCommands(props),
        { initialProps: base }
      );
      result.current.find((c) => c.id === "project.open")!.run();
      rerender({ ...base, onAddProject: second });
      result.current.find((c) => c.id === "project.open")!.run();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("help.commands's run — setCommandPaletteOpen", () => {
      const first = vi.fn();
      const second = vi.fn();
      const base = deps({ setCommandPaletteOpen: first });
      const { result, rerender } = renderHook(
        (props: AppCommandDeps) => useAppCommands(props),
        { initialProps: base }
      );
      result.current.find((c) => c.id === "help.commands")!.run();
      rerender({ ...base, setCommandPaletteOpen: second });
      result.current.find((c) => c.id === "help.commands")!.run();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("app.settings's run — setSettingsOpen", () => {
      const first = vi.fn();
      const second = vi.fn();
      const base = deps({ setSettingsOpen: first });
      const { result, rerender } = renderHook(
        (props: AppCommandDeps) => useAppCommands(props),
        { initialProps: base }
      );
      result.current.find((c) => c.id === "app.settings")!.run();
      rerender({ ...base, setSettingsOpen: second });
      result.current.find((c) => c.id === "app.settings")!.run();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("app.projectSettings's run — onOpenSettings", () => {
      const first = vi.fn();
      const second = vi.fn();
      const base = deps({ onOpenSettings: first });
      const { result, rerender } = renderHook(
        (props: AppCommandDeps) => useAppCommands(props),
        { initialProps: base }
      );
      result.current.find((c) => c.id === "app.projectSettings")!.run();
      rerender({ ...base, onOpenSettings: second });
      result.current.find((c) => c.id === "app.projectSettings")!.run();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("debug.start's enabled — selectedFile", () => {
      const runList: [string, string][] = [["a", "echo a"]];
      const base = deps({ selectedFile: null, runList });
      const { result, rerender } = renderHook(
        (props: AppCommandDeps) => useAppCommands(props),
        { initialProps: base }
      );
      expect(result.current.find((c) => c.id === "debug.start")?.enabled).toBe(false);
      rerender({ ...base, selectedFile: "a.ts" });
      expect(result.current.find((c) => c.id === "debug.start")?.enabled).toBe(true);
    });

    it("view.diff's run — shell.setDiffOpen", () => {
      const first = vi.fn();
      const second = vi.fn();
      const base = deps({
        shell: { ...deps().shell, setDiffOpen: first },
      } as unknown as Partial<AppCommandDeps>);
      const { result, rerender } = renderHook(
        (props: AppCommandDeps) => useAppCommands(props),
        { initialProps: base }
      );
      result.current.find((c) => c.id === "view.diff")!.run();
      rerender({
        ...base,
        shell: { ...base.shell, setDiffOpen: second },
      });
      result.current.find((c) => c.id === "view.diff")!.run();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("view.rightPanel's run picks up shell.toggleEditor in the vibe shell", () => {
      const first = vi.fn();
      const second = vi.fn();
      const base = deps({
        shell: { ...deps().shell, centerShell: "vibe", toggleEditor: first },
      } as unknown as Partial<AppCommandDeps>);
      const { result, rerender } = renderHook(
        (props: AppCommandDeps) => useAppCommands(props),
        { initialProps: base }
      );
      const toggle = () =>
        result.current.find((c) => c.id === "view.rightPanel")!.run();
      toggle();
      rerender({
        ...base,
        shell: { ...base.shell, toggleEditor: second },
      });
      toggle();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    });
  });
});
