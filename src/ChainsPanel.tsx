import { useEffect, useState } from "react";
import {
  ActionIcon,
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
} from "@tabler/icons-react";
import * as api from "./api";

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
  onRun?: (chainName: string) => void;
};

export default function ChainsPanel({ projectHash, onOpen, onRun }: Props) {
  const [chains, setChains] = useState<api.Chain[]>([]);
  const [error, setError] = useState<string | null>(null);

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
        .catch((err) => live && setError(String(err)));
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
      setError(String(err));
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
              color="gray"
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
          <Text size="xs" c="red" p="xs">
            {error}
          </Text>
        )}

        {chains.length === 0 && !error && (
          <Text size="xs" c="dimmed" p="xs">
            No chains yet. A chain wires several agents into one pipeline —
            build one, then run it with <code>|=</code> from any thread.
          </Text>
        )}

        {chains.map((chain) => (
          <div key={chain.name} className="ds-chain-row">
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
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  aria-label={`Actions for ${chain.name}`}
                >
                  <IconDots size={14} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {onRun && (
                  <Menu.Item
                    leftSection={<IconPlayerPlay size={14} />}
                    onClick={() => onRun(chain.name)}
                  >
                    Run on this thread
                  </Menu.Item>
                )}
                <Menu.Item
                  color="red"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => void remove(chain.name)}
                >
                  Delete
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>
        ))}
      </div>
    </>
  );
}
