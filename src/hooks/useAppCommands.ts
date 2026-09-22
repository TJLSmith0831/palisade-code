import { useMemo } from "react";
import type { MutableRefObject } from "react";
import type { Command } from "../commands";
import type { Project } from "../api";
import type { AppShell } from "./useAppShell";
import type { OpenTabs } from "../openTabs";

/**
 * Every action the app exposes, assembled in one place.
 *
 * The palette, the global keyboard handler and the native menu bar all read
 * this list, so a shortcut is declared once instead of being written into a
 * keydown switch and described again somewhere the user can find it.
 *
 * It is the largest single block that was inside App.tsx — 374 lines of one
 * 4,500-line component. The long dependency list below is not incidental
 * coupling that extraction should have removed: a command registry exposes
 * every action there is, so it depends on every action there is. What moving
 * it buys is that the list is now readable on its own, and that App is no
 * longer the only place you can read it.
 */
export type AppCommandDeps = {
  project: Project | null;
  projects: Project[];
  shell: AppShell;
  tabs: OpenTabs;
  codeEditorActive: boolean;
  updateReady: boolean;
  debugLive: boolean;
  liveSessionId: string | null;
  runList: [string, string][];
  runLast: string | null;
  openFilePalette: () => void;
  openTextSearch: () => void;
  newFileAtRoot: () => void;
  onNewThread: () => void;
  onCloneRepository: () => void;
  onOpenProjectWindow: (target: Project) => void;
  clearRecentProjects: () => void;
  closeWindow: () => void;
  quitApplication: () => void;
  selectProject: (next: Project) => void;
  runCommand: (name: string, command: string) => void;
  onStop: () => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
  selectedFile: string | null;
  setCommandPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  /** How many threads finished and have not been opened since; the "Next
   *  unreviewed thread" command is only offered while there are some. */
  unreviewedCount: number;
  onNextUnreviewed: () => void;
  /** Read through refs so a command's `run` always sees the current value
   *  rather than whatever was current when the list was memoised. */
  activePathRef: MutableRefObject<string | null>;
  closeTabRef: MutableRefObject<(path: string) => void>;
  tabsRef: MutableRefObject<OpenTabs>;
};

