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
  /** Called when the user clicks a change name — opens it as a spec tab. */
  onOpenSpec: (specName: string) => void;
};

/**
 * Compact Specs launcher for the Vibe right sidebar (D2). Lists the project's
 * OpenSpec changes with status and a mini progress bar, and opens a change
 * as a spec tab on click. Reuses the same `openspec` CLI data and caching
 * pattern as `SpecPane` — per-project, invalidated on `fs-changed` events
 * under `openspec/`.
 */
export default function VibeSpecLauncher({ projectHash, linkedChange, onOpenSpec }: Props) {
  const [changes, setChanges] = useState<SpecChange[] | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    <Stack gap={4} p="xs" data-testid="vibe-spec-launcher">
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs">
          <Text size="xs" fw={600}>Specs</Text>
          {loading && <Loader size="xs" />}
        </Group>
        <Group gap="xs">
          {valid === true && (
            <Badge size="xs" color="green" variant="light">validates</Badge>
          )}
          {valid === false && (
            <Badge size="xs" color="orange" variant="light">failed</Badge>
          )}
          <Tooltip label="Re-read from openspec CLI">
            <ActionIcon
              size="xs"
              variant="subtle"
              onClick={() => load(true)}
              aria-label="Refresh spec changes"
              data-testid="vibe-spec-refresh"
            >
              <IconRefresh size={12} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light" p="xs">
          <Text size="xs">{error}</Text>
        </Alert>
      )}

      {changes !== null && sorted.length === 0 && !error && (
        <Text size="xs" c="dimmed">No OpenSpec changes.</Text>
      )}

      {sorted.map((change) => (
        <Group
          key={change.name}
          gap="xs"
          wrap="nowrap"
          role="button"
          tabIndex={0}
          onClick={() => onOpenSpec(change.name)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpenSpec(change.name);
            }
          }}
          style={{ cursor: "pointer" }}
          data-testid="vibe-spec-row"
          data-spec-name={change.name}
          data-linked={change.name === linkedChange ? "true" : undefined}
        >
          <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
            <Text
              size="xs"
              fw={change.name === linkedChange ? 700 : 400}
              truncate
            >
              {change.name}
            </Text>
            {change.totalTasks > 0 && (
              <Group gap="xs" wrap="nowrap">
                <Progress
                  size="xs"
                  style={{ flex: 1 }}
                  value={(change.completedTasks / change.totalTasks) * 100}
                />
                <Text size="10px" c="dimmed" style={{ flexShrink: 0 }}>
                  {change.completedTasks}/{change.totalTasks}
                </Text>
              </Group>
            )}
          </Stack>
          {change.status && (
            <Tooltip
              label={`openspec: "${change.status}" — agent self-report, not verification`}
              multiline
            >
              <Badge size="xs" variant="light">{change.status}</Badge>
            </Tooltip>
          )}
        </Group>
      ))}
    </Stack>
  );
}
