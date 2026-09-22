import { useEffect, useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Menu,
  Modal,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconPlus,
  IconRoute,
  IconDots,
  IconTrash,
  IconPlayerPlay,
  IconHistory,
  IconCopy,
} from "@tabler/icons-react";
import * as api from "./api";
import ChainRunHistory from "./ChainRunHistory";
import { describeError } from "./errors";

// The Chains side panel. List-only, deliberately: the panel finds a chain,
// the center-workspace tab is where it's built (DESIGN.md's side-panel rule,
// mirroring the Database panel exactly).

export const CHAINS_CHANGED_EVENT = "palisade:chains-changed";

/** Lets the canvas tell the panel to re-list after a save or delete. */
export const announceChainsChanged = () =>
  window.dispatchEvent(new Event(CHAINS_CHANGED_EVENT));

type Props = {
  projectHash: string | undefined;
  /** Opens a chain on the canvas; null builds a new one. */
  onOpen: (chainName: string | null) => void;
  /** Runs a saved chain against the active thread. Absent with no thread. */
  onRun?: (chainName: string, seed: string) => void;
  /** Opens a past run on the canvas in Review mode. */
  onOpenRun?: (runId: string) => void;
  /** Re-runs a past record; `fromRole` starts from that node's recorded inputs. */
  onRerun?: (runId: string, fromRole?: string) => void;
  /** Installed agents (D16), used to bind the worked example's agent node —
   *  the same list `ChainCanvas`'s own picker offers. */
  agents?: { id: string; name: string }[];
};

/**
 * The empty-state worked example (D16): a two-node chain — an agent drafts,
 * an agent reviews, and a human approves or sends it back for another draft
 * — small enough to read at a glance while still demonstrating the
 * human-in-the-loop approval gate. `agentId` binds both nodes to whatever is
 * actually installed; a model is required on every node (no model = no
 * node), so `modelId` binds both to whatever that agent actually offers.
 * `chains::save`'s own validation is what a schema change breaking this
 * shape would fail against.
 */
export function workedExampleChain(agentId: string, modelId: string): api.Chain {
  return {
    name: "Example - draft then review",
    nodes: {
      drafter: {
        role: "drafter",
        guideline: "Write a short first draft answering the request.",
        agent: agentId,
        model: modelId,
      },
      reviewer: {
        role: "reviewer",
        guideline: "Critique the draft against the original request.",
        agent: agentId,
        model: modelId,
      },
    },
    edges: [
      { from: "drafter", to: "reviewer" },
      { from: "reviewer", to: "drafter", gate: { type: "approval" }, maxIterations: 3 },
    ],
    entry: "drafter",
    timeoutSeconds: 1800,
    retry: { maxAttempts: 2 },
    layout: { drafter: { x: 60, y: 120 }, reviewer: { x: 340, y: 120 } },
  };
}

