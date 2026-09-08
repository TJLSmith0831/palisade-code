import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { IconPlayerPlay } from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";

import * as api from "./api";
import type { TestStatus, VerificationRun } from "./api";
import { describeError } from "./errors";

type Props = {
  projectHash: string;
  threadId?: string | null;
  /** Jump to a failing line. */
  onOpen?: (path: string, line: number) => void;
  /** When the project was last written to, so results known to predate the
   *  current code can say so. */
  lastEditAt?: number | null;
};

const STATUS_COLOR: Record<TestStatus, string> = {
  passed: "green",
  failed: "red",
  errored: "orange",
  skipped: "gray",
};

const STATUS_MARK: Record<TestStatus, string> = {
  passed: "✓",
  failed: "×",
  errored: "!",
  skipped: "–",
};

/**
 * Per-test results for one verify command.
 *
 * Deliberately a *reader* of verify runs rather than a second way to run
 * things: the evidence is still "this named command exited N at this commit"
 * (D3), and this pane only puts structure on the output that run produced.
 * It counts passes and failures; it never rolls them into a verdict about
 * the project, and it never hides a red exit code behind green rows.
 */
export default function TestExplorer({ projectHash, threadId, onOpen, lastEditAt }: Props) {
  const [commands, setCommands] = useState<[string, string][]>([]);
  const [runs, setRuns] = useState<VerificationRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([api.verifyCommands(projectHash), api.listVerifications(projectHash)])
      .then(([configured, history]) => {
        if (cancelled) return;
        setCommands(configured);
        setRuns(history);
        setError(null);
      })
      .catch((err) => !cancelled && setError(describeError(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectHash]);

  useEffect(() => {
    const finished = listen<VerificationRun>("verification-finished", ({ payload }) => {
      if (payload.projectHash !== projectHash) return;
      setRuns((previous) => [...previous, payload]);
      setRunning(false);
      // A run just happened, so a verify command definitely exists. The list
      // is read once on mount, and this panel stays mounted across tab
      // switches — so a command added to project-settings.json after that
      // read left the body claiming "No verify commands configured" while
      // the tab badge counted its failures. Re-read it here.
      api
        .verifyCommands(projectHash)
        .then((configured) => setCommands(configured))
        .catch(() => {});
    });
    return () => {
      finished.then((un) => un());
    };
  }, [projectHash]);

  // Default to whichever command was configured first; the picker only
  // appears once there is more than one to choose between.
  const active = selected ?? commands[0]?.[0] ?? null;

  // The newest run *of the selected command*. Newest-of-any would show a
  // typecheck's output under the test explorer's heading.
  const latest = useMemo(() => {
    const forCommand = runs.filter((run) => run.name === active);
    return forCommand.length > 0 ? forCommand[forCommand.length - 1] : null;
  }, [runs, active]);

  const report = latest?.tests ?? null;

  const counts = useMemo(() => {
    const tally: Record<TestStatus, number> = { passed: 0, failed: 0, errored: 0, skipped: 0 };
    for (const testCase of report?.cases ?? []) tally[testCase.status] += 1;
    return tally;
  }, [report]);

  // Results describe the code as it was when the command ran. A save since
  // then means they may no longer be true — said out loud rather than left
  // for the user to notice.
  const stale =
    latest != null && lastEditAt != null && lastEditAt > Date.parse(latest.at);

  const run = useCallback(() => {
    if (!active) return;
    setRunning(true);
    setError(null);
    api.runVerify(projectHash, active, threadId).catch((err) => {
      setError(describeError(err));
      setRunning(false);
    });
  }, [projectHash, active, threadId]);

  return (
    <Stack gap="xs" p="xs">
      <Group gap="xs">
        {commands.length > 1 && (
          <Select
            size="xs"
            w={160}
            aria-label="Test command"
            data={commands.map(([name]) => name)}
            value={active}
            onChange={setSelected}
            data-testid="test-command-select"
          />
        )}
        {active && (
          <Tooltip label={commands.find(([name]) => name === active)?.[1] ?? active}>
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<IconPlayerPlay size={12} />}
              loading={running}
              onClick={run}
              data-testid={`test-run-${active}`}
            >
              Run {active}
            </Button>
          </Tooltip>
        )}
        {loading && <Loader size="xs" />}
      </Group>

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

      {!loading && commands.length > 0 && !latest && (
        <Text size="xs" c="dimmed" data-testid="test-empty">
          Nothing run yet. Results appear here after {active} has been run.
        </Text>
      )}

      {stale && (
        <Alert color="yellow" variant="light" data-testid="test-stale">
          A file was saved after this run — these results describe the code as
          it was, not as it is.
        </Alert>
      )}

      {report?.unexplainedFailure && (
        <Alert color="red" variant="light" data-testid="test-unexplained">
          {`The command exited ${latest?.exitCode} but no individual test
            failed — the run may have crashed before reporting. Read the
            output below rather than the rows above.`}
        </Alert>
      )}

      {latest && report && !report.parsed && (
        <Stack gap={2} data-testid="test-unparsed">
          <Text size="xs" c="dimmed">
            {`Nothing here recognises this runner's output, so there is no
              per-test breakdown — only what the command printed:`}
          </Text>
          <Code block fz="10px" style={{ maxHeight: 200, overflow: "auto" }}>
            {latest.outputTail.trim() || "(no output)"}
          </Code>
        </Stack>
      )}

      {report?.parsed && (
        <>
          <Group gap="xs" data-testid="test-summary">
            <Badge size="xs" color="green" variant="light">
              {counts.passed} passed
            </Badge>
            <Badge size="xs" color="red" variant="light">
              {counts.failed + counts.errored} failed
            </Badge>
            {counts.skipped > 0 && (
              <Badge size="xs" color="gray" variant="light">
                {counts.skipped} skipped
              </Badge>
            )}
            <Text size="10px" c="dimmed">
              {report.framework} · exit {latest?.exitCode}
            </Text>
          </Group>

          {/* Rendered in the order the runner printed them: sorting failures
              to the top would make two runs of the same suite impossible to
              compare line by line. */}
          <Stack gap={1}>
            {report.cases.map((testCase, index) => {
              const locatable = testCase.file != null && testCase.line != null;
              return (
                <div
                  key={`${testCase.name}-${index}`}
                  className={`ds-test-case${locatable ? " is-locatable" : ""}`}
                  data-testid={`test-case-${testCase.name}`}
                  data-status={testCase.status}
                  role={locatable ? "button" : undefined}
                  tabIndex={locatable ? 0 : undefined}
                  onClick={() =>
                    locatable && onOpen?.(testCase.file as string, testCase.line as number)
                  }
                  onKeyDown={(event) => {
                    if (locatable && (event.key === "Enter" || event.key === " ")) {
                      onOpen?.(testCase.file as string, testCase.line as number);
                    }
                  }}
                >
                  <Text
                    span
                    size="xs"
                    fw={700}
                    c={STATUS_COLOR[testCase.status]}
                    className="ds-test-mark"
                  >
                    {STATUS_MARK[testCase.status]}
                  </Text>
                  <span className="ds-test-body">
                    <Text span size="xs" className="ds-test-name">
                      {testCase.name}
                    </Text>
                    {testCase.message && (
                      <Text span size="10px" c="dimmed" className="ds-test-message">
                        {testCase.message}
                      </Text>
                    )}
                  </span>
                  {locatable && (
                    <Text span size="10px" c="dimmed">
                      {`${testCase.file}:${testCase.line}`}
                    </Text>
                  )}
                </div>
              );
            })}
          </Stack>
        </>
      )}
    </Stack>
  );
}
