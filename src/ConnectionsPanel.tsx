import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Progress,
  Stack,
  Table,
  Tabs,
  Text,
  Tooltip,
} from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import * as api from "./api";

// Connections: the one place that answers "what is this app wired to?" —
// the agents that can run work, the MCP servers they get handed, and the
// user-level skills they load. The MCP half is the existing pane, passed in
// rather than re-implemented.

export type ConnectionsTab = "agents" | "mcp" | "skills";

export type ConnectionsPanelProps = {
  initialTab?: ConnectionsTab;
  /** The `<McpPane>` element, already bound to the active project by App. */
  mcp: React.ReactNode;
  projectHash: string;
  /** App's existing login handler — terminal logins run in a terminal,
   *  protocol logins go through `agentAuthenticate` (#19). Reused so there
   *  is exactly one sign-in flow in the app. */
  onLogin: (login: api.AgentLogin) => void;
};

/** How long until a usage window resets, in the coarsest unit that reads. */
export function resetsIn(iso: string, now = Date.now()): string | null {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `resets in ${hours}h`;
  return `resets in ${Math.round(hours / 24)}d`;
}

const OWNER_LABEL: Record<api.Skill["owner"], string> = {
  claude: "~/.claude",
  agents: "~/.agents",
  other: "other",
};

/** Bar colour by pressure, not by taste: room left, tightening, nearly spent.
 *  Thresholds are inclusive at 60 and exclusive at 85 — 85% is still a warning,
 *  not yet an alarm. */
export function usageColor(usedPercent: number): "success" | "warn" | "danger" {
  if (usedPercent > 85) return "danger";
  if (usedPercent >= 60) return "warn";
  return "success";
}

/** Warnings that are about agents, not about the rest of preflight. */
const agentWarning = (warning: string) => /agent/i.test(warning);

function UsageBlock({ usage }: { usage: api.AgentUsage | undefined }) {
  if (!usage) {
    return (
      <Text size="xs" c="dimmed">
        Usage not available for this agent
      </Text>
    );
  }
  if (usage.state !== "ok") {
    return usage.state === "not_signed_in" ? (
      <Text size="xs" c="dimmed" data-testid="usage-signed-out">
        Sign in to see usage
      </Text>
    ) : (
      <Tooltip label={usage.reason} openDelay={200}>
        <Text size="xs" c="dimmed" data-testid="usage-unavailable">
          Usage not available for this agent
        </Text>
      </Tooltip>
    );
  }
  return (
    <Stack gap={6} data-testid="usage-ok">
      {usage.balanceUsd !== undefined && (
        <Text size="xs" c="dimmed" data-testid="usage-balance">
          ${usage.balanceUsd.toFixed(2)} remaining
        </Text>
      )}
      {usage.windows.map((window) => {
        const reset = window.resetsAt ? resetsIn(window.resetsAt) : null;
        const color = usageColor(window.usedPercent);
        return (
          <div key={window.label} className="connections-usage-window">
            <Text size="xs" c="dimmed">
              {[window.label, `${Math.round(window.usedPercent)}%`, reset]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            <Progress
              value={window.usedPercent}
              size="sm"
              color={color}
              aria-label={`${window.label} usage`}
              data-testid="usage-window"
              data-color={color}
            />
          </div>
        );
      })}
    </Stack>
  );
}

function AgentsTab({ projectHash, onLogin }: { projectHash: string; onLogin: ConnectionsPanelProps["onLogin"] }) {
  const [flight, setFlight] = useState<api.Preflight | null>(null);
  const [usage, setUsage] = useState<api.AgentUsage[]>([]);
  const [logins, setLogins] = useState<Record<string, api.AgentLogin[]>>({});

  const refresh = useCallback(() => {
    api.preflight().then(setFlight, () => setFlight(null));
    api.agentUsage().then(setUsage, () => setUsage([]));
  }, []);

  // Mounted only while the tab is shown, so "on tab open + every 60s while
  // visible" is just mount + interval.
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    let live = true;
    for (const agent of flight?.agents ?? []) {
      api
        .agentLogins(projectHash, null, agent.id)
        .then(
          (found) =>
            live && setLogins((prior) => ({ ...prior, [agent.id]: found })),
          () => {}
        );
    }
    return () => {
      live = false;
    };
  }, [flight, projectHash]);

  const warnings = (flight?.warnings ?? []).filter(agentWarning);

  return (
    <Stack gap="sm" p="sm">
      {warnings.length > 0 && (
        <Alert color="warn" variant="light" data-testid="connections-agent-warnings">
          {warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </Alert>
      )}
      {flight?.agents.length === 0 && (
        <Text size="sm" c="dimmed">
          No ACP agents found on PATH.
        </Text>
      )}
      {(flight?.agents ?? []).map((agent) => {
        const mine = logins[agent.id] ?? [];
        const mineUsage = usage.find((u) => u.agentId === agent.id);
        // A reported usage window is proof of a session, so the sign-in
        // prompt retires on evidence rather than on a guess.
        const signedIn = mineUsage?.state === "ok";
        const plan = mineUsage?.state === "ok" ? mineUsage.plan : undefined;
        return (
          <Card key={agent.id} withBorder padding="sm" data-testid="connections-agent">
            {/* Stacked, not side by side: at the side-panel width a row of
                name + badges + button truncates all three. */}
            <Group justify="space-between" wrap="nowrap" gap="xs" align="baseline">
              <Text size="sm" fw={500} truncate>
                {agent.name}
              </Text>
              {agent.version && (
                <Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
                  {agent.version}
                </Text>
              )}
            </Group>
            {(plan || !agent.path) && (
              <Group gap="xs" mt={6}>
                {!agent.path && (
                  <Badge size="xs" variant="light" color="warn">
                    Not installed
                  </Badge>
                )}
                {plan && (
                  <Badge size="xs" variant="light" data-testid="usage-plan">
                    {plan}
                  </Badge>
                )}
              </Group>
            )}
            {!signedIn &&
              mine.map((login) => (
                <Tooltip key={login.methodId} label={login.label} openDelay={300}>
                  <Button
                    size="xs"
                    variant="light"
                    fullWidth
                    mt={8}
                    onClick={() => onLogin(login)}
                    data-testid="connections-sign-in"
                  >
                    Sign in
                  </Button>
                </Tooltip>
              ))}
            <div className="connections-usage">
              <UsageBlock usage={mineUsage} />
            </div>
          </Card>
        );
      })}
    </Stack>
  );
}

