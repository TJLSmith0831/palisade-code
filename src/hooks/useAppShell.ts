import { profileStorage as localStorage } from "../profileStorage";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMantineColorScheme } from "@mantine/core";
import { useResizable } from "../useResizable";

export const THEME_KEY = "palisade:theme";

export type Theme = "auto" | "light" | "dark";

export const nextTheme = (t: Theme): Theme =>
  t === "auto" ? "light" : t === "light" ? "dark" : "auto";

/// The left icon rail's panel inventory. `fleet` and `review` are not side
/// panels — they take over the center, which is what an ADE opens on — but
/// they are rail selections like any other, so they live in the same union.
export const PANEL_IDS = [
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
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/// Bottom-panel tabs (Amendment 3). Problems is populated by LSP diagnostics
/// once Phase 4 lands; the tab exists from Phase 2 so it has a home.
export type BottomTab = "terminal" | "problems" | "tests";

export function useAppShell(projectHash: string | undefined) {
  const layoutHash = projectHash ?? "default";
  const { setColorScheme: setMantineColorScheme } = useMantineColorScheme();

  const [diffOpen, setDiffOpenState] = useState(false);

  // Which rail selection is showing, or null for "rail only, no panel".
  // Opens on the Fleet board: an ADE's first question is "what are my runs
  // doing", and that answer is the same before you have picked anything.
  const [activePanel, setActivePanel] = useState<PanelId | null>("fleet");
  const selectPanel = useCallback((id: PanelId) => {
    setActivePanel((current) => (current === id ? null : id));
  }, []);
  // Direct set, for restoring a saved session — `selectPanel` toggles.
  const openPanel = useCallback((id: PanelId | null) => setActivePanel(id), []);

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

  // The editor column is the secondary pane, so it is what can be sent away.
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  // Chat collapses to a rail, not away — it is the other pane, so the two
  // can never be collapsed at once: sending the editor away first reopens
  // chat, and `chatCollapsed` below reads false while the editor is gone.
  const [chatCollapsedRaw, setChatCollapsed] = useState(false);
  const chatCollapsed = chatCollapsedRaw && !editorCollapsed;
  const toggleChat = useCallback(
    () => setChatCollapsed((collapsed) => !collapsed),
    []
  );
  const toggleEditor = useCallback(() => {
    setChatCollapsed(false);
    setEditorCollapsed((collapsed) => !collapsed);
  }, []);

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

  // Chat is a thread's page and is never closed — only sized. The saved
  // `collapsed` flag from when it could be is deliberately never read, so a
  // user who had collapsed it does not land on a thread with no way back.
  const vibeChat = useResizable({
    storageKey: `palisade:layout:${layoutHash}:vibe-chat`,
    defaultSize: 520,
    min: 380,
    max: 900,
    axis: "horizontal",
  });

  // Which threads have a tab in the chat strip. Like editor tabs: selecting
  // a thread opens one, closing removes it, and the thread itself is
  // untouched either way (History still lists every thread).
  const [openThreadIds, setOpenThreadIds] = useState<string[]>([]);
  const openThread = useCallback((id: string) => {
    setOpenThreadIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);
  const closeThread = useCallback((id: string) => {
    setOpenThreadIds((prev) => prev.filter((existing) => existing !== id));
  }, []);

  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(THEME_KEY) as Theme) || "auto"
  );

  useEffect(() => { setMantineColorScheme(theme); }, [theme, setMantineColorScheme]);

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
    defaultSize: 220,
    min: 220,
    max: 420,
    axis: "horizontal",
    // The rail and its panel are DOM-first/left-edge, but CSS `order` puts
    // them at the right edge. The resize handle sits on the panel's *inner*
    // edge, so dragging left is what grows it.
    reverse: true,
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
      activePanel,
      selectPanel,
      openPanel,
      sessionListOpen,
      sessionListUserOpened,
      toggleSessionList,
      editorCollapsed,
      toggleEditor,
      chatCollapsed,
      toggleChat,
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
      activePanel,
      selectPanel,
      openPanel,
      sessionListOpen,
      sessionListUserOpened,
      toggleSessionList,
      editorCollapsed,
      toggleEditor,
      chatCollapsed,
      toggleChat,
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
