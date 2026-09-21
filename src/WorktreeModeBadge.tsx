import { Button, Tooltip } from "@mantine/core";
import { IconFolderOpen, IconGitBranch } from "@tabler/icons-react";

/** The Isolated / Project root badge, shared by the thread composer and the
 *  Fleet new-run row so the two read as one control. */
export default function WorktreeModeBadge({
  isolated,
  tooltip,
  locked = false,
  onClick,
  "data-testid": testId,
}: {
  isolated: boolean;
  tooltip: string;
  /** Dimmed and inert, but not `disabled`: a disabled control swallows the
   *  hover too, and the tooltip explaining *why* is what makes it legible. */
  locked?: boolean;
  onClick?: () => void;
  "data-testid"?: string;
}) {
  return (
    <Tooltip label={tooltip} openDelay={300} multiline w={240}>
      <Button
        size="compact-xs"
        variant="light"
        color={isolated ? "success" : "warn"}
        data-testid={testId}
        data-locked={locked ? "true" : undefined}
        aria-label="Isolated worktree"
        aria-pressed={isolated}
        aria-disabled={locked || !onClick}
        style={locked ? { opacity: 0.45, cursor: "default" } : undefined}
        onClick={() => {
          if (!locked) onClick?.();
        }}
        leftSection={isolated ? <IconGitBranch size={14} /> : <IconFolderOpen size={14} />}
      >
        {isolated ? "Isolated" : "Project root"}
      </Button>
    </Tooltip>
  );
}
