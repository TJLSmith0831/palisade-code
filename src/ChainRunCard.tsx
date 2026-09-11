import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Group, Paper, Stack, Text, TextInput } from "@mantine/core";
import { IconAlertTriangle, IconChevronDown, IconChevronRight, IconPlayerStop } from "@tabler/icons-react";
import * as api from "./api";
import { useElapsed } from "./useElapsed";
import { outcomeText, type RunView } from "./ChainCanvas";
import ChainRunHistory from "./ChainRunHistory";

/**
 * The chat-side run view: `RunView` plus the two fields the card needs that
 * `ChainCanvas`'s `RunView` doesn't carry — which chain and which thread
 * this run belongs to. App.tsx keys the card's visibility on `threadId` so
 * a run started from one thread never bleeds into another's chat.
 */
export type ChainRunCardView = RunView & { chain: string; threadId: string };

type Props = {
  run: ChainRunCardView;
  /** Needed to call `rerunChainRun`, which is scoped to a project. */
  projectHash: string;
  /** The shell owns transcript navigation — the card only names the session. */
  onTranscript?: (sessionId: string) => void;
  /**
   * Fired after this card successfully resolves the pending gate. App.tsx
   * marks `RunView.awaiting.resolved` from this so the canvas's own
   * `ApprovalBar` — a second view of the same decision, PLAN §4.5 — disables
   * immediately. This is the one-gate-two-surfaces invariant: pending/
   * resolved state lives in the shared `RunView`, never local to a
   * component.
   */
  onGateResolved?: (decision: "approve" | "sendBack" | "reject") => void;
  /** Opens a past run from this chain's history (D8) — reachable from chat
   * without leaving the thread, same as it already is from the chains panel. */
  onOpenRun?: (runId: string) => void;
};

// Duplicated (in miniature) from ChainCanvas.tsx's own stateName/stateLabel:
// that file is owned by a different wave in this worktree, and neither
// helper is exported, so re-deriving a label from the wire shape here is
// less risk than reaching into a sibling's file.
function stateLabel(state: api.ChainNodeState): string {
  if (typeof state === "string") return state;
  const blocked =
    "kind" in state
      ? state.kind === "blocked"
        ? { met: state.met, required: state.required }
        : undefined
      : "blocked" in state
        ? state.blocked
        : undefined;
  if (blocked?.met !== undefined && blocked.required !== undefined) {
    return `waiting on ${blocked.met} of ${blocked.required}`;
  }
  const attempt = "kind" in state ? state.attempt : state.retrying;
  return `retry ${attempt ?? 1}`;
}

function resolvedLabel(decision: string): string {
  return decision === "approve" ? "Approved" : decision === "sendBack" ? "Sent back" : "Rejected";
}

function hhmm(at: number): string {
  return new Date(at).toTimeString().slice(0, 5);
}

/** Whichever role an outcome names as where the run stopped — "Re-run from
 *  here" targets it. `completed` and a plain `blocked` name no role. */
function stoppedAt(outcome: api.ChainOutcome): string | undefined {
  return "at" in outcome ? (Array.isArray(outcome.at) ? outcome.at[0] : outcome.at) : undefined;
}

/**
 * The chat live run card (D-h/D-j, PLAN §4.5): one message in the invoking
 * thread that mutates in place — never appended, never a flood. Chat is the
 * primary run surface (D-m): every action reachable on the canvas — node
 * state, transcript click-through, gate resolution, Stop, re-run — must be
 * reachable here too.
 */