export function useAppCommands({
  project,
  projects,
  shell,
  tabs,
  codeEditorActive,
  updateReady,
  debugLive,
  liveSessionId,
  runList,
  runLast,
  openFilePalette,
  openTextSearch,
  newFileAtRoot,
  onNewThread,
  onCloneRepository,
  onOpenProjectWindow,
  clearRecentProjects,
  closeWindow,
  quitApplication,
  selectProject,
  runCommand,
  onStop,
  onAddProject,
  onOpenSettings,
  selectedFile,
  setCommandPaletteOpen,
  setSettingsOpen,
  unreviewedCount,
  onNextUnreviewed,
  activePathRef,
  closeTabRef,
  tabsRef,
}: AppCommandDeps): Command[] {
  // Chat is the subject of the one layout, so the pane you can send away is
  // the editor column.
  const toggleSidePane = shell.toggleEditor;

  return useMemo<Command[]>(
    () => [
      // Listed first and listed at all so the palette documents its own way
      // in: this chord used to live only in the keyboard handler, which made
      // it the single shortcut the shortcut list didn't mention.
      {
        id: "file.new",
        group: "File",
        label: "New file…",
        chord: "Mod+N",
        enabled: !!project,
        run: newFileAtRoot,
      },
      {
        id: "thread.new",
        group: "File",
        label: "New thread…",
        chord: "Mod+Shift+N",
        enabled: !!project,
        run: onNewThread,
      },
      {
        // The one key an AI-first editor is judged by: get to the prompt
        // without touching the mouse, from anywhere, even with chat hidden.
        id: "chat.focus",
        group: "View",
        label: "Focus chat",
        chord: "Mod+L",
        keywords: "composer message prompt agent thread",
        enabled: !!project,
        run: () => {
          window.dispatchEvent(
            new CustomEvent("palisade-chat-command", { detail: "focus" })
          );
        },
      },
      {
        id: "project.open",
        group: "File",
        label: "Open project…",
        chord: "Mod+O",
        run: () => void onAddProject(),
      },
      {
        id: "project.clone",
        group: "File",
        label: "Clone repository…",
        run: onCloneRepository,
      },
      {
        id: "project.newWindow",
        group: "File",
        label: "Open current project in new window",
        enabled: !!project,
        run: () => { if (project) void onOpenProjectWindow(project); },
      },
      ...projects.slice(0, 10).map((recent, slot) => ({
        id: `project.recent.${slot}`,
        group: "File",
        label: recent.displayName,
        run: () => void selectProject(recent),
      })),
      {
        id: "project.recent.clear",
        group: "File",
        label: "Clear Menu",
        enabled: projects.some((entry) => entry.hash !== project?.hash),
        run: clearRecentProjects,
      },
      {
        id: "window.close",
        group: "File",
        label: "Close window",
        chord: "Mod+Shift+W",
        run: closeWindow,
      },
      {
        id: "app.quit",
        group: "App",
        label: "Quit Palisade",
        chord: "Mod+Q",
        run: quitApplication,
      },
      {
        id: "app.checkUpdates",
        group: "App",
        label: updateReady ? "Restart to Update" : "Check for Updates…",
        run: () => window.dispatchEvent(new Event("palisade-update-action")),
      },
      {
        id: "help.commands",
        group: "Help",
        label: "Command palette (all shortcuts)",
        chord: "Mod+Shift+P",
        keywords: "help keyboard shortcuts commands keys",
        run: () => setCommandPaletteOpen(true),
      },
      {
        id: "file.open",
        group: "Go",
        label: "Go to file…",
        chord: "Mod+P",
        keywords: "open quick jump",
        enabled: !!project,
        run: () => void openFilePalette(),
      },
      {
        id: "file.search",
        group: "Go",
        label: "Find in files…",
        chord: "Mod+Shift+F",
        keywords: "search grep text",
        enabled: !!project,
        run: () => void openTextSearch(),
      },
      {
        id: "editor.find",
        group: "Edit",
        label: "Find…",
        chord: "Mod+F",
        enabled: codeEditorActive,
        run: () => window.dispatchEvent(new CustomEvent("palisade-editor-command", { detail: "find" })),
      },
      {
        id: "editor.findNext",
        group: "Edit",
        label: "Find next",
        chord: "Mod+G",
        enabled: codeEditorActive,
        run: () => window.dispatchEvent(new CustomEvent("palisade-editor-command", { detail: "findNext" })),
      },
      {
        id: "editor.findPrevious",
        group: "Edit",
        label: "Find previous",
        chord: "Mod+Shift+G",
        enabled: codeEditorActive,
        run: () => window.dispatchEvent(new CustomEvent("palisade-editor-command", { detail: "findPrevious" })),
      },
      {
        id: "editor.goToLine",
        group: "Go",
        label: "Go to line…",
        chord: "Ctrl+G",
        enabled: codeEditorActive,
        run: () => window.dispatchEvent(new CustomEvent("palisade-editor-command", { detail: "goToLine" })),
      },
      {
        id: "editor.goToDefinition",
        group: "Go",
        label: "Go to definition",
        chord: "F12",
        enabled: codeEditorActive,
        run: () => window.dispatchEvent(new CustomEvent("palisade-editor-command", { detail: "goToDefinition" })),
      },
      {
        id: "tab.close",
        group: "Tabs",
        label: "Close tab",
        chord: "Mod+W",
        enabled: !!activePathRef.current,
        run: () => {
          const path = activePathRef.current;
          if (path) closeTabRef.current(path);
        },
      },
      {
        id: "tab.reopen",
        group: "Tabs",
        label: "Reopen closed tab",
        chord: "Mod+Shift+T",
        run: () => tabsRef.current.reopenLast(),
      },
      {
        id: "tab.next",
        group: "Tabs",
        label: "Next tab",
        chord: "Ctrl+Tab",
        run: () => tabsRef.current.cycle(1),
      },
      {
        id: "tab.previous",
        group: "Tabs",
        label: "Previous tab",
        chord: "Ctrl+Shift+Tab",
        run: () => tabsRef.current.cycle(-1),
      },
      {
        id: "file.save",
        group: "File",
        label: "Save",
        // Honest on both counts: offered only when there is something to
        // save, and routed through the pane that owns the buffer rather than
        // by clicking whatever save button happens to be in the DOM (there
        // is none on a notebook, an image, or a binary file).
        enabled: tabs.activeIsDirty,
        run: () => window.dispatchEvent(new CustomEvent("palisade-editor-command", { detail: "save" })),
      },
      {
        id: "run.last",
        group: "Run",
        label: "Run last configuration",
        enabled: !!project && runList.length > 0,
        run: () => {
          const selected = runList.find(([name]) => name === runLast) ?? runList[0];
          if (selected) runCommand(...selected);
        },
      },
      ...runList.slice(0, 10).map(([name, command], slot) => ({
        id: `run.config.${slot}`,
        group: "Run",
        label: name,
        run: () => runCommand(name, command),
      })),
      {
        id: "run.configure",
        group: "Run",
        label: "Configure run commands…",
        enabled: !!project,
        run: () => shell.selectPanel("run"),
      },
      {
        id: "debug.start",
        group: "Run",
        label: "Start debugging",
        enabled: !!project && !!selectedFile && runList.length > 0,
        chord: "F5",
        run: () => {
          shell.selectPanel("run");
          window.setTimeout(() => window.dispatchEvent(new Event("palisade-debug-start")), 0);
        },
      },
      {
        id: "debug.stop",
        group: "Run",
        label: "Stop debugging",
        enabled: debugLive,
        chord: "Shift+F5",
        run: () => window.dispatchEvent(new Event("palisade-debug-stop")),
      },
      {
        id: "agent.stop",
        group: "Run",
        label: "Stop active agent session",
        enabled: !!liveSessionId,
        run: onStop,
      },
      {
        id: "view.diff",
        group: "View",
        label: "Toggle changes view",
        keywords: "diff git review",
        run: () => shell.setDiffOpen((open) => !open),
      },
      {
        id: "view.fleet",
        group: "View",
        label: "Fleet",
        chord: "Mod+1",
        keywords: "runs board agents threads",
        enabled: !!project,
        run: () => shell.openPanel("fleet"),
      },
      {
        id: "view.review",
        group: "View",
        label: "Review",
        chord: "Mod+2",
        keywords: "diff changes verify merge land",
        enabled: !!project,
        run: () => shell.openPanel("review"),
      },
      {
        // The Unreviewed band as a workflow: jump to the newest finished
        // thread you have not read, then the next, until the band is empty.
        id: "fleet.nextUnreviewed",
        group: "View",
        label:
          unreviewedCount > 0
            ? `Next unreviewed thread (${unreviewedCount})`
            : "Next unreviewed thread",
        chord: "Mod+Shift+U",
        keywords: "unread finished turn done inbox jump",
        enabled: !!project && unreviewedCount > 0,
        run: onNextUnreviewed,
      },
      {
        id: "view.theme.auto",
        group: "View",
        label: "System appearance",
        checked: shell.theme === "auto",
        run: () => shell.setTheme("auto"),
      },
      {
        id: "view.theme.light",
        group: "View",
        label: "Light appearance",
        checked: shell.theme === "light",
        run: () => shell.setTheme("light"),
      },
      {
        id: "view.theme.dark",
        group: "View",
        label: "Dark appearance",
        checked: shell.theme === "dark",
        run: () => shell.setTheme("dark"),
      },
      {
        id: "view.rightPanel",
        group: "View",
        // The chord means "hide the pane that isn't the subject", which is
        // the editor column — chat is the subject.
        label: "Toggle editor panel",
        chord: "Mod+J",
        run: () => toggleSidePane(),
      },
      {
        id: "view.chat",
        group: "View",
        label: shell.chatCollapsed ? "Expand thread" : "Collapse thread",
        chord: "Mod+Shift+J",
        keywords: "chat conversation rail sidebar hide show",
        enabled: !shell.editorCollapsed,
        run: () => shell.toggleChat(),
      },
      {
        // A thread is a page inside Fleet, so the way out of it is back.
        id: "view.backToFleet",
        group: "View",
        label: "Back to Fleet",
        chord: "Mod+K",
        keywords: "home board threads leave close",
        enabled: !!project && shell.activePanel !== "fleet",
        run: () => shell.openPanel("fleet"),
      },
      {
        // One state, two entry points: this and the rail icon both drive
        // `activePanel` — a separate "collapsed" flag would be a second
        // source of truth for the same thing.
        id: "view.leftRail",
        group: "View",
        label: "Toggle side panel",
        chord: "Mod+Backslash",
        keywords: "explorer sidebar files",
        run: () => shell.selectPanel(shell.activePanel ?? "explorer"),
      },
      {
        id: "view.explorer",
        group: "View",
        label: "Toggle explorer",
        chord: "Mod+Shift+E",
        keywords: "files tree project",
        enabled: !!project,
        run: () => shell.selectPanel("explorer"),
      },
      {
        id: "view.terminal",
        group: "View",
        label: "Toggle terminal",
        chord: "Ctrl+Backtick",
        run: () => shell.toggleTerminal(),
      },
      {
        id: "app.settings",
        group: "App",
        label: "Open settings",
        keywords: "preferences font shell.theme wrap",
        run: () => setSettingsOpen(true),
      },
      {
        id: "app.projectSettings",
        group: "App",
        label: "Edit .palisade/project-settings.json",
        keywords: "format on save executor",
        enabled: !!project,
        run: () => void onOpenSettings(),
      },
      {
        id: "help.feedback",
        group: "Help",
        label: "Report a bug / request a feature…",
        run: () => window.dispatchEvent(new Event("palisade-feedback-action")),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      project,
      // Recomputed as tabs come and go: "Close tab" is only offered when
      // there is one, and a stale memo would keep hiding it.
      tabs.activePath,
      // ...and as the buffer goes dirty/clean, which is what File > Save and
      // the native menu's enabled state hang on.
      tabs.activeIsDirty,
      codeEditorActive,
      openFilePalette,
      openTextSearch,
      shell.rightPanel.toggleCollapsed,
      shell.selectPanel,
      shell.activePanel,
      shell.toggleTerminal,
      shell.theme,
      shell.chatCollapsed,
      shell.editorCollapsed,
      shell.toggleChat,
      shell.setTheme,
      newFileAtRoot,
      onNewThread,
      onCloneRepository,
      onOpenProjectWindow,
      projects,
      clearRecentProjects,
      closeWindow,
      quitApplication,
      updateReady,
      debugLive,
      selectProject,
      runList,
      runLast,
      runCommand,
      liveSessionId,
      onStop,
      unreviewedCount,
      onNextUnreviewed,
    ]
  );
}
