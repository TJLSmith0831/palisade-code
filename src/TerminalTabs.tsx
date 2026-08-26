import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import TerminalPane from "./TerminalPane";
import * as api from "./api";

/** Mirrors `terminal::MAX_TERMINALS_PER_PROJECT`. The backend is the real
 *  gate; this only stops the "+" from offering a tab that would be refused. */
export const MAX_TERMINAL_TABS = 8;

type Tab = { id: string; label: string };

/**
 * The terminal tab strip: several shells per project, all live at once.
 *
 * Panes stay mounted while hidden — a tab is a running process, and
 * unmounting would dispose its xterm view mid-build. The PTY itself outlives
 * even that: only an explicit close (or a project switch) kills a shell.
 */
export default function TerminalTabs({
  projectHash,
  onActiveTerminalChange,
}: {
  projectHash: string;
  /** Which tab the "Run" shortcut should type into. */
  onActiveTerminalChange?: (terminalId: string) => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // Monotonic per project, so a closed-then-reopened tab never reuses an id
  // the backend still has a dying shell under.
  const nextIndex = useRef(1);

  // A project switch is a different set of shells. The old project's tabs
  // have no surface left to render into, so close them rather than leaking
  // shells that nothing can reach.
  const previousProject = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousProject.current;
    previousProject.current = projectHash;
    if (previous && previous !== projectHash) {
      api.terminalKillProject(previous).catch(() => {});
    }
    nextIndex.current = 1;
    const first = { id: `${projectHash}:1`, label: "1" };
    nextIndex.current = 2;
    setTabs([first]);
    setActive(first.id);
  }, [projectHash]);

  const addTab = useCallback(() => {
    // The index is allocated and the tab built out here, not inside the
    // `setTabs` updater. React double-invokes updaters in development, so a
    // `nextIndex.current++` in there burned two numbers per click: the strip
    // read "Terminal 1, 2, 4", and the skipped id was the one the backend
    // had no PTY under. State updaters must be pure.
    if (tabs.length >= MAX_TERMINAL_TABS) return;
    const index = nextIndex.current++;
    const tab = { id: `${projectHash}:${index}`, label: String(index) };
    setTabs((previous) =>
      previous.length >= MAX_TERMINAL_TABS ? previous : [...previous, tab]
    );
    setActive(tab.id);
  }, [projectHash, tabs.length]);

  const closeTab = useCallback(
    (id: string) => {
      // The strip always keeps one shell; "close the last terminal" is
      // "collapse the panel", which is the panel's own control.
      if (tabs.length <= 1) return;
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return;
      const next = tabs.filter((tab) => tab.id !== id);
      setTabs(next);
      // Focus moves to the neighbour, computed out here for the same reason
      // `addTab` allocates out here: nothing impure inside an updater.
      setActive((current) =>
        current === id ? next[Math.min(index, next.length - 1)].id : current
      );
      api.terminalKill(id).catch(() => {});
    },
    [tabs]
  );

  // Through a ref so a caller that re-renders (App does, constantly) can't
  // re-fire this effect and re-announce a tab that never changed.
  const onActiveRef = useRef(onActiveTerminalChange);
  onActiveRef.current = onActiveTerminalChange;
  useEffect(() => {
    if (active) onActiveRef.current?.(active);
  }, [active]);

  const atLimit = tabs.length >= MAX_TERMINAL_TABS;

  return (
    <div className="ds-terminal-tabs" data-testid="terminal-tabs">
      <div className="ds-terminal-tabstrip" role="tablist">
        {tabs.map((tab) => (
          <div key={tab.id} className="ds-terminal-tabitem">
            <button
              type="button"
              role="tab"
              aria-selected={active === tab.id}
              className={`ds-terminal-tab${active === tab.id ? " is-active" : ""}`}
              onClick={() => setActive(tab.id)}
              data-testid={`terminal-tab-${tab.label}`}
            >
              {`Terminal ${tab.label}`}
            </button>
            {tabs.length > 1 && (
              <ActionIcon
                variant="subtle"
                size="xs"
                aria-label={`Close terminal ${tab.label}`}
                onClick={() => closeTab(tab.id)}
                data-testid={`terminal-close-${tab.label}`}
              >
                <IconX size={11} />
              </ActionIcon>
            )}
          </div>
        ))}
        <Tooltip
          label={atLimit ? `At the limit of ${MAX_TERMINAL_TABS} terminals` : "New terminal"}
          withinPortal
        >
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="New terminal"
            disabled={atLimit}
            onClick={addTab}
            data-testid="terminal-tab-new"
          >
            <IconPlus size={13} />
          </ActionIcon>
        </Tooltip>
      </div>
      <div className="ds-terminal-tabbody">
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            projectHash={projectHash}
            terminalId={tab.id}
            visible={active === tab.id}
          />
        ))}
      </div>
    </div>
  );
}
