import { Alert, Anchor, Button, Group, List, Stack, Text } from "@mantine/core";
import { IconRefresh, IconRobot } from "@tabler/icons-react";
import type { Preflight } from "./api";

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
}: {
  flight: Preflight;
  onRecheck: () => void;
  checking: boolean;
}) {
  const reason = firstRunReason(flight);
  const rest = otherWarnings(flight);
  return (
    <Alert
      color="warn"
      variant="light"
      radius={0}
      icon={<IconRobot size={16} />}
      title="Palisade needs a coding agent"
      data-testid="first-run-checklist"
    >
      <Stack gap="xs">
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
          <Text size="xs" key={warning}>
            ⚠ {warning}
          </Text>
        ))}
      </Stack>
    </Alert>
  );
}
