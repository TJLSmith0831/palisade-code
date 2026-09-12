import { useEffect, useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Menu,
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
        .catch((err) => live && setError(describeError(err, { loading: "your chains" })));
    void load();
    window.addEventListener(CHAINS_CHANGED_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(CHAINS_CHANGED_EVENT, load);
    };
  }, [projectHash]);

  const remove = async (name: string) => {
    if (!projectHash) return;
    try {
      await api.deleteChain(projectHash, name);
      announceChainsChanged();
    } catch (err) {
      setError(describeError(err));
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
          <span>Chains</span>
          <Tooltip label="New chain" position="left">
            <ActionIcon
              size="sm"
              variant="subtle"
              color="neutral"
              aria-label="New chain"
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
              No chains yet. Build one on the canvas — nodes bound to
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
                <span className="ds-chain-row-count">
                  {Object.keys(chain.nodes).length}
                </span>
              </UnstyledButton>
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
                    color="danger"
                    leftSection={<IconTrash size={14} />}
                    onClick={() => void remove(chain.name)}
                  >
                    Delete
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
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
    </>
  );
}
