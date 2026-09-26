import { useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
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
  /** Set when no installed agent currently offers a model to bind the worked
   *  example to (e.g. none is signed in) — the display name of the agent the
   *  button tried last, so the panel can say who to sign in rather than
   *  dead-ending on a raw error. Cleared whenever the agent list changes, so
   *  signing in and coming back doesn't leave a stale warning on screen. */
  const [exampleBlocked, setExampleBlocked] = useState<string | null>(null);
  /** The playbook whose Delete is waiting on a second click. Deleting is the
   *  one action here with no undo, so it is the one that asks. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // The agent bound to the last blocked attempt is stale the moment the
  // installed-agent list changes (a sign-in completed, an agent was added) —
  // and gone for good when the panel itself unmounts.
  useEffect(() => {
    setExampleBlocked(null);
    return () => setExampleBlocked(null);
  }, [agents]);

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
    setExampleBlocked(null);
    const candidates = agents && agents.length > 0 ? agents : [{ id: "claude-code", name: "Claude Code" }];
    try {
      // Try every installed agent, not just the first — an agent with no
      // models (typically: not signed in) shouldn't dead-end the example
      // when another installed agent can bind it instead.
      let bound: { agentId: string; modelId: string } | null = null;
      for (const candidate of candidates) {
        try {
          const { models } = await api.listModels(projectHash, candidate.id);
          if (models[0]) {
            bound = { agentId: candidate.id, modelId: models[0].id };
            break;
          }
        } catch {
          // This agent can't answer right now; move on to the next one.
        }
      }
      if (!bound) {
        setExampleBlocked(candidates[0].name);
        return;
      }
      const example = workedExampleChain(bound.agentId, bound.modelId);
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
              installed agents, connected by edges — then run it by typing{" "}
              <code>|=</code> in any thread's composer, from a thread's model
              picker, or from here. A saved run's history stays reachable
              from wherever it was invoked.
            </Text>
            {exampleBlocked && (
              <Alert
                color="warn"
                variant="light"
                mx="xs"
                mb="xs"
                data-testid="chains-panel-example-blocked"
              >
                {exampleBlocked} has no models available right now, so the
                worked example can't bind to it. Sign in to {exampleBlocked},
                or install and select another agent, then try again.
              </Alert>
            )}
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
