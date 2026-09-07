import { useCallback, useMemo, useRef, useState } from "react";
import { useMantineColorScheme } from "@mantine/core";
import { useResizable } from "../useResizable";

export const THEME_KEY = "palisade:theme";

export type Theme = "auto" | "light" | "dark";

export const nextTheme = (t: Theme): Theme =>
  t === "auto" ? "light" : t === "light" ? "dark" : "auto";

/// The left icon rail's panel inventory. Identical in both presets — the
/// Governing Rule is that Vibe and Editor share one panel set and differ
/// only in arrangement, so this list is deliberately not per-shell.
export const PANEL_IDS = [
  "explorer",
  "search",
  "git",
  "specs",
  "codemap",
  "run",
  "mcp",
  "database",
  "chains",
  "history",
  "workspace",
  "settings",
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/// Bottom-panel tabs (Amendment 3). Problems is populated by LSP diagnostics
/// once Phase 4 lands; the tab exists from Phase 2 so it has a home.
export type BottomTab = "terminal" | "problems" | "tests";

export function useAppShell(projectHash: string | undefined) {
  const layoutHash = projectHash ?? "default";
  const { setColorScheme: setMantineColorScheme } = useMantineColorScheme();

  const [diffOpen, setDiffOpenState] = useState(false);

  const [centerShell, setCenterShellState] = useState<"vibe" | "editor">(
    "editor"
  );
  const shellChosenRef = useRef(false);
  const setCenterShell = useCallback((shell: "vibe" | "editor") => {
    shellChosenRef.current = true;
    setCenterShellState(shell);
  }, []);

  // Which left-rail panel is open, or null for "rail only, no panel". Held
  // once for both presets so switching Vibe/Editor never resets it. Starts
  // closed — the rail itself is the wayfinding, no panel should presume to
  // be what the user wants on a first look.
  const [activePanel, setActivePanel] = useState<PanelId | null>(null);
  const selectPanel = useCallback((id: PanelId) => {
    setActivePanel((current) => (current === id ? null : id));
  }, []);

  // Vibe-only browse surface (Amendment 3); Editor gets the thread-tab strip
  // alone, so this state is simply not read in that preset.
  const [sessionListOpen, setSessionListOpen] = useState(true);
  // Whether the user has *asked* for this column, as opposed to it being open
  // because it starts open. A narrow window folds it away on its own, and the
  // toggle has to be able to win over that fold — otherwise the button is
  // inert on a small laptop and there is no way back to the thread list.
  const [sessionListUserOpened, setSessionListUserOpened] = useState(false);
  const toggleSessionList = useCallback(
    () =>
      setSessionListOpen((open) => {
        setSessionListUserOpened(!open);
        return !open;
      }),
    []
  );

  // Editor-only chat collapse (Amendment 9). Hidden in Vibe, where chat is
  // the primary surface and the session-list toggle already reclaims width.
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const toggleChat = useCallback(
    () => setChatCollapsed((collapsed) => !collapsed),
    []
  );

  // The mirror of the above for Vibe: there the editor column is the
  // secondary pane, so that is what collapses. Separate state rather than one
  // shared flag — collapsing chat in Editor should not hide the tabs the next
  // time you switch to Vibe.
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  const toggleEditor = useCallback(
    () => setEditorCollapsed((collapsed) => !collapsed),
    []
  );

  // Opening the diff has to reclaim the pane that renders it. The diff is a
  // mode of the editor column, which Vibe lets you collapse — so "View diff"
  // in the chat, a click in Source Control, and the turn-start auto-open all
  // pointed at an unmounted pane and looked inert. Wrapped here because every
  // one of those callers already goes through this setter; the tab-open path
  // in App.tsx makes the same reclaim for the same reason.
  const setDiffOpen = useCallback(
    (next: boolean | ((open: boolean) => boolean)) => {
      const value = typeof next === "function" ? next(diffOpen) : next;
      if (value) setEditorCollapsed(false);
      setDiffOpenState(value);
    },
    [diffOpen]
  );

  const [bottomTab, setBottomTab] = useState<BottomTab>("terminal");

  // Which threads have a tab in the chat strip. Like editor tabs: selecting
  // a thread opens one, closing removes it, and the thread itself is
  // untouched either way (History still lists every thread).
  const [openThreadIds, setOpenThreadIds] = useState<string[]>([]);
  const openThread = useCallback((id: string) => {
    setOpenThreadIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    // Editor lets you send the chat pane away, and every route to a thread
    // (the strip's +, History, a brand-new thread) ends up here — so this is
    // the one place that has to reclaim it, rather than each call site
    // remembering to. Only fires when the active thread actually changes,
    // so it never refights a deliberate collapse of the thread you're on.
    setChatCollapsed(false);
  }, []);
  const closeThread = useCallback((id: string) => {
    setOpenThreadIds((prev) => prev.filter((existing) => existing !== id));
  }, []);

  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(THEME_KEY) as Theme) || "auto"
  );

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      localStorage.setItem(THEME_KEY, next);
      setMantineColorScheme(next);
    },
    [setMantineColorScheme]
  );

  const leftRail = useResizable({
    storageKey: `palisade:layout:${layoutHash}:left`,
    defaultSize: 193,
    min: 160,
    max: 420,
    axis: "horizontal",
    // The rail and its panel are DOM-first/left-edge, but `data-preset`
    // flips their CSS `order` to the right edge in Vibe (see the shell's
    // "ONE shell, two arrangements" comment). The resize handle sits on
    // the panel's *inner* edge either way, so which drag direction grows
    // it flips right along with that visual side.
    reverse: centerShell === "vibe",
  });
  const rightPanel = useResizable({
    storageKey: `palisade:layout:${layoutHash}:right`,
    defaultSize: 300,
    // Floor raised from 260 to the 300px default: below 300 the composer's
    // own controls row (agent + model chips at their floor, Spec/Go, send)
    // no longer fits, and the send button was clipped off the pane's edge.
    min: 300,
    max: 820,
    axis: "horizontal",
    reverse: true,
    defaultCollapsed: false,
  });
  const terminalPanel = useResizable({
    storageKey: `palisade:layout:${layoutHash}:terminal`,
    defaultSize: 220,
    min: 120,
    max: 560,
    axis: "vertical",
    reverse: true,
    defaultCollapsed: true,
  });
  const vibeChat = useResizable({
    storageKey: `palisade:layout:${layoutHash}:vibe-chat`,
    defaultSize: 520,
    min: 380,
    max: 900,
    axis: "horizontal",
  });

  // The terminal lives in the bottom panel, full stop. It used to be movable
  // into a right-panel tab, but the right panel stopped rendering a terminal
  // tab (Amendment 3) — so "move to sidebar" collapsed the terminal into
  // nowhere, and the only control that undid it lived inside the panel it
  // had just hidden.
  const toggleTerminal = terminalPanel.toggleCollapsed;

  return useMemo(
    () => ({
      diffOpen,
      setDiffOpen,
      centerShell,
      setCenterShell,
      shellChosenRef,
      activePanel,
      selectPanel,
      sessionListOpen,
      sessionListUserOpened,
      toggleSessionList,
      chatCollapsed,
      toggleChat,
      editorCollapsed,
      toggleEditor,
      bottomTab,
      setBottomTab,
      openThreadIds,
      openThread,
      closeThread,
      toggleTerminal,
      theme,
      setTheme,
      nextTheme,
      leftRail,
      rightPanel,
      terminalPanel,
      vibeChat,
    }),
    [
      diffOpen,
      centerShell,
      activePanel,
      selectPanel,
      sessionListOpen,
      sessionListUserOpened,
      toggleSessionList,
      chatCollapsed,
      toggleChat,
      editorCollapsed,
      toggleEditor,
      bottomTab,
      openThreadIds,
      openThread,
      closeThread,
      theme,
      toggleTerminal,
      leftRail,
      rightPanel,
      terminalPanel,
      vibeChat,
    ]
  );
}

export type AppShell = ReturnType<typeof useAppShell>;
