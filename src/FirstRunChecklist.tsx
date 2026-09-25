import { Alert, Anchor, Button, Group, List, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconRefresh, IconRobot } from "@tabler/icons-react";
import type { Preflight } from "./api";
import { AddAgentButtonList } from "./AddAgentMenu";

// What a first run with no agent sees instead of a one-line warning: why
// there is nothing to talk to, the three steps that fix it, and a button
// that checks again without a relaunch. Agents are named by the registry,
// never here — Palisade does not know which one the user will pick.

export type FirstRunReason = "registry-unreachable" | "none-on-path";

/** Why the agent list is empty, from preflight's structured flag. */
export function firstRunReason(flight: Preflight): FirstRunReason {
  return flight.registryReachable ? "none-on-path" : "registry-unreachable";
}

const REGISTRY_URL = "https://agentclientprotocol.com/";

/** Every warning that is not the "no agents" one, so nothing preflight said is lost. */
function otherWarnings(flight: Preflight): string[] {
  return flight.warnings.filter((w) => !/chat-only mode/i.test(w));
}

export default function FirstRunChecklist({
  flight,
  onRecheck,
  checking,
  onAddAgent,
  addingAgentId = null,
}: {
  flight: Preflight;
  onRecheck: () => void;
  checking: boolean;
  /** Enables a registry agent from `flight.addable` (see `AddAgentMenu`). */
  onAddAgent?: (agentId: string) => void;
  addingAgentId?: string | null;
}) {
  const reason = firstRunReason(flight);
  const rest = otherWarnings(flight);
  // At least one registry agent's runtime is already on PATH — this is a
  // choice to make ("choose your coding agent"), not the generic
  // install-and-relaunch instructions below, which only apply when nothing
  // could be added yet either.
  const canAdd = onAddAgent && (flight.addable?.length ?? 0) > 0;
  return (
    <Alert
      color="warn"
      variant="light"
      radius={0}
      icon={<IconRobot size={16} />}
      title={canAdd ? "Choose your coding agent" : "Palisade needs a coding agent"}
      data-testid="first-run-checklist"
    >
      <Stack gap="xs">
        {canAdd ? (
          <>
            <Text size="xs" data-testid="first-run-reason">
              These agents are on this Mac's PATH but haven't been added yet —
              pick one to start using /go.
            </Text>
            <AddAgentButtonList
              addable={flight.addable}
              onAdd={onAddAgent}
              addingId={addingAgentId}
              testIdPrefix="first-run-add-agent"
            />
          </>
        ) : (
          <>
            <Text size="xs" data-testid="first-run-reason">
              {reason === "registry-unreachable"
                ? "The ACP agent registry could not be reached and there is no cached copy yet. Check the network, then check again — nothing else is wrong."
                : "No ACP coding agent is installed on this Mac's PATH, so threads are chat-only and /go is off."}
            </Text>
            <List type="ordered" size="xs" spacing={4}>
              <List.Item>
                Install an agent from the{" "}
                <Anchor href={REGISTRY_URL} size="xs">
                  ACP agent registry
                </Anchor>{" "}
                (Claude Code, Codex and others speak ACP).
              </List.Item>
              <List.Item>Sign in to it once in your terminal, the way its own docs say.</List.Item>
              <List.Item>Come back, check again, and send your first prompt.</List.Item>
            </List>
          </>
        )}
        <Group gap="xs">
          <Button
            size="compact-xs"
            variant="default"
            leftSection={<IconRefresh size={12} />}
            loading={checking}
            onClick={onRecheck}
            data-testid="first-run-recheck"
          >
            Check again
          </Button>
        </Group>
        {rest.map((warning) => (
          <Group gap={4} wrap="nowrap" key={warning}>
            <IconAlertTriangle size={12} style={{ flexShrink: 0 }} />
            <Text size="xs">{warning}</Text>
          </Group>
        ))}
      </Stack>
    </Alert>
  );
}
