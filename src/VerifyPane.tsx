import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconPlayerPlay } from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";

import * as api from "./api";
import type { VerificationRun } from "./api";
import { describeError } from "./errors";

type Props = {
  projectHash: string;
  threadId?: string | null;
};

const shortCommit = (head: string | null) =>
  head ? head.slice(0, 7) + (head.endsWith("-dirty") ? "-dirty" : "") : "no commit";

/**
 * What has actually been verified, and nothing more.
 *
 * Every row is one command, its exit code, and the commit it ran at. There is
 * deliberately no aggregate here — no "3/3 passing", no green tick for the
 * project, no "spec complete". A set of exit codes is not a claim that the
 * work is done, and rolling them into one would manufacture exactly the
 * certainty this pane exists to avoid.
 */
export default function VerifyPane({ projectHash, threadId }: Props) {
  const [commands, setCommands] = useState<[string, string][]>([]);
  const [runs, setRuns] = useState<VerificationRun[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [configured, history] = await Promise.all([
        api.verifyCommands(projectHash),
        api.listVerifications(projectHash),
      ]);
      setCommands(configured);
      setRuns(history);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [projectHash]);

  useEffect(() => {
    load();
  }, [load]);

  // A verify command runs detached — a real suite takes minutes — so its
  // result arrives as an event rather than as the call's return value.
  useEffect(() => {
    const finished = listen<VerificationRun>(
      "verification-finished",
      ({ payload }) => {
        if (payload.projectHash !== projectHash) return;
        setRuns((previous) => [...previous, payload]);
        setRunning((previous) => {
          const next = new Set(previous);
          next.delete(payload.name);
          return next;
        });
      }
    );
    return () => {
      finished.then((un) => un());
    };
  }, [projectHash]);

  const run = (name: string) => {
    setRunning((previous) => new Set(previous).add(name));
    api.runVerify(projectHash, name, threadId).catch((err) => {
      setError(describeError(err));
      setRunning((previous) => {
        const next = new Set(previous);
        next.delete(name);
        return next;
      });
    });
  };

  // Newest first — the last run of a command is the one that still means
  // something; the earlier ones are history, not a score.
  const latest = [...runs].reverse();

  /**
   * Every run ever recorded used to render, each as a Code block carrying an
   * output tail, with no windowing anywhere in the app to fall back on. A cap
   * is enough here and costs no dependency: the rows this pane exists for are
   * the newest ones, and the older ones are reachable in one click.
   */
  const PAGE = 20;
  const shown = showAll ? latest : latest.slice(0, PAGE);
  const older = latest.length - shown.length;

  return (
    <Stack gap="xs" p="xs">
      {loading && (
        <Group justify="flex-end">
          <Loader size="xs" />
        </Group>
      )}

      {error && (
        <Alert color="danger" variant="light">
          {error}
        </Alert>
      )}

      {!loading && commands.length === 0 && (
        <Text size="xs" c="dimmed">
          No verify commands configured. Add a <Code>verify</Code> map to{" "}
          <Code>.palisade/project-settings.json</Code>.
        </Text>
      )}

      <Group gap="xs">
        {commands.map(([name, command]) => (
          <Tooltip key={name} label={command}>
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<IconPlayerPlay size={12} />}
              loading={running.has(name)}
              onClick={() => run(name)}
              data-testid={`verify-run-${name}`}
            >
              {name}
            </Button>
          </Tooltip>
        ))}
      </Group>

      {/* This pane's whole purpose is stating what evidence exists, and with
          no runs recorded it used to show buttons and blank space — the one
          surface where "nothing here" is itself the finding, left unsaid. */}
      {!loading && commands.length > 0 && latest.length === 0 && (
        <Stack gap={4} py="sm" data-testid="verify-empty">
          <Text size="sm" fw={600}>
            Nothing verified yet
          </Text>
          <Text size="xs" c="dimmed">
            A command is green here because it exited <Code>0</Code> at a named
            commit — never because an agent reported it finished. Until one of
            these has run, there is no evidence either way.
          </Text>
          <Text size="xs" c="dimmed">
            Run{" "}
            <Code>{commands[0][0]}</Code> above to record the first.
          </Text>
        </Stack>
      )}

      {shown.map((entry) => (
        <Stack key={entry.id} gap={2} data-testid="verification-run">
          <Group gap="xs" wrap="nowrap">
            <Badge
              size="xs"
              color={entry.exitCode === 0 ? "success" : "danger"}
              variant="light"
            >
              exit {entry.exitCode}
            </Badge>
            <Text size="xs" truncate>
              {entry.name}
            </Text>
            <Tooltip label={entry.gitHead ?? "not a git repository"}>
              <Code fz="10px">{shortCommit(entry.gitHead)}</Code>
            </Tooltip>
          </Group>
          <Code block fz="10px" style={{ maxHeight: 120, overflow: "auto" }}>
            {entry.command}
            {"\n"}
            {entry.outputTail.trim() || "(no output)"}
          </Code>
        </Stack>
      ))}

      {older > 0 && (
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => setShowAll(true)}
          data-testid="verify-show-older"
        >
          Show {older} older run{older === 1 ? "" : "s"}
        </Button>
      )}
    </Stack>
  );
}