export default function ChainRunCard({ run, projectHash, onTranscript, onGateResolved, onOpenRun }: Props) {
  // Collapsed by default (D8): invoking a chain must not flood the thread
  // with runs the user didn't ask about.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pending, setPending] = useState<"approve" | "sendBack" | "reject" | null>(null);
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState("");
  const [humanText, setHumanText] = useState("");
  const [submittingHuman, setSubmittingHuman] = useState(false);
  const [humanSubmitted, setHumanSubmitted] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A resolved gate collapses to a line in the card (PLAN §4.5) and the run
  // keeps going — but the decision itself should stay legible in place. The
  // shared `RunView.awaiting` only ever holds the *current* gate, so once
  // the next node event clears it (App.tsx's chain-event reducer does this
  // the moment a node starts its next turn) the decision would vanish. This
  // local log is purely a display history of past decisions; it never gates
  // whether a decision *can* be made — that authority stays in `run.awaiting`.
  const [history, setHistory] = useState<Array<{ role: string; decision: string; at: number }>>([]);
  const lastResolved = useRef<string | undefined>(undefined);

  useEffect(() => {
    const resolved = run.awaiting?.resolved;
    if (resolved && resolved !== lastResolved.current) {
      setHistory((h) => [...h, { role: run.awaiting!.from, decision: resolved, at: Date.now() }]);
      setSendingBack(false);
    }
    lastResolved.current = resolved;
  }, [run.awaiting?.resolved, run.awaiting?.from]);

  const lastHumanRole = useRef<string | undefined>(undefined);
  useEffect(() => {
    const role = run.awaitingHuman?.role;
    if (role !== lastHumanRole.current) {
      setHumanText("");
      setHumanSubmitted(false);
    }
    lastHumanRole.current = role;
  }, [run.awaitingHuman?.role]);

  const submitHuman = async () => {
    if (!run.awaitingHuman || !humanText.trim()) return;
    setSubmittingHuman(true);
    try {
      await api.resolveChainHuman(run.runId, run.awaitingHuman.role, humanText);
      setHumanSubmitted(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmittingHuman(false);
    }
  };

  const decide = async (decision: "approve" | "sendBack" | "reject") => {
    setPending(decision);
    try {
      await api.resolveChainGate(run.runId, decision, decision === "sendBack" ? note : undefined);
      onGateResolved?.(decision);
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(null);
    }
  };

  const stop = async () => {
    setStopping(true);
    try {
      await api.cancelChainRun(run.runId);
    } catch (err) {
      setError(String(err));
    } finally {
      setStopping(false);
    }
  };

  const rerun = async (fromRole?: string) => {
    setRerunning(fromRole ?? "");
    try {
      await api.rerunChainRun(projectHash, run.runId, fromRole, run.threadId);
    } catch (err) {
      setError(String(err));
    } finally {
      setRerunning(null);
    }
  };

  // Re-running a *past* run from the history section below is the same
  // operation as the card's own "Re-run" (D8) — just aimed at a different
  // run id, so it goes through the same `rerunChainRun` call rather than a
  // second path.
  const rerunFromHistory = async (runId: string, fromRole?: string) => {
    try {
      await api.rerunChainRun(projectHash, runId, fromRole, run.threadId);
    } catch (err) {
      setError(String(err));
    }
  };

  const elapsed = useElapsed(run.startedAt, run.endedAt);
  const roles = Array.from(new Set([...Object.keys(run.states ?? {}), ...Object.keys(run.nodes ?? {})]));
  const gate = run.awaiting;
  const stopRole = run.outcome ? stoppedAt(run.outcome) : undefined;

  return (
    // `Paper withBorder radius="sm"`, matching ReasoningBlock and ToolBlock —
    // the chat's existing block idiom. The original `ds-chain-run-card` class
    // was never defined in App.css (Wave I did not own that file), so the card
    // rendered as unstyled inline text in the thread.
    <Paper
      withBorder
      radius="sm"
      p="xs"
      data-testid="chain-run-card"
      // 2px accent left edge, per PLAN §4.5 — the existing active-thread
      // inset idiom ([App.css] `.ds-thread-tab.active`,
      // `box-shadow: inset 2px 0 0 var(--accent)`) reused as a value, not a
      // new class: that class also carries thread-tab-only layout
      // (max-width, flex, padding) that doesn't belong on a card, and this
      // component may not edit App.css to give it a class of its own.
      style={gate && !gate.resolved ? { boxShadow: "inset 2px 0 0 var(--accent)", paddingLeft: 8 } : undefined}
    >
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" ff="monospace" fw={600}>
          {run.chain}
        </Text>
        {!run.outcome && (
          <Badge size="sm" variant="light">
            Running · {elapsed}s
          </Badge>
        )}
      </Group>

      <Stack gap={4} my={4}>
        {roles.map((role) => {
          const node = run.nodes?.[role];
          const state = node?.state ?? run.states?.[role];
          return (
            <Group key={role} gap={6} wrap="nowrap" data-testid={`chain-run-card-node-${role}`}>
              <Text size="xs" fw={500}>
                {role}
              </Text>
              {state && (
                <Text size="xs" c="dimmed">
                  {stateLabel(state)}
                </Text>
              )}
              {!!node?.iterations && (
                <Text size="xs" c="dimmed">
                  turn {node.iterations}
                </Text>
              )}
              {node?.cost && (
                <Text size="xs" c="dimmed">
                  {node.cost.amount.toFixed(2)} {node.cost.currency}
                </Text>
              )}
              {node?.sessionId && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => onTranscript?.(node.sessionId!)}
                  data-testid={`chain-run-card-transcript-${role}`}
                >
                  View
                </Button>
              )}
            </Group>
          );
        })}
      </Stack>

      {history.map((h, i) => (
        <Text key={i} size="xs" c="dimmed" data-testid="chain-run-card-history">
          {resolvedLabel(h.decision)} · {hhmm(h.at)}
        </Text>
      ))}

      {gate && (
        <Stack gap={4} mt={4} data-testid="chain-run-card-gate">
          <Text size="xs" fw={600}>
            {gate.from} is waiting for you
          </Text>
          {gate.output && (
            <Text
              size="xs"
              data-testid="chain-run-card-gate-output"
              style={{ maxHeight: "10em", overflow: "auto", whiteSpace: "pre-wrap" }}
            >
              {gate.output}
            </Text>
          )}
          {run.nodes?.[gate.from]?.sessionId && (
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => onTranscript?.(run.nodes![gate.from]!.sessionId!)}
            >
              Show full transcript
            </Button>
          )}
          {gate.resolved ? (
            <Text size="xs" data-testid="chain-run-card-gate-resolved">
              {resolvedLabel(gate.resolved)}
            </Text>
          ) : sendingBack ? (
            <TextInput
              size="xs"
              autoFocus
              placeholder="Note"
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && note.trim()) void decide("sendBack");
              }}
              data-testid="chain-run-card-sendback-note"
            />
          ) : (
            <Group gap={6}>
              <Button size="xs" loading={pending === "approve"} disabled={!!pending} onClick={() => void decide("approve")}>
                Approve
              </Button>
              <Button size="xs" variant="default" disabled={!!pending} onClick={() => setSendingBack(true)}>
                Send back
              </Button>
              <Button
                size="xs"
                color="red"
                variant="light"
                loading={pending === "reject"}
                disabled={!!pending}
                onClick={() => void decide("reject")}
              >
                Reject
              </Button>
            </Group>
          )}
        </Stack>
      )}

      {run.awaitingHuman && (
        <Stack gap={4} mt={4} data-testid="chain-run-card-human">
          <Text size="xs" fw={600}>
            {run.awaitingHuman.role} needs your input
          </Text>
          <Text
            size="xs"
            data-testid="chain-run-card-human-instruction"
            style={{ maxHeight: "10em", overflow: "auto", whiteSpace: "pre-wrap" }}
          >
            {run.awaitingHuman.instruction}
          </Text>
          {humanSubmitted ? (
            <Text size="xs" data-testid="chain-run-card-human-submitted">
              Submitted
            </Text>
          ) : (
            <TextInput
              size="xs"
              autoFocus
              placeholder="Your response"
              value={humanText}
              onChange={(e) => setHumanText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && humanText.trim()) void submitHuman();
              }}
              rightSection={
                <Button size="compact-xs" disabled={!humanText.trim() || submittingHuman} onClick={() => void submitHuman()}>
                  Send
                </Button>
              }
              rightSectionWidth={50}
              data-testid="chain-run-card-human-input"
            />
          )}
        </Stack>
      )}

      {run.outcome && (
        <Group gap={6} mt={4}>
          <Text size="xs" c="dimmed">
            {outcomeText(run.outcome)}
          </Text>
          <Button size="compact-xs" variant="default" loading={rerunning === ""} onClick={() => void rerun(undefined)}>
            Re-run
          </Button>
          {stopRole && (
            <Button size="compact-xs" variant="default" loading={rerunning === stopRole} onClick={() => void rerun(stopRole)}>
              Re-run from here
            </Button>
          )}
        </Group>
      )}

      {!run.outcome && (
        <Button
          size="xs"
          color="red"
          variant="light"
          mt={4}
          leftSection={<IconPlayerStop size={14} />}
          loading={stopping}
          onClick={() => void stop()}
        >
          Stop
        </Button>
      )}

      {error && (
        <Alert variant="light" color="red" icon={<IconAlertTriangle size={14} />} mt={4} withCloseButton onClose={() => setError(null)}>
          <Text size="xs">{error}</Text>
        </Alert>
      )}

      {/* Past runs (D8): reachable from chat, not only the chains panel —
          collapsed by default so invoking a chain doesn't flood the thread. */}
      <Button
        size="compact-xs"
        variant="subtle"
        color="gray"
        mt={4}
        leftSection={historyOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        onClick={() => setHistoryOpen((v) => !v)}
        data-testid="chain-run-card-history-toggle"
      >
        Past runs
      </Button>
      {historyOpen && (
        <div data-testid="chain-run-card-history-section">
          <ChainRunHistory
            projectHash={projectHash}
            chainName={run.chain}
            onOpenRun={onOpenRun}
            onRerun={rerunFromHistory}
          />
        </div>
      )}
    </Paper>
  );
}
