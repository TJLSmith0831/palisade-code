import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
import { IconArchive, IconRefresh } from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";

import * as api from "./api";
import type { SpecChange } from "./api";
import { describeError } from "./errors";

type Props = {
  projectHash: string;
  /** OPE-01: an agent's proposal lands in this thread's isolated worktree,
   *  not the project root — without it, changes an agent just created are
   *  invisible here ("No changes in this project") even though they exist
   *  on disk. */
  threadId?: string | null;
  /** The change the active thread is linked to, highlighted in the list. */
  linkedChange?: string | null;
  /** Called when the user clicks a change name — opens it as a spec tab. */
  onOpenSpec?: (name: string) => void;
};

/**
 * Read-only view of a project's OpenSpec changes. Everything here comes from
 * the `openspec` CLI, which stays the authority on what a change is; this pane
 * writes nothing — not a spec file, not a line of `~/.palisade-code`.
 *
 * Task counts are shown as what they are: checkboxes an agent ticked about its
 * own work. Nothing here calls a change complete, satisfied, or implemented.
 */
export default function SpecPane({
  projectHash,
  threadId,
  linkedChange,
  onOpenSpec,
}: Props) {
  const [changes, setChanges] = useState<SpecChange[] | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Tracks `validate_spec_changes` independently so the lime dots show in the
  // badge slot while validation is in flight, separate from a list refresh.
  const [validating, setValidating] = useState(false);
  // One change name per in-flight archive call — the blue dots replace that
  // row's archive button until the CLI returns.
  const [archiving, setArchiving] = useState<Set<string>>(new Set());

  // Results are cached per project+thread — a thread with its own worktree
  // can see different changes than the project root (OPE-01), so the cache
  // key has to include it or switching threads would show stale results.
  const cacheKey = `${projectHash}:${threadId ?? ""}`;
  const cache = useRef(
    new Map<string, { changes: SpecChange[]; valid: boolean | null }>()
  );

  const load = useCallback(
    async (force: boolean) => {
      const cached = cache.current.get(cacheKey);
      if (cached && !force) {
        setChanges(cached.changes);
        setValid(cached.valid);
        return;
      }
      // The list and validation run independently — `openspec validate` spawns
      // a process and is slower than `openspec list`, so waiting on both via
      // Promise.all made the list feel sluggish. The list updates as soon as
      // it's ready; the lime dots stay up until validation finishes on its own.
      const startLoading = () => {
        setLoading(true);
        setValidating(true);
        setError(null);
      };
      if (force) flushSync(startLoading);
      else startLoading();

      // List — fast, updates the moment it's back.
      api
        .listSpecChanges(projectHash, threadId)
        .then((listed) => {
          setChanges(listed);
          cache.current.set(cacheKey, {
            changes: listed,
            valid: cache.current.get(cacheKey)?.valid ?? null,
          });
          setLoading(false);
        })
        .catch((err) => {
          setError(describeError(err));
          setLoading(false);
        });

      // Validation — slower, runs in the background. The lime dots stay up
      // until this resolves, but the list above is already updated.
      api
        .validateSpecChanges(projectHash, threadId)
        .then((isValid) => {
          setValid(isValid);
          const existing = cache.current.get(cacheKey);
          if (existing) {
            cache.current.set(cacheKey, { ...existing, valid: isValid });
          }
        })
        .catch(() => {
          setValid(null);
        })
        .finally(() => setValidating(false));
    },
    [projectHash, threadId, cacheKey]
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
          cache.current.delete(cacheKey);
          load(true);
        }
      }
    );
    return () => {
      changed.then((un) => un());
    };
  }, [projectHash, cacheKey, load]);

  const archiveChange = useCallback(
    async (name: string) => {
      flushSync(() => {
        setArchiving((prev) => new Set(prev).add(name));
      });
      try {
        await api.archiveSpecChange(projectHash, name, threadId);
        load(true);
      } catch (err) {
        setError(describeError(err));
      } finally {
        setArchiving((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    },
    [projectHash, threadId, load]
  );

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
            Changes
          </Text>
          {loading && <Loader size="xs" />}
        </Group>
        <Group gap="xs">
          {validating ? (
            <Loader
              color="warn"
              type="dots"
              size="xs"
              data-testid="validates-loader"
            />
          ) : (
            <>
              {valid === true && (
                <Tooltip label="openspec validate passed for every change" openDelay={300}>
                  <Badge size="xs" color="success" variant="light" tt="none">
                    valid
                  </Badge>
                </Tooltip>
              )}
              {valid === false && (
                <Tooltip label="openspec validate reported errors in at least one change" openDelay={300}>
                  <Badge size="xs" color="warn" variant="light" tt="none">
                    invalid
                  </Badge>
                </Tooltip>
              )}
              {valid === null && !loading && (
                <Tooltip label="`openspec` is not on PATH, so validity is unknown — not invalid.">
                  <Badge size="xs" color="neutral" variant="light">
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
            </>
          )}
        </Group>
      </Group>

      {error && (
        <Alert color="danger" variant="light">
          {error}
        </Alert>
      )}

      {changes !== null && sorted.length === 0 && !error && (
        <Text size="xs" c="dimmed">
          No changes yet. Start a thread in <b>Spec</b> mode and the change the
          agent proposes will appear here.
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
            <Text
              size="xs"
              fw={change.name === linkedChange ? 700 : 400}
              truncate
              onClick={() => onOpenSpec?.(change.name)}
              style={{ cursor: onOpenSpec ? "pointer" : undefined }}
              role={onOpenSpec ? "button" : undefined}
              tabIndex={onOpenSpec ? 0 : undefined}
              onKeyDown={(event) => {
                if (
                  onOpenSpec &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  onOpenSpec(change.name);
                }
              }}
            >
              {change.name}
            </Text>
            <Group gap="xs" wrap="nowrap">
              {archiving.has(change.name) ? (
                <Loader
                  color="neutral"
                  type="dots"
                  size="xs"
                  data-testid="archive-loader"
                />
              ) : (
                <Tooltip label="Archive change">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    onClick={(event) => {
                      event.stopPropagation();
                      archiveChange(change.name);
                    }}
                    aria-label={`Archive ${change.name}`}
                    data-testid="spec-archive"
                  >
                    <IconArchive size={14} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>
          </Group>
          {change.totalTasks > 0 && (
            <Tooltip
              label={`${change.completedTasks} of ${change.totalTasks} task checkboxes ticked by the agent — a self-report, not verification.`}
              multiline
            >
              <div>
                <Progress
                  size="xs"
                  color="neutral"
                  value={(change.completedTasks / change.totalTasks) * 100}
                />
                <Stack gap={2} mt={2} align="flex-start">
                  {change.status && (
                    // openspec's own word, attributed. `complete` here means
                    // every task checkbox is ticked — an agent's self-report,
                    // not evidence that anything runs. Kept off the name row
                    // so neither the name nor the word gets truncated.
                    <Tooltip
                      label={`openspec reports this change as "${change.status}", derived from task checkboxes. Only a verify command's exit code shows whether the work runs.`}
                      multiline
                    >
                      <Badge size="xs" variant="light" color="neutral" tt="none">
                        openspec: {change.status}
                      </Badge>
                    </Tooltip>
                  )}
                  <Text size="10px" c="dimmed">
                    {change.completedTasks}/{change.totalTasks} tasks ticked (agent-reported)
                  </Text>
                </Stack>
              </div>
            </Tooltip>
          )}
        </Stack>
      ))}
    </Stack>
  );
}
