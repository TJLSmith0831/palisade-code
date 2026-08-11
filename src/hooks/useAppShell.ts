import { useCallback, useMemo, useRef, useState } from "react";
import { useMantineColorScheme } from "@mantine/core";
import { useResizable } from "../useResizable";

export const THEME_KEY = "floo:theme";
export const TERMINAL_PLACEMENT_KEY = "floo:terminalPlacement";

export type TerminalPlacement = "bottom" | "sidebar";
export type Theme = "auto" | "light" | "dark";

export const nextTheme = (t: Theme): Theme =>
  t === "auto" ? "light" : t === "light" ? "dark" : "auto";

type RightTab = "threads" | "codemap" | "specs" | "verify" | "terminal";

export function useAppShell(projectHash: string | undefined) {
  const layoutHash = projectHash ?? "default";
  const { setColorScheme: setMantineColorScheme } = useMantineColorScheme();

  const [diffOpen, setDiffOpen] = useState(false);
  const [editorRailOpen, setEditorRailOpen] = useState(false);
  const [vibeExplorerOpen, setVibeExplorerOpen] = useState(false);

  const [centerShell, setCenterShellState] = useState<"vibe" | "editor">(
    "editor"
  );
  const shellChosenRef = useRef(false);
  const setCenterShell = useCallback((shell: "vibe" | "editor") => {
    shellChosenRef.current = true;
    setCenterShellState(shell);
  }, []);

  const [rightTab, setRightTab] = useState<RightTab>("threads");
  const [terminalPlacement, setTerminalPlacement] = useState<TerminalPlacement>(
    () =>
      (localStorage.getItem(TERMINAL_PLACEMENT_KEY) as TerminalPlacement) ||
      "bottom"
  );

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
    storageKey: `floo:layout:${layoutHash}:left`,
    defaultSize: 193,
    min: 160,
    max: 420,
    axis: "horizontal",
  });
  const rightPanel = useResizable({
    storageKey: `floo:layout:${layoutHash}:right`,
    defaultSize: 300,
    min: 260,
    max: 820,
    axis: "horizontal",
    reverse: true,
    defaultCollapsed: false,
  });
  const terminalPanel = useResizable({
    storageKey: `floo:layout:${layoutHash}:terminal`,
    defaultSize: 220,
    min: 120,
    max: 560,
    axis: "vertical",
    reverse: true,
    defaultCollapsed: true,
  });
  const vibeChat = useResizable({
    storageKey: `floo:layout:${layoutHash}:vibe-chat`,
    defaultSize: 520,
    min: 380,
    max: 900,
    axis: "horizontal",
  });

  const toggleTerminalPlacement = useCallback(() => {
    setTerminalPlacement((prev) => {
      const next = prev === "bottom" ? "sidebar" : "bottom";
      localStorage.setItem(TERMINAL_PLACEMENT_KEY, next);
      if (next === "sidebar") {
        setRightTab("terminal");
        rightPanel.setCollapsed(false);
      } else {
        setRightTab((tab) => (tab === "terminal" ? "threads" : tab));
        terminalPanel.setCollapsed(false);
      }
      return next;
    });
  }, [rightPanel.setCollapsed, terminalPanel.setCollapsed]);

  const toggleTerminal = useCallback(() => {
    if (terminalPlacement === "sidebar") {
      setRightTab("terminal");
      rightPanel.setCollapsed(false);
    } else {
      terminalPanel.toggleCollapsed();
    }
  }, [
    terminalPlacement,
    rightPanel.setCollapsed,
    terminalPanel.toggleCollapsed,
  ]);

  return useMemo(
    () => ({
      diffOpen,
      setDiffOpen,
      editorRailOpen,
      setEditorRailOpen,
      vibeExplorerOpen,
      setVibeExplorerOpen,
      centerShell,
      setCenterShell,
      shellChosenRef,
      rightTab,
      setRightTab,
      terminalPlacement,
      setTerminalPlacement,
      toggleTerminalPlacement,
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
      editorRailOpen,
      vibeExplorerOpen,
      centerShell,
      rightTab,
      terminalPlacement,
      theme,
      toggleTerminalPlacement,
      toggleTerminal,
      leftRail,
      rightPanel,
      terminalPanel,
      vibeChat,
    ]
  );
}

export type AppShell = ReturnType<typeof useAppShell>;
