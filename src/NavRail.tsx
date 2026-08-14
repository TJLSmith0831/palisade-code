import { Tooltip } from "@mantine/core";
import {
  IconFolder,
  IconSearch,
  IconGitBranch,
  IconClipboardList,
  IconTopologyStar3,
  IconPlayerPlay,
  IconHistory,
  IconUser,
  IconSettings,
} from "@tabler/icons-react";
import type { PanelId } from "./hooks/useAppShell";

// The left icon rail (Amendment 3). Mounted ONCE and shared by both presets —
// CSS `order` moves it to the right edge in Vibe rather than a second copy
// (Governing Rule: same panel inventory, different arrangement). Icons are
// Tabler, buttons are the shell's own `ds-icon-btn` family per DESIGN.md.

type RailItem = {
  id: PanelId;
  label: string;
  Icon: typeof IconFolder;
};

const TOP: RailItem[] = [
  { id: "explorer", label: "Explorer", Icon: IconFolder },
  { id: "search", label: "Search", Icon: IconSearch },
  { id: "git", label: "Source Control", Icon: IconGitBranch },
  { id: "specs", label: "Specs", Icon: IconClipboardList },
  { id: "codemap", label: "Codebase Map", Icon: IconTopologyStar3 },
  { id: "run", label: "Run configurations", Icon: IconPlayerPlay },
];

const BOTTOM: RailItem[] = [
  { id: "history", label: "History", Icon: IconHistory },
  { id: "account", label: "Account", Icon: IconUser },
  { id: "settings", label: "Settings", Icon: IconSettings },
];

export default function NavRail({
  activePanel,
  onSelect,
  dirtyGit,
}: {
  activePanel: PanelId | null;
  onSelect: (id: PanelId) => void;
  /** Uncommitted-changes indicator on the Source Control icon. */
  dirtyGit?: boolean;
}) {
  const button = ({ id, label, Icon }: RailItem) => {
    const active = activePanel === id;
    return (
      <Tooltip key={id} label={label} position="right" withinPortal>
        <button
          className={`ds-rail-btn${active ? " active" : ""}`}
          onClick={() => onSelect(id)}
          aria-label={label}
          aria-pressed={active}
          data-testid={`rail-${id}`}
        >
          <Icon size={18} stroke={1.6} />
          {id === "git" && dirtyGit && <span className="ds-rail-dot" />}
        </button>
      </Tooltip>
    );
  };

  return (
    <nav className="ds-rail" data-testid="nav-rail" aria-label="Panels">
      <div className="ds-rail-group">{TOP.map(button)}</div>
      <div className="ds-rail-spacer" />
      <div className="ds-rail-group">{BOTTOM.map(button)}</div>
    </nav>
  );
}
