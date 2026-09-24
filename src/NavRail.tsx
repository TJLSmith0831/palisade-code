import { ActionIcon, Tooltip } from "@mantine/core";
import {
  IconFolder,
  IconSearch,
  IconGitBranch,
  IconDeviceWorkstation,
  IconListCheck,
  IconPlayerPlay,
  IconPlug,
  IconDatabase,
  IconRoute,
  IconHistory,
  IconAiAgents,
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

// Three groups, split by how often you reach for them: the run loop (define,
// run, check), the code (files, search, git), then setup you configure once.
// The ADE's own question — "what are my runs doing" — is answered by the
// first icon, and files are the fourth, not the sixth.
const TOP_AGENT: RailItem[] = [
  { id: "fleet", label: "Fleet", Icon: IconAiAgents },
  { id: "specs", label: "Specs", Icon: IconListCheck },
  { id: "review", label: "Review", Icon: IconChecklist },
];

const TOP_CODE: RailItem[] = [
  { id: "explorer", label: "Explorer", Icon: IconFolder },
  { id: "search", label: "Search", Icon: IconSearch },
  { id: "git", label: "Source Control", Icon: IconGitBranch },
];

const TOP_SETUP: RailItem[] = [
  { id: "chains", label: "Playbooks", Icon: IconRoute },
  { id: "mcp", label: "Connections", Icon: IconPlug },
  { id: "run", label: "Run configurations", Icon: IconPlayerPlay },
  { id: "database", label: "Database", Icon: IconDatabase },
  // Kept: the Fleet board's project column labels a row, it can't add,
  // rename or switch a project — this is the only place that can.
  { id: "workspace", label: "Workspace", Icon: IconDeviceWorkstation },
];

const BOTTOM: RailItem[] = [
  { id: "history", label: "History", Icon: IconHistory },
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
      <div className="ds-rail-group">{TOP_CODE.map(button)}</div>
      <div className="ds-rail-divider" role="separator" />
      <div className="ds-rail-group">{TOP_SETUP.map(button)}</div>
      <div className="ds-rail-spacer" />
      <div className="ds-rail-group">{BOTTOM.map(button)}</div>
    </nav>
  );
}
