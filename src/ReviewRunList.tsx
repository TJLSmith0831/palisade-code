import { Badge, Button, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconLayoutGrid } from "@tabler/icons-react";
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
  idle: "Idle",
};
export const STATUS_COLOR: Record<FleetRow["status"], string> = {
  attention: "warn",
  running: "success",
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
    <Stack gap={2} data-testid="review-run-list" p="xs">
      {runs.map((row) => (
        <UnstyledButton
          key={row.threadId}
          data-testid="review-run-row"
          onClick={() => onSelect(row.threadId)}
          p="xs"
          style={{ borderRadius: 6 }}
        >
          <Group justify="space-between" gap="sm" wrap="nowrap">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" fw={500} truncate>{row.title}</Text>
              <Text size="xs" c="dimmed" truncate>
                {row.agentName ?? row.agentId ?? "No agent"}
                {row.branch ? ` · ${row.branch}` : ""}
              </Text>
            </Stack>
            <Group gap="xs" wrap="nowrap">
              <Text size="xs" c="dimmed" data-testid="review-run-diff">
                <span>+{row.diff.added}</span> <span>−{row.diff.removed}</span> ·{" "}
                {row.diff.files} files
              </Text>
              <VerifyBadge verify={row.verify} />
              <Badge size="xs" radius="sm" variant="light" color={STATUS_COLOR[row.status]}>
                {STATUS_LABEL[row.status]}
              </Badge>
            </Group>
          </Group>
        </UnstyledButton>
      ))}
    </Stack>
  );
}

export default ReviewRunList;