/** The path is a tooltip on the copy button rather than a column: a full
 *  skill path never fits a side panel, and a truncated one tells you nothing
 *  the copy button doesn't already hand you. */
function SkillPath({ path }: { path: string }) {
  const clipboard = useClipboard({ timeout: 1200 });
  return (
    <Tooltip label={clipboard.copied ? "Copied" : path} openDelay={300} multiline maw={320}>
      <ActionIcon
        variant="subtle"
        size="sm"
        aria-label={`Copy path for ${path}`}
        onClick={() => clipboard.copy(path)}
      >
        {clipboard.copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      </ActionIcon>
    </Tooltip>
  );
}

function SkillsTab() {
  const [skills, setSkills] = useState<api.Skill[] | null>(null);
  useEffect(() => {
    let live = true;
    api.listSkills().then(
      (found) => live && setSkills(found),
      () => live && setSkills([])
    );
    return () => {
      live = false;
    };
  }, []);

  if (skills && skills.length === 0) {
    return (
      <Text size="sm" c="dimmed" p="sm" data-testid="connections-skills-empty">
        No user-level skills found. Skills live in ~/.claude/skills or ~/.agents/skills.
      </Text>
    );
  }

  return (
    <Table striped highlightOnHover layout="fixed" className="connections-skills">
      <Table.Thead>
        <Table.Tr>
          <Table.Th w="38%">Name</Table.Th>
          <Table.Th w="24%">Owner</Table.Th>
          <Table.Th>Description</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {(skills ?? []).map((skill) => (
          <Table.Tr key={`${skill.owner}:${skill.path}`} data-testid="connections-skill">
            <Table.Td>
              <Group gap={2} wrap="nowrap" align="center">
                <Text size="xs" style={{ whiteSpace: "normal", wordBreak: "break-word" }}>
                  {skill.name}
                </Text>
                <SkillPath path={skill.path} />
              </Group>
            </Table.Td>
            <Table.Td>
              <Badge size="xs" variant="light">
                {OWNER_LABEL[skill.owner] ?? skill.owner}
              </Badge>
            </Table.Td>
            <Table.Td>
              <Text
                size="xs"
                c="dimmed"
                style={{ whiteSpace: "normal", wordBreak: "break-word" }}
              >
                {skill.description ?? "—"}
              </Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export default function ConnectionsPanel({
  initialTab = "agents",
  mcp,
  projectHash,
  onLogin,
}: ConnectionsPanelProps) {
  const [tab, setTab] = useState<ConnectionsTab>(initialTab);
  return (
    <Tabs
      value={tab}
      onChange={(value) => setTab((value as ConnectionsTab) ?? "agents")}
      className="connections-panel"
      keepMounted={false}
    >
      <Tabs.List>
        <Tabs.Tab value="agents">Agents</Tabs.Tab>
        <Tabs.Tab value="mcp">MCP servers</Tabs.Tab>
        <Tabs.Tab value="skills">Skills</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="agents">
        <AgentsTab projectHash={projectHash} onLogin={onLogin} />
      </Tabs.Panel>
      <Tabs.Panel value="mcp">{mcp}</Tabs.Panel>
      <Tabs.Panel value="skills">
        <SkillsTab />
      </Tabs.Panel>
    </Tabs>
  );
}