export default function ChainsPanel({ projectHash, onOpen, onRun, onOpenRun, onRerun, agents }: Props) {
  const [chains, setChains] = useState<api.Chain[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [exampleBusy, setExampleBusy] = useState(false);
  /** The playbook whose Delete is waiting on a second click. Deleting is the
   *  one action here with no undo, so it is the one that asks. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!projectHash) {
      setChains([]);
      return;
    }
    let live = true;
    const load = () =>
      api
        .listChains(projectHash)
        .then((next) => live && setChains(next))
        .catch((err) => live && setError(describeError(err, { loading: "your playbooks" })));
    void load();
    window.addEventListener(CHAINS_CHANGED_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(CHAINS_CHANGED_EVENT, load);
    };
  }, [projectHash]);

  const remove = async (name: string) => {
    if (!projectHash) return;
    setConfirmDelete(null);
    try {
      await api.deleteChain(projectHash, name);
      announceChainsChanged();
    } catch (err) {
      setError(describeError(err));
    }
  };

  /** Saves a copy under the first free "<name> copy", "<name> copy 2", …
   *  and opens it — the way to fork a working playbook without editing
   *  the original in place. The definition is plain JSON, so a copy is the
   *  same record with a new name and nothing else. */
  const duplicate = async (chain: api.Chain) => {
    if (!projectHash) return;
    const taken = new Set(chains.map((c) => c.name));
    let name = `${chain.name} copy`;
    for (let n = 2; taken.has(name); n += 1) name = `${chain.name} copy ${n}`;
    try {
      await api.saveChain(projectHash, { ...chain, name });
      announceChainsChanged();
      onOpen(name);
    } catch (err) {
      setError(describeError(err, { action: "duplicate this playbook" }));
    }
  };

  /** Saves the worked example (D16) if it isn't already there, then opens
   *  it — same path as clicking any other chain row. */
  const openExample = async () => {
    if (!projectHash) return;
    setExampleBusy(true);
    try {
      const agentId = agents?.[0]?.id ?? "claude-code";
      const { models } = await api.listModels(projectHash, agentId);
      if (!models[0]) throw new Error(`${agentId} offers no models to bind the worked example to.`);
      const example = workedExampleChain(agentId, models[0].id);
      if (!chains.some((c) => c.name === example.name)) {
        await api.saveChain(projectHash, example);
        announceChainsChanged();
      }
      onOpen(example.name);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setExampleBusy(false);
    }
  };

  return (
    <>
      <div className="ds-panel-head">
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <span>Playbooks</span>
          <Tooltip label="New playbook" position="left">
            <ActionIcon
              size="sm"
              variant="subtle"
              color="neutral"
              aria-label="New playbook"
              onClick={() => onOpen(null)}
            >
              <IconPlus size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </div>

      <div className="ds-panel-body" data-testid="chains-panel">
        {error && (
          <Text size="xs" c="danger" p="xs">
            {error}
          </Text>
        )}

        {chains.length === 0 && !error && (
          <div className="ds-chains-empty" data-testid="chains-panel-empty">
            <Text size="xs" c="dimmed" p="xs">
              No playbooks yet. Build one on the canvas — nodes bound to
              installed agents, connected by edges — then run it with{" "}
              <code>|=</code> from any thread, from a thread's model picker,
              or from here. A saved run's history stays reachable from
              wherever it was invoked.
            </Text>
            <Button
              size="xs"
              variant="default"
              mx="xs"
              mb="xs"
              loading={exampleBusy}
              onClick={() => void openExample()}
              data-testid="chains-panel-open-example"
            >
              Open a worked example
            </Button>
          </div>
        )}

        {chains.map((chain) => (
          <div key={chain.name}>
            <div className="ds-chain-row">
              <UnstyledButton
                className="ds-chain-row-main"
                onClick={() => onOpen(chain.name)}
                data-testid={`chain-row-${chain.name}`}
              >
                <IconRoute size={14} className="ds-chain-row-icon" />
                <span className="ds-chain-row-name">{chain.name}</span>
              </UnstyledButton>
              {/* Second line, so the name gets the panel's full width:
                  side by side, every playbook read as "gated-l…". */}
              <div className="ds-chain-row-meta">
                <span className="ds-chain-row-count">
                  {Object.keys(chain.nodes).length === 1
                    ? "1 node"
                    : `${Object.keys(chain.nodes).length} nodes`}
                </span>
                <Tooltip label="Run history" position="left">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="neutral"
                    aria-label={`Run history for ${chain.name}`}
                    aria-pressed={historyFor === chain.name}
                    onClick={() =>
                      setHistoryFor((current) => (current === chain.name ? null : chain.name))
                    }
                  >
                    <IconHistory size={14} />
                  </ActionIcon>
                </Tooltip>
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="neutral"
                      aria-label={`Actions for ${chain.name}`}
                    >
                      <IconDots size={14} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {onRun && (
                      <Menu.Item
                        leftSection={<IconPlayerPlay size={14} />}
                        onClick={() => onRun(chain.name, "")}
                      >
                        Run
                      </Menu.Item>
                    )}
                    <Menu.Item
                      leftSection={<IconCopy size={14} />}
                      onClick={() => void duplicate(chain)}
                    >
                      Duplicate
                    </Menu.Item>
                    <Menu.Item
                      color="danger"
                      leftSection={<IconTrash size={14} />}
                      onClick={() => setConfirmDelete(chain.name)}
                    >
                      Delete…
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </div>
            </div>
            {projectHash && historyFor === chain.name && (
              <ChainRunHistory
                projectHash={projectHash}
                chainName={chain.name}
                onOpenRun={onOpenRun}
                onRerun={onRerun}
              />
            )}
          </div>
        ))}
      </div>

      <Modal
        opened={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={`Delete ${confirmDelete ?? ""}?`}
        size="sm"
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            The playbook definition is removed from this project. Its past
            runs stay in the run history.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button size="xs" variant="default" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              size="xs"
              color="danger"
              onClick={() => confirmDelete && void remove(confirmDelete)}
              data-testid="chains-panel-confirm-delete"
            >
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
