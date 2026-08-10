import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Loader,
  Stack,
  Tabs,
  Text,
  Tooltip,
} from "@mantine/core";
import {
  IconChevronDown,
  IconChevronRight,
  IconPlayerPlay,
} from "@tabler/icons-react";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-markdown-preview/markdown.css";
import { listen } from "@tauri-apps/api/event";

import * as api from "./api";
import type { VerificationRun } from "./api";
import { describeError } from "./errors";

type Props = {
  projectHash: string;
  specName: string;
  /** Pinned verify commands for this change, keyed by spec name. The first
   * pinned command becomes the Tasks tab's primary "Run verify" action (D9). */
  verifyPins?: string[];
  /** Called when the user adds a verify pin from the Verify tab. */
  onAddPin?: (commandName: string) => void;
  /** Called when the user removes a verify pin from the Verify tab. */
  onRemovePin?: (commandName: string) => void;
};

type ArtifactState = {
  content: string | null;
  loading: boolean;
  error: string | null;
};

const emptyArtifact: ArtifactState = {
  content: null,
  loading: true,
  error: null,
};

const shortCommit = (head: string | null) => head?.slice(0, 7) ?? "no commit";

/** Parses `- [ ]` and `- [x]` checkboxes from `tasks.md` into a structured
 * list. Tasks outside checkbox lines are ignored — the task list is the
 * checkboxes, not the prose around them. */
type TaskItem = { checked: boolean; text: string };
function parseTasks(markdown: string): TaskItem[] {
  return markdown
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*-\s+\[( |x|X)\]\s+(.*)$/);
      if (!match) return null;
      return {
        checked: match[1].toLowerCase() === "x",
        text: match[2].trim(),
      } as TaskItem;
    })
    .filter((t): t is TaskItem => t !== null);
}

