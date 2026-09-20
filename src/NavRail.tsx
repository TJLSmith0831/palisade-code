import { ActionIcon, Tooltip } from "@mantine/core";
import {
  IconFolder,
  IconSearch,
  IconGitBranch,
  IconDeviceWorkstation,
  IconClipboardList,
  IconPlayerPlay,
  IconPlug,
  IconDatabase,
  IconRoute,
  IconHistory,
  IconSettings,
  IconLayoutGrid,
  IconChecklist,
} from "@tabler/icons-react";
import type { PanelId } from "./hooks/useAppShell";

// The icon rail (Amendment 3). Mounted once; CSS `order` puts it at the
// right edge of the shell. Icons are Tabler, buttons are the shell's own
// `ds-icon-btn` family per DESIGN.md.

type RailItem = {
  id: PanelId;
  label: string;
  Icon: typeof IconFolder;
};

// Split by what the icon is for, not just visual balance: the agent
// surfaces this app exists for come first (the fleet, its review, the
// playbooks and connections that shape a run, the specs it works from),
// then the workbench any IDE has. The ADE's own question — "what are my
// runs doing" — is answered by the first icon, not the fifth.
const TOP_AGENT: RailItem[] = [
  { id: "fleet", label: "Fleet", Icon: IconLayoutGrid },
  { id: "review", label: "Review", Icon: IconChecklist },
  { id: "chains", label: "Playbooks", Icon: IconRoute },
  { id: "mcp", label: "Connections", Icon: IconPlug },
  { id: "specs", label: "Specs", Icon: IconClipboardList },
];

const TOP_NAV: RailItem[] = [
  { id: "explorer", label: "Explorer", Icon: IconFolder },
  { id: "search", label: "Search", Icon: IconSearch },
  { id: "git", label: "Source Control", Icon: IconGitBranch },
  { id: "run", label: "Run configurations", Icon: IconPlayerPlay },
  { id: "database", label: "Database", Icon: IconDatabase },
  // Kept: the Fleet board's project column labels a row, it can't add,
  // rename or switch a project — this is the only place that can.
  { id: "workspace", label: "Workspace", Icon: IconDeviceWorkstation },
];

const BOTTOM: RailItem[] = [
  { id: "history", label: "History", Icon: IconHistory },
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
        <ActionIcon
          variant="subtle"
          className={`ds-rail-btn${active ? " active" : ""}`}
          onClick={() => onSelect(id)}
          aria-label={label}
          aria-pressed={active}
          data-testid={`rail-${id}`}
        >
          <Icon size={18} stroke={1.6} />
          {id === "git" && dirtyGit && <span className="ds-rail-dot" />}
        </ActionIcon>
      </Tooltip>
    );
  };

  return (
    <nav className="ds-rail" data-testid="nav-rail" aria-label="Panels">
      <div className="ds-rail-group">{TOP_AGENT.map(button)}</div>
      <div className="ds-rail-divider" role="separator" />
      <div className="ds-rail-group">{TOP_NAV.map(button)}</div>
      <div className="ds-rail-spacer" />
      <div className="ds-rail-group">{BOTTOM.map(button)}</div>
    </nav>
  );
}
