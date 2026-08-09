import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Group,
  Loader,
  Progress,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";

import * as api from "./api";
import type { SpecChange } from "./api";
import { describeError } from "./errors";

type Props = {
  projectHash: string;
  /** The change the active thread is linked to, highlighted in the list. */
  linkedChange?: string | null;
};

/**
 * Read-only view of a project's OpenSpec changes. Everything here comes from
 * the `openspec` CLI, which stays the authority on what a change is; this pane
 * writes nothing — not a spec file, not a line of `~/.floo-network`.
 *
 * Task counts are shown as what they are: checkboxes an agent ticked about its
 * own work. Nothing here calls a change complete, satisfied, or implemented.
 */
export default function SpecPane({ projectHash, linkedChange }: Props) {
  const [changes, setChanges] = useState<SpecChange[] | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Results are cached per project — the CLI is a process spawn, not a cheap
  // read, so it is asked on project switch, on the filesystem event, or when
  // the user asks. Never on every render.
  const cache = useRef(new Map<string, { changes: SpecChange[]; valid: boolean | null }>());

  const load = useCallback(
    async (force: boolean) => {
      const cached = cache.current.get(projectHash);
      if (cached && !force) {
        setChanges(cached.changes);
        setValid(cached.valid);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const [listed, isValid] = await Promise.all([
          api.listSpecChanges(projectHash),
          api.validateSpecChanges(projectHash),
        ]);
        cache.current.set(projectHash, { changes: listed, valid: isValid });
        setChanges(listed);
        setValid(isValid);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setLoading(false);
      }
    },
    [projectHash]
  );

  useEffect(() => {
    load(false);
  }, [load]);

  // Spec files live in the project, so the same filesystem signal that keeps
  // the tree honest is what invalidates this.
  useEffect(() => {
    const changed = listen<{ projectHash: string; paths: string[] }>(
      "fs-changed",
      ({ payload }) => {
        if (payload.projectHash !== projectHash) return;
        if (payload.paths.some((path) => path.includes("openspec/"))) {
          cache.current.delete(projectHash);
          load(true);
        }
      }
    );
    return () => {
      changed.then((un) => un());
    };
  }, [projectHash, load]);

  const sorted = useMemo(
    () =>
      [...(changes ?? [])].sort((a, b) =>
        (b.lastModified ?? "").localeCompare(a.lastModified ?? "")
      ),
    [changes]
  );

  return (
    <Stack gap="xs" p="xs">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs">
          <Text size="sm" fw={600}>
            OpenSpec changes
          </Text>
          {loading && <Loader size="xs" />}
        </Group>
        <Group gap="xs">
          {valid === true && (
            <Badge size="xs" color="green" variant="light">
              validates
            </Badge>
          )}
          {valid === false && (
            <Badge size="xs" color="orange" variant="light">
              validation failed
            </Badge>
          )}
          {valid === null && !loading && (
            <Tooltip label="`openspec` is not on PATH, so validity is unknown — not invalid.">
              <Badge size="xs" color="gray" variant="light">
                unknown
              </Badge>
            </Tooltip>
          )}
          <Tooltip label="Re-read from the openspec CLI">
            <ActionIcon
              size="sm"
              variant="subtle"
              onClick={() => load(true)}
              aria-label="Refresh spec changes"
              data-testid="spec-refresh"
            >
              <IconRefresh size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {changes !== null && sorted.length === 0 && !error && (
        <Text size="xs" c="dimmed">
          No OpenSpec changes in this project.
        </Text>
      )}

      {sorted.map((change) => (
        <Stack
          key={change.name}
          gap={4}
          data-testid="spec-change"
          data-linked={change.name === linkedChange ? "true" : undefined}
        >
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Text size="xs" fw={change.name === linkedChange ? 700 : 400} truncate>
              {change.name}
            </Text>
            {change.status && (
              // Rendered as openspec's own word, attributed. `complete` here
              // means every task checkbox is ticked — an agent's self-report
              // about its own work, not evidence that anything runs.
              <Tooltip
                label={`openspec reports this change as "${change.status}", derived from task checkboxes. Only a verify command's exit code shows whether the work runs.`}
                multiline
              >
                <Badge size="xs" variant="light">
                  openspec: {change.status}
                </Badge>
              </Tooltip>
            )}
          </Group>
          {change.totalTasks > 0 && (
            <Tooltip
              label={`${change.completedTasks} of ${change.totalTasks} task checkboxes ticked by the agent — a self-report, not verification.`}
              multiline
            >
              <div>
                <Progress
                  size="xs"
                  value={(change.completedTasks / change.totalTasks) * 100}
                />
                <Text size="10px" c="dimmed">
                  {change.completedTasks}/{change.totalTasks} tasks ticked
                  (agent-reported)
                </Text>
              </div>
            </Tooltip>
          )}
        </Stack>
      ))}
    </Stack>
  );
}