export default function SpecChangeTab({
  projectHash,
  specName,
  verifyPins,
  onAddPin,
  onRemovePin,
}: Props) {
  const [activeTab, setActiveTab] = useState<string | null>("proposal");

  // --- Artifact markdown (proposal, design, tasks) ---
  const [proposal, setProposal] = useState<ArtifactState>(emptyArtifact);
  const [design, setDesign] = useState<ArtifactState>(emptyArtifact);
  const [tasks, setTasks] = useState<ArtifactState>(emptyArtifact);

  // --- Spec deltas (structured requirements from `openspec show --json`) ---
  const [deltas, setDeltas] = useState<unknown>(null);
  const [specLoading, setSpecLoading] = useState(true);
  const [specError, setSpecError] = useState<string | null>(null);

  // --- Verify data (same sources as VerifyPane) ---
  const [commands, setCommands] = useState<[string, string][]>([]);
  const [runs, setRuns] = useState<VerificationRun[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const loadArtifact = useCallback(
    async (
      relativePath: string,
      setter: (s: ArtifactState) => void
    ): Promise<void> => {
      try {
        const content = await api.readFileContent(projectHash, relativePath);
        setter({ content, loading: false, error: null });
      } catch (err) {
        setter({ content: null, loading: false, error: describeError(err) });
      }
    },
    [projectHash]
  );

  // Load all artifacts on mount. Each loads independently so a missing
  // artifact (e.g. no design.md yet) doesn't block the others.
  useEffect(() => {
    setProposal(emptyArtifact);
    setDesign(emptyArtifact);
    setTasks(emptyArtifact);
    loadArtifact(`openspec/changes/${specName}/proposal.md`, setProposal);
    loadArtifact(`openspec/changes/${specName}/design.md`, setDesign);
    loadArtifact(`openspec/changes/${specName}/tasks.md`, setTasks);
  }, [projectHash, specName, loadArtifact]);

  // Load structured spec deltas from `openspec show --json` (D11).
  useEffect(() => {
    setSpecLoading(true);
    setSpecError(null);
    api
      .showSpecChange(projectHash, specName)
      .then((value) => {
        setDeltas(value);
        setSpecLoading(false);
      })
      .catch((err) => {
        setSpecError(describeError(err));
        setSpecLoading(false);
      });
  }, [projectHash, specName]);

  // Load verify commands + history (same as VerifyPane).
  useEffect(() => {
    Promise.all([
      api.verifyCommands(projectHash),
      api.listVerifications(projectHash),
    ])
      .then(([configured, history]) => {
        setCommands(configured);
        setRuns(history);
        setVerifyError(null);
      })
      .catch((err) => setVerifyError(describeError(err)));
  }, [projectHash]);

  // A verify command runs detached — the result arrives as an event.
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

  const run = useCallback(
    (name: string) => {
      setRunning((previous) => new Set(previous).add(name));
      api.runVerify(projectHash, name).catch((err) => {
        setVerifyError(describeError(err));
        setRunning((previous) => {
          const next = new Set(previous);
          next.delete(name);
          return next;
        });
      });
    },
    [projectHash]
  );

  const taskItems = useMemo(
    () => (tasks.content ? parseTasks(tasks.content) : []),
    [tasks.content]
  );

  const pinnedCommand = verifyPins?.[0];
  const pinnedCommandPair = commands.find(([name]) => name === pinnedCommand);

  const latestRuns = useMemo(() => [...runs].reverse(), [runs]);

  return (
    <Stack gap={0} h="100%" style={{ overflow: "hidden" }}>
      <Tabs
        value={activeTab}
        onChange={setActiveTab}
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Tabs.List style={{ flexWrap: "nowrap", overflowX: "auto" }}>
          <Tabs.Tab value="proposal" data-testid="spec-inner-tab">
            Proposal
          </Tabs.Tab>
          <Tabs.Tab value="design" data-testid="spec-inner-tab">
            Design
          </Tabs.Tab>
          <Tabs.Tab value="spec" data-testid="spec-inner-tab">
            Spec
          </Tabs.Tab>
          <Tabs.Tab value="tasks" data-testid="spec-inner-tab">
            Tasks
          </Tabs.Tab>
          <Tabs.Tab value="verify" data-testid="spec-inner-tab">
            Verify
          </Tabs.Tab>
        </Tabs.List>

        <Box style={{ flex: 1, minHeight: 0, overflow: "auto" }} p="sm">
          {/* ---------- Proposal ---------- */}
          {activeTab === "proposal" && <ArtifactView state={proposal} />}

          {/* ---------- Design ---------- */}
          {activeTab === "design" && <ArtifactView state={design} />}

          {/* ---------- Spec (structured deltas) ---------- */}
          {activeTab === "spec" && (
            <SpecDeltasView
              projectHash={projectHash}
              specName={specName}
              loading={specLoading}
              error={specError}
              deltas={deltas}
            />
          )}

          {/* ---------- Tasks ---------- */}
          {activeTab === "tasks" && (
            <Stack gap="xs">
              {pinnedCommandPair && (
                <Tooltip label={pinnedCommandPair[1]}>
                  <Button
                    size="compact-sm"
                    variant="filled"
                    leftSection={<IconPlayerPlay size={14} />}
                    loading={running.has(pinnedCommandPair[0])}
                    onClick={() => run(pinnedCommandPair[0])}
                    data-testid="spec-tasks-run-verify"
                    style={{ alignSelf: "flex-start" }}
                  >
                    Run verify: {pinnedCommandPair[0]}
                  </Button>
                </Tooltip>
              )}
              <Alert color="gray" variant="light" p="xs">
                <Text size="xs" c="dimmed">
                  Task checkboxes are the agent's self-report about its own work
                  — not evidence that anything runs. Only a verify command's
                  exit code shows whether the work actually passes.
                </Text>
              </Alert>
              {tasks.loading && <Loader size="xs" />}
              {tasks.error && (
                <Alert color="red" variant="light">
                  {tasks.error}
                </Alert>
              )}
              {!tasks.loading && !tasks.error && taskItems.length === 0 && (
                <Text size="xs" c="dimmed">
                  No tasks found in tasks.md.
                </Text>
              )}
              {taskItems.map((task, i) => (
                <Group key={i} gap="xs" wrap="nowrap">
                  <Text
                    size="sm"
                    c={task.checked ? "dimmed" : undefined}
                    style={{
                      textDecoration: task.checked ? "line-through" : undefined,
                    }}
                  >
                    {task.checked ? "☑" : "☐"} {task.text}
                  </Text>
                </Group>
              ))}
              {/* Also show the raw markdown below the parsed list, for the
                  prose between checkboxes that gives tasks their context. */}
              {!tasks.loading && tasks.content && (
                <Box
                  mt="md"
                  style={{
                    borderTop: "1px solid var(--mantine-color-default-border)",
                  }}
                  pt="md"
                >
                  <MDEditor.Markdown source={tasks.content} />
                </Box>
              )}
            </Stack>
          )}

          {/* ---------- Verify ---------- */}
          {activeTab === "verify" && (
            <Stack gap="xs">
              <Group justify="space-between">
                <Text size="sm" fw={600}>
                  Verification
                </Text>
              </Group>
              {verifyError && (
                <Alert color="red" variant="light">
                  {verifyError}
                </Alert>
              )}
              {commands.length === 0 && !verifyError && (
                <Text size="xs" c="dimmed">
                  No verify commands configured. Add a <Code>verify</Code> map
                  to <Code>.project-settings.json</Code>.
                </Text>
              )}
              <Group gap="xs">
                {commands.map(([name, command]) => {
                  const pinned = verifyPins?.includes(name) ?? false;
                  return (
                    <Tooltip key={name} label={command}>
                      <Group gap={4}>
                        <Button
                          size="compact-xs"
                          variant="light"
                          leftSection={<IconPlayerPlay size={12} />}
                          loading={running.has(name)}
                          onClick={() => run(name)}
                          data-testid={`spec-verify-run-${name}`}
                        >
                          {name}
                        </Button>
                        {onAddPin && !pinned && (
                          <Tooltip label="Pin to Tasks tab">
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              onClick={() => onAddPin(name)}
                              data-testid={`spec-verify-pin-${name}`}
                            >
                              Pin
                            </Button>
                          </Tooltip>
                        )}
                        {onRemovePin && pinned && (
                          <Tooltip label="Unpin from Tasks tab">
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              color="gray"
                              onClick={() => onRemovePin(name)}
                              data-testid={`spec-verify-unpin-${name}`}
                            >
                              Unpin
                            </Button>
                          </Tooltip>
                        )}
                      </Group>
                    </Tooltip>
                  );
                })}
              </Group>
              {latestRuns.map((entry) => (
                <Stack
                  key={entry.id}
                  gap={2}
                  data-testid="spec-verification-run"
                >
                  <Group gap="xs" wrap="nowrap">
                    <Badge
                      size="xs"
                      color={entry.exitCode === 0 ? "green" : "red"}
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
                  <Code
                    block
                    fz="10px"
                    style={{ maxHeight: 120, overflow: "auto" }}
                  >
                    {entry.command}
                    {"\n"}
                    {entry.outputTail.trim() || "(no output)"}
                  </Code>
                </Stack>
              ))}
            </Stack>
          )}
        </Box>
      </Tabs>
    </Stack>
  );
}

/** Renders a markdown artifact (proposal/design) with loading and error states. */
function ArtifactView({ state }: { state: ArtifactState }) {
  if (state.loading) return <Loader size="xs" />;
  if (state.error)
    return (
      <Alert color="red" variant="light">
        {state.error}
      </Alert>
    );
  if (state.content === null)
    return (
      <Text size="xs" c="dimmed">
        No content.
      </Text>
    );
  return <MDEditor.Markdown source={state.content} />;
}

/** Renders the structured spec deltas from `openspec show --json` as
 * requirement cards with their scenarios. */
type SpecDelta = {
  spec: string;
  operation: string;
  description: string;
  requirement: { text: string; scenarios: { rawText: string }[] };
};

function SpecDeltasView({
  projectHash,
  specName,
  loading,
  error,
  deltas,
}: {
  projectHash: string;
  specName: string;
  loading: boolean;
  error: string | null;
  deltas: unknown;
}) {
  const items = useMemo(() => {
    if (!deltas || typeof deltas !== "object") return [];
    const value = deltas as { deltas?: SpecDelta[] };
    return value.deltas ?? [];
  }, [deltas]);

  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [source, setSource] = useState<ArtifactState>(emptyArtifact);

  const loadSource = useCallback(
    async (spec: string) => {
      setSource({ content: null, loading: true, error: null });
      try {
        const localPath = `openspec/changes/${specName}/specs/${spec}/spec.md`;
        let content: string;
        try {
          content = await api.readFileContent(projectHash, localPath);
        } catch {
          content = await api.readFileContent(
            projectHash,
            `openspec/specs/${spec}/spec.md`
          );
        }
        setSource({ content, loading: false, error: null });
      } catch (err) {
        setSource({ content: null, loading: false, error: describeError(err) });
      }
    },
    [projectHash, specName]
  );

  useEffect(() => {
    if (expandedIndex === null) {
      setSource(emptyArtifact);
      return;
    }
    const delta = items[expandedIndex];
    if (!delta) return;
    loadSource(delta.spec);
  }, [expandedIndex, items, loadSource]);

  if (loading) return <Loader size="xs" />;
  if (error)
    return (
      <Alert color="red" variant="light">
        {error}
      </Alert>
    );
  if (!deltas || typeof deltas !== "object") {
    return (
      <Text size="xs" c="dimmed">
        No spec deltas available (is `openspec` installed?).
      </Text>
    );
  }
  if (items.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        No spec requirements recorded for this change.
      </Text>
    );
  }

  return (
    <Stack gap="sm">
      {items.map((delta, i) => {
        const expanded = expandedIndex === i;
        return (
          <Stack
            key={i}
            gap={4}
            p="sm"
            style={{
              border: "1px solid var(--mantine-color-default-border)",
              borderRadius: "var(--mantine-radius-sm)",
            }}
          >
            <Group gap="xs" wrap="nowrap">
              <Badge
                size="xs"
                variant="light"
                color={delta.operation === "ADDED" ? "green" : "orange"}
              >
                {delta.operation}
              </Badge>
              <Text size="xs" c="dimmed">
                {delta.spec}
              </Text>
            </Group>
            <Group
              data-testid="spec-delta-title"
              gap="xs"
              wrap="nowrap"
              justify="space-between"
              onClick={() => setExpandedIndex(expanded ? null : i)}
              style={{ cursor: "pointer" }}
            >
              <Text size="sm" fw={600}>
                {delta.requirement.text}
              </Text>
              {expanded ? (
                <IconChevronDown size={16} />
              ) : (
                <IconChevronRight size={16} />
              )}
            </Group>
            {delta.requirement.scenarios.map((scenario, j) => (
              <Text
                key={j}
                size="xs"
                c="dimmed"
                style={{ whiteSpace: "pre-wrap" }}
              >
                {scenario.rawText}
              </Text>
            ))}
            {expanded && (
              <Box
                mt="xs"
                style={{
                  maxHeight: "50vh",
                  overflow: "auto",
                  border: "1px solid var(--mantine-color-default-border)",
                  borderRadius: "var(--mantine-radius-sm)",
                  padding: "var(--mantine-spacing-sm)",
                }}
              >
                <ArtifactView state={source} />
              </Box>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}
