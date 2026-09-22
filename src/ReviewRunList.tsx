import { Badge, Button, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconBox, IconChevronRight, IconLayoutGrid } from "@tabler/icons-react";
import type { FleetRow } from "./api";
import { VerifyBadge } from "./fleetBadges";

export type ReviewRunListProps = {
  runs: FleetRow[];
  onSelect: (id: string) => void;
  onGoToFleet: () => void;
};

const STATUS_LABEL: Record<FleetRow["status"], string> = {
  attention: "Needs attention",
  running: "Running",
  unreviewed: "Unreviewed",
  idle: "Idle",
};
export const STATUS_COLOR: Record<FleetRow["status"], string> = {
  attention: "danger",
  running: "success",
  unreviewed: "warn",
  idle: "neutral",
};

/** The Review rail's landing list: every thread that can be reviewed, so
 *  opening the rail is never a dead end. Reuses the Fleet board's own rows
 *  and its diff measurement — this list is a different view of the same
 *  data, not a second source of it. */
export function ReviewRunList({ runs, onSelect, onGoToFleet }: ReviewRunListProps) {
  if (runs.length === 0) {
    return (
      <Stack gap="xs" align="flex-start" data-testid="review-run-list-empty" p="md">
        <Text size="sm" fw={600}>Nothing to review yet</Text>
        <Text size="sm" c="dimmed">
          Review is where a thread&apos;s changes get read file by file, verified, and merged.
        </Text>
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconLayoutGrid size={14} />}
          onClick={onGoToFleet}
        >
          Go to Fleet board
        </Button>
      </Stack>
    );
  }

  return (
    <div className="review-run-list" data-testid="review-run-list">
      <div className="review-run-list-head">
        <Text size="sm" fw={600}>Review</Text>
        <Text size="xs" c="dimmed">
          {runs.length} {runs.length === 1 ? "thread" : "threads"}
        </Text>
      </div>
      {runs.map((row) => (
        <UnstyledButton
          key={row.threadId}
          className="fleet-row review-run-row"
          data-testid="review-run-row"
          onClick={() => onSelect(row.threadId)}
        >
          <span className="fleet-agent" aria-hidden>
            <IconBox size={14} />
          </span>
          <span className="fleet-row-main">
            <span className="fleet-row-title">{row.title}</span>
            <span className="fleet-row-meta">
              <span>
                {row.agentName ?? row.agentId ?? "No agent"}
                {row.branch ? ` · ${row.branch}` : ""}
              </span>
              <span className="fleet-diff" data-testid="review-run-diff">
                <span className="added">+{row.diff.added}</span>{" "}
                <span className="removed">−{row.diff.removed}</span> · {row.diff.files} files
              </span>
            </span>
          </span>
          <span className="fleet-row-badges">
            <VerifyBadge verify={row.verify} />
            <Badge size="xs" radius="sm" variant="light" color={STATUS_COLOR[row.status]}>
              {STATUS_LABEL[row.status]}
            </Badge>
          </span>
          <IconChevronRight size={14} className="review-run-chevron" aria-hidden />
        </UnstyledButton>
      ))}
    </div>
  );
}

export default ReviewRunList;
