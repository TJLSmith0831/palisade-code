import { useState } from "react";
import { Box, Button, Menu, Stack, Text, TextInput } from "@mantine/core";
import type { AddableAgent } from "./api";

// Shared "Add an agent" list, reused wherever the app lists agents (the
// onboarding status popover, the composer's provider pickers, and the
// chat-only first-run prompt): registry agents whose runtime is on PATH but
// whose package hasn't been fetched yet, and that the user hasn't already
// enabled. Modeled on how Zed's ACP registry browser works — the agent
// becomes selectable the moment it's added; the actual npm/PyPI package
// downloads on its first real launch, not here.

/** Substring match against name + description, case-insensitive. */
function useAgentSearch(addable: AddableAgent[]) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q
    ? addable.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.description ?? "").toLowerCase().includes(q)
      )
    : addable;
  return { query, setQuery, filtered };
}

const ADD_AGENT_FOOTNOTE =
  "Adding fetches the agent the first time you use it — you may still need to sign in with its own CLI.";

/** Renders inside an open `<Menu.Dropdown>` — a label, an optional search
 *  box (only once there's enough to search), and the addable agents
 *  themselves. Nothing renders when `addable` is empty. */
export function AddAgentMenuSection({
  addable,
  onAdd,
  addingId,
  testIdPrefix = "add-agent",
}: {
  addable: AddableAgent[];
  onAdd: (agentId: string) => void;
  /** The agent currently being enabled, if any — disables its row so a
   *  double-click can't fire `onAdd` twice. */
  addingId?: string | null;
  testIdPrefix?: string;
}) {
  const { query, setQuery, filtered } = useAgentSearch(addable);
  if (addable.length === 0) return null;
  return (
    <>
      <Menu.Divider />
      <Menu.Label>Add an agent</Menu.Label>
      {addable.length > 4 && (
        <TextInput
          placeholder="Search agents…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          size="xs"
          style={{ margin: "0 8px 8px" }}
          data-testid={`${testIdPrefix}-search`}
        />
      )}
      <Box style={{ maxHeight: 220, overflowY: "auto" }}>
        {filtered.map((a) => (
          <Menu.Item
            key={a.id}
            className="ds-model-opt"
            data-testid={`${testIdPrefix}-opt-${a.id}`}
            disabled={addingId === a.id}
            onClick={() => onAdd(a.id)}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              <span>{a.name}{addingId === a.id ? " · Adding…" : ""}</span>
              {a.description && (
                <span className="hint" style={{ fontSize: 11 }}>
                  {a.description}
                </span>
              )}
            </div>
          </Menu.Item>
        ))}
        {filtered.length === 0 && (
          <span className="hint" data-testid={`${testIdPrefix}-no-matches`}>
            No agents match.
          </span>
        )}
      </Box>
      <div className="hint" style={{ padding: "4px 8px", fontSize: 11 }}>
        {ADD_AGENT_FOOTNOTE}
      </div>
    </>
  );
}

/** Standalone version for use outside a `<Menu>` — the chat-only first-run
 *  prompt (`FirstRunChecklist`) isn't a dropdown, so it renders addable
 *  agents as plain buttons in a `Stack` instead of `Menu.Item`s. */
export function AddAgentButtonList({
  addable,
  onAdd,
  addingId,
  testIdPrefix = "add-agent",
}: {
  addable: AddableAgent[];
  onAdd: (agentId: string) => void;
  addingId?: string | null;
  testIdPrefix?: string;
}) {
  const { query, setQuery, filtered } = useAgentSearch(addable);
  if (addable.length === 0) return null;
  return (
    <Stack gap={6}>
      {addable.length > 4 && (
        <TextInput
          placeholder="Search agents…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          size="xs"
          data-testid={`${testIdPrefix}-search`}
        />
      )}
      <Box style={{ maxHeight: 260, overflowY: "auto" }}>
        <Stack gap={4}>
          {filtered.map((a) => (
            <Button
              key={a.id}
              variant="default"
              size="compact-xs"
              justify="space-between"
              fullWidth
              loading={addingId === a.id}
              disabled={addingId === a.id}
              onClick={() => onAdd(a.id)}
              data-testid={`${testIdPrefix}-opt-${a.id}`}
            >
              <Stack gap={0} align="flex-start">
                <span>{a.name}</span>
                {a.description && (
                  <Text size="xs" c="dimmed">
                    {a.description}
                  </Text>
                )}
              </Stack>
            </Button>
          ))}
          {filtered.length === 0 && (
            <Text size="xs" c="dimmed" data-testid={`${testIdPrefix}-no-matches`}>
              No agents match.
            </Text>
          )}
        </Stack>
      </Box>
      <Text size="xs" c="dimmed">
        {ADD_AGENT_FOOTNOTE}
      </Text>
    </Stack>
  );
}
