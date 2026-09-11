import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from "@mantine/core";
import {
  IconPlus,
  IconDeviceFloppy,
  IconPlayerPlay,
  IconTrash,
  IconAlertTriangle,
  IconCheck,
  IconRefresh,
  IconArrowBackUp,
  IconMaximize,
  IconMinus,
  IconPlayerStop,
  IconSettings,
} from "@tabler/icons-react";
import * as api from "./api";
import { useElapsed } from "./useElapsed";
import { announceChainsChanged } from "./ChainsPanel";

// The chain builder canvas and its live run view — one surface in two states,
// per the design brief: run mode is the same graph "watching", not a
// navigation away from what was built.
//
// This is the one place the app draws its own graph rather than reaching for
// Mantine first: DESIGN.md's implementation stack has no graph-canvas
// primitive, and Tabler has no node/edge component. Everything inside a node
// (inputs, selects, buttons) is still Mantine.

const NODE_W = 190;
const NODE_H = 78;
const GRID = 20;

/** Zoom stays readable at both ends — a node is never a dot or a wall. */
const clampZoom = (zoom: number) => Math.min(2, Math.max(0.4, zoom));

/** What a new loop edge's mandatory cap starts at. Enough round trips for a
 *  critique loop to converge, few enough that a stuck one stops soon. */
const DEFAULT_MAX_ITERATIONS = 3;

type Point = { x: number; y: number };

/** A chain being edited. Same shape as the saved one, positions included. */
type Draft = api.Chain;

const emptyDraft = (): Draft => ({
  name: "",
  nodes: {},
  edges: [],
  entry: "",
  timeoutSeconds: 1800,
  retry: { maxAttempts: 2 },
  layout: {},
});

/** Where a node sits, defaulting to a readable left-to-right row. */
function positionOf(draft: Draft, role: string, index: number): Point {
  return draft.layout?.[role] ?? { x: 60 + index * (NODE_W + 90), y: 120 };
}

/**
 * Which edges close a cycle, by the same rule the backend validates with:
 * DFS back edges from `entry`. Kept in sync deliberately — the editor has to
 * demand a gate on exactly the edges the backend would reject without one.
 */
export function loopEdgeIndices(draft: Draft): Set<number> {
  const found = new Set<number>();
  const visited = new Set<string>();
  const open: string[] = [];
  const walk = (role: string) => {
    visited.add(role);
    open.push(role);
    draft.edges.forEach((edge, index) => {
      if (edge.from !== role) return;
      if (open.includes(edge.to)) found.add(index);
      else if (!visited.has(edge.to)) walk(edge.to);
    });
    open.pop();
  };
  if (draft.entry) walk(draft.entry);
  Object.keys(draft.nodes).forEach((role) => {
    if (!visited.has(role)) walk(role);
  });
  return found;
}

/**
 * A pre-run ceiling, not a billing estimate. Each role normally turns once;
 * roles in a gated cycle can turn up to that edge's cap. This deliberately
 * stays pure so the seed composer and live header cannot drift.
 */
export function turnCeiling(draft: Draft): number {
  const loopIndices = loopEdgeIndices(draft);
  const caps = new Map<string, number>();
  for (const index of loopIndices) {
    const edge = draft.edges[index];
    if (!edge.gate || !edge.maxIterations) continue;
    const reachable = new Set<string>();
    const visit = (role: string) => {
      if (reachable.has(role)) return;
      reachable.add(role);
      for (const next of draft.edges) {
        if (next.from === role && next.to !== edge.to) visit(next.to);
      }
    };
    visit(edge.to);
    for (const role of reachable) caps.set(role, Math.max(caps.get(role) ?? 1, edge.maxIterations));
  }
  return Object.keys(draft.nodes).reduce((total, role) => total + (caps.get(role) ?? 1), 0);
}

/**
 * Patches one field of `role`'s node. The Role field is uncontrolled and
 * renames on blur, so moving from Role into another field retires the old key
 * between render and event — and `{ ...d.nodes[role] }` on a key that is gone
 * does not throw, it fabricates a role-less, agent-less ghost node. An unknown
 * role is therefore a no-op, not a silent insert.
 */
export function applyNodePatch(
  draft: Draft,
  role: string,
  patch: Partial<Draft["nodes"][string]>
): Draft {
  const node = draft.nodes[role];
  if (!node) return draft;
  return { ...draft, nodes: { ...draft.nodes, [role]: { ...node, ...patch } } };
}

/** The first thing wrong with this draft, or null. Mirrors `Chain::validate`. */
export function draftProblem(draft: Draft): string | null {
  if (!draft.name.trim()) return "Give the chain a name before saving.";
  if (Object.keys(draft.nodes).length === 0) return "Add at least one node.";
  if (!draft.nodes[draft.entry]) return "Pick which node the chain starts at.";
  // Keyed, not `n.role`: the map key *is* the role, and a node whose `role`
  // field went missing is precisely the case that used to report itself as
  // "undefined has no agent bound to it".
  const missingAgent = Object.entries(draft.nodes).find(([, n]) => !n.agent);
  if (missingAgent) return `${missingAgent[0]} has no agent bound to it.`;
  const loops = loopEdgeIndices(draft);
  for (const index of loops) {
    const edge = draft.edges[index];
    if (!edge.gate) {
      return `The loop back to ${edge.to} needs a gate — a verify command or human approval.`;
    }
    if (!edge.maxIterations || edge.maxIterations < 1) {
      return `The loop back to ${edge.to} needs a maximum iteration count.`;
    }
  }
  return null;
}

type Props = {
  projectHash: string;
  /** Null when building a new chain. */
  chainName: string | null;
  /** Installed agents, from the same preflight normal detection uses (D16). */
  agents: { id: string; name: string }[];
  /** Named verify commands available as gates (D8). */
  verifyCommands: string[];
  /** Runs this chain on the active thread; absent when there is no thread. */
  onRun?: (name: string, seed: string) => void;
  /** The shell owns transcript navigation; the canvas only names the session. */
  onTranscript?: (sessionId: string) => void;
  /** Live run state, when this chain is the one running. */
  run?: RunView | null;
  /**
   * Fired after this canvas successfully resolves the pending gate. The shell
   * owns the pending/resolved flag so the chat card and this bar are two views
   * of one decision (PLAN §4.5) — without this the canvas could resolve a gate
   * the card still believes is open.
   */
  onGateResolved?: (decision: "approve" | "sendBack" | "reject") => void;
};

export type RunView = {
  runId: string;
  chain?: string;
  seed?: string;
  startedAt?: string;
  endedAt?: string | null;
  states: Record<string, api.ChainNodeState>;
  nodes?: Record<string, {
    state: api.ChainNodeState;
    sessionId?: string | null;
    startedAt?: string;
    endedAt?: string | null;
    iterations?: number;
    cost?: { amount: number; currency: string } | null;
    taskCalls?: Array<{ title: string; status: "running" | "done" | "failed"; result?: string }>;
  }>;
  awaiting: { from: string; to: string; output?: string; resolved?: "approve" | "sendBack" | "reject" } | null;
  outcome: api.ChainOutcome | null;
};

export default function ChainCanvas({
  projectHash,
  chainName,
  agents,
  verifyCommands,
  onRun,
  onTranscript,
  run,
  onGateResolved,
}: Props) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingEdge, setEditingEdge] = useState<number | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // What is actually on disk for this canvas, so Run never fires a chain the
  // user can no longer see. Renaming and saving used to leave the Run button
  // pointing at `chainName` — the name the tab was opened under — so Save-as
  // then Run silently ran the *old* chain.
  const persisted = useRef<string | null>(null);
  // The last saved (or loaded) draft, as JSON, so a dirty indicator can tell
  // an in-progress edit from a freshly opened or just-saved chain without a
  // second copy of the whole draft in state.
  const savedSnapshot = useRef<string>(JSON.stringify(emptyDraft()));
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [models, setModels] = useState<api.ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [seedComposer, setSeedComposer] = useState(false);
  const [seed, setSeed] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [stopping, setStopping] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  // addNode's uniqueness check has to see additions that haven't committed
  // yet — two adds fired before React re-renders both used to read the same
  // stale `draft.nodes` and pick the same "step" role, so the second silently
  // overwrote the first. This ref is kept in sync with `draft.nodes` on every
  // render and reserved synchronously inside addNode itself.
  const nodesRef = useRef(draft.nodes);
  nodesRef.current = draft.nodes;

  // Editing is disabled while this chain is running — the canvas is watching,
  // not building.
  const watching = !!run && !run.outcome;

  useEffect(() => {
    if (!chainName) {
      setDraft(emptyDraft());
      return;
    }
    let live = true;
    api
      .listChains(projectHash)
      .then((chains) => {
        const found = chains.find((c) => c.name === chainName);
        if (live && found) {
          setDraft(found);
          persisted.current = found.name;
          savedSnapshot.current = JSON.stringify(found);
          // History is advisory here: a missing or unreadable record never
          // blocks a test run, it simply leaves the composer empty.
          void api.listChainRuns(projectHash, found.name).then((runs) => {
            const latest = runs
              .slice()
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
            if (live && latest?.seed) setSeed(latest.seed);
          }).catch(() => undefined);
        }
      })
      .catch((err) => live && setError(String(err)));
    return () => {
      live = false;
    };
  }, [projectHash, chainName]);

  // The open node's agent decides which models are offerable, so the list is
  // re-read whenever that changes — the same `list_models` probe the chat
  // composer's picker uses.
  const editingAgent = editing ? draft.nodes[editing]?.agent : undefined;
  useEffect(() => {
    if (!editingAgent) {
      setModels([]);
      setModelsLoading(false);
      return;
    }
    let live = true;
    setModelsLoading(true);
    api
      .listModels(projectHash, editingAgent)
      .then((state) => live && setModels(state.models))
      .catch(() => live && setModels([]))
      .finally(() => live && setModelsLoading(false));
    return () => {
      live = false;
    };
  }, [projectHash, editingAgent]);

  const roles = useMemo(() => Object.keys(draft.nodes), [draft.nodes]);
  const loops = useMemo(() => loopEdgeIndices(draft), [draft]);
  const problem = draftProblem(draft);
  const ceiling = useMemo(() => turnCeiling(draft), [draft]);
  // Compared against a JSON snapshot rather than a boolean flag so any edit —
  // rename, drag, gate change — trips it, and a Save (or a fresh load) clears
  // it the same way.
  const dirty = JSON.stringify(draft) !== savedSnapshot.current;
  const nodeCount = roles.length;
  const reportedCosts = Object.entries(run?.nodes ?? {}).flatMap(([role, value]) =>
    value.cost ? [{ role, ...value.cost }] : []
  );
  const costTotals = reportedCosts.reduce<Record<string, number>>((totals, cost) => {
    totals[cost.currency] = (totals[cost.currency] ?? 0) + cost.amount;
    return totals;
  }, {});
  const elapsed = useElapsed(run?.startedAt, run?.endedAt);

  const positions = useMemo(() => {
    const out: Record<string, Point> = {};
    roles.forEach((role, index) => {
      out[role] = positionOf(draft, role, index);
    });
    return out;
  }, [draft, roles]);

  const addNode = () => {
    // Reserve the role against nodesRef, not `draft.nodes` — the latter is
    // this render's committed state, which two adds fired before a re-render
    // both see unchanged, so both used to pick "step" and the second
    // silently clobbered the first (see nodesRef's comment above).
    let role = "step";
    let n = 1;
    while (nodesRef.current[role]) role = `step-${++n}`;
    const index = Object.keys(nodesRef.current).length;
    nodesRef.current = { ...nodesRef.current, [role]: { role, guideline: "", agent: agents[0]?.id ?? "" } };
    setDraft((d) => ({
      ...d,
      nodes: {
        ...d.nodes,
        [role]: { role, guideline: "", agent: agents[0]?.id ?? "" },
      },
      entry: d.entry || role,
      layout: { ...d.layout, [role]: positionOf(d, role, index) },
    }));
    setEditing(role);
  };

  const renameNode = (from: string, to: string) => {
    if (!to || from === to || draft.nodes[to]) return;
    setDraft((d) => {
      const nodes = { ...d.nodes };
      nodes[to] = { ...nodes[from], role: to };
      delete nodes[from];
      const layout = { ...d.layout };
      if (layout[from]) {
        layout[to] = layout[from];
        delete layout[from];
      }
      return {
        ...d,
        nodes,
        layout,
        entry: d.entry === from ? to : d.entry,
        edges: d.edges.map((e) => ({
          ...e,
          from: e.from === from ? to : e.from,
          to: e.to === from ? to : e.to,
        })),
      };
    });
    setEditing(to);
  };

  const removeNode = (role: string) => {
    setDraft((d) => {
      const nodes = { ...d.nodes };
      delete nodes[role];
      const layout = { ...d.layout };
      delete layout[role];
      const remaining = Object.keys(nodes);
      return {
        ...d,
        nodes,
        layout,
        edges: d.edges.filter((e) => e.from !== role && e.to !== role),
        entry: d.entry === role ? (remaining[0] ?? "") : d.entry,
      };
    });
    setEditing(null);
  };

  /** Clicking a second node completes the connection started by the first. */
  const connect = (to: string) => {
    if (!connectFrom || connectFrom === to) {
      setConnectFrom(null);
      return;
    }
    const exists = draft.edges.some((e) => e.from === connectFrom && e.to === to);
    if (!exists) {
      setDraft((d) => ({ ...d, edges: [...d.edges, { from: connectFrom, to }] }));
    }
    setConnectFrom(null);
  };

  const save = async () => {
    const found = draftProblem(draft);
    if (found) {
      setError(found);
      return;
    }
    try {
      await api.saveChain(projectHash, draft);
      persisted.current = draft.name;
      savedSnapshot.current = JSON.stringify(draft);
      announceChainsChanged();
      setError(null);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(String(err));
    }
  };

  // ------------------------------------------------------------ pan and zoom

  const panning = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.target !== surface.current) return;
    // Clicking empty canvas abandons a half-drawn connection. Esc does the
    // same, but a mouse-only user should never need the keyboard to back out.
    setConnectFrom(null);
    panning.current = { x: event.clientX - view.x, y: event.clientY - view.y };
    surface.current?.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!panning.current) return;
    setView((v) => ({
      ...v,
      x: event.clientX - panning.current!.x,
      y: event.clientY - panning.current!.y,
    }));
  };
  const onPointerUp = () => {
    panning.current = null;
  };
  /** Zoom on a modifier, pan otherwise — a plain wheel should still move the
   *  canvas, since a mouse-only user has no other way to reach a node that is
   *  off-screen below. */
  const onWheel = (event: React.WheelEvent) => {
    if (event.ctrlKey || event.metaKey) {
      const rect = surface.current?.getBoundingClientRect();
      const cursorX = rect ? event.clientX - rect.left : 0;
      const cursorY = rect ? event.clientY - rect.top : 0;
      setView((v) => {
        const zoom = clampZoom(v.zoom - event.deltaY * 0.002);
        // Anchor on the point under the cursor, not the plane origin: hold
        // (cursor - pan) / zoom constant across the change so whatever was
        // under the pointer stays there instead of sliding away.
        const scale = zoom / v.zoom;
        return { zoom, x: cursorX - (cursorX - v.x) * scale, y: cursorY - (cursorY - v.y) * scale };
      });
      return;
    }
    setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
  };

  /** Toolbar zoom, for a mouse with no modifier keys in reach. */
  const zoomBy = (delta: number) =>
    setView((v) => ({ ...v, zoom: clampZoom(v.zoom + delta) }));

  /** Frames every node — the double-click gesture the codebase map already
   *  uses. A fixed zoom of 1 parked the top-left node at (40, 40) regardless
   *  of the graph's actual extent, so half a wide chain rendered off-screen;
   *  this scales to the surface's real measured size instead. */
  const fit = useCallback(() => {
    const points = Object.values(positions);
    if (points.length === 0) {
      setView({ x: 0, y: 0, zoom: 1 });
      return;
    }
    const minX = Math.min(...points.map((p) => p.x));
    const minY = Math.min(...points.map((p) => p.y));
    const maxX = Math.max(...points.map((p) => p.x + NODE_W));
    const maxY = Math.max(...points.map((p) => p.y + NODE_H));
    const graphW = Math.max(maxX - minX, 1);
    const graphH = Math.max(maxY - minY, 1);
    const rect = surface.current?.getBoundingClientRect();
    const viewW = rect?.width || graphW;
    const viewH = rect?.height || graphH;
    const padding = 40;
    const zoom = clampZoom(Math.min((viewW - padding * 2) / graphW, (viewH - padding * 2) / graphH));
    setView({
      x: (viewW - graphW * zoom) / 2 - minX * zoom,
      y: (viewH - graphH * zoom) / 2 - minY * zoom,
      zoom,
    });
  }, [positions]);

  // Dragging a node writes straight into the layout, so position is saved
  // with the chain rather than being re-derived on every open.
  const dragging = useRef<{
    role: string;
    dx: number;
    dy: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);

  /** Below this, a pointer-down/up pair is a click, not a drag. Without the
   *  threshold every click on a node reads as a zero-distance drag and the
   *  node editor never opens — the whole surface becomes mouse-hostile. */
  const DRAG_SLOP = 4;

  const onNodePointerDown = (event: React.PointerEvent, role: string) => {
    if (watching) return;
    event.stopPropagation();
    const p = positions[role];
    dragging.current = {
      role,
      dx: event.clientX / view.zoom - p.x,
      dy: event.clientY / view.zoom - p.y,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
  };
  const onNodePointerMove = (event: React.PointerEvent) => {
    const drag = dragging.current;
    if (!drag) return;
    if (
      !drag.moved &&
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_SLOP
    ) {
      return;
    }
    drag.moved = true;
    const x = Math.round((event.clientX / view.zoom - drag.dx) / GRID) * GRID;
    const y = Math.round((event.clientY / view.zoom - drag.dy) / GRID) * GRID;
    setDraft((d) => ({ ...d, layout: { ...d.layout, [drag.role]: { x, y } } }));
  };
  const onNodePointerUp = () => {
    dragging.current = null;
  };

  const node = editing ? draft.nodes[editing] : null;
  const edge = editingEdge !== null ? draft.edges[editingEdge] : null;

  return (
    <div className="ds-chain-canvas-wrap" data-testid="chain-canvas">
      <div className="ds-chain-toolbar">
        <TextInput
          size="xs"
          placeholder="Chain name"
          aria-label="Chain name"
          value={draft.name}
          disabled={watching}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          data-testid="chain-name"
          style={{ width: 200 }}
        />
        <Button
          size="xs"
          variant="default"
          leftSection={<IconPlus size={14} />}
          onClick={addNode}
          disabled={watching}
          data-testid="chain-add-node"
        >
          Node
        </Button>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconDeviceFloppy size={14} />}
          onClick={() => void save()}
          disabled={watching}
          data-testid="chain-save"
        >
          {saved ? "Saved" : "Save"}
        </Button>
        {dirty && !watching && (
          <Text size="xs" c="dimmed" data-testid="chain-dirty">
            Unsaved changes
          </Text>
        )}
        {onRun && persisted.current && (
          <Tooltip
            label={
              persisted.current === draft.name
                ? `Test run ${draft.name}`
                : "Save this chain before starting a test run"
            }
          >
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlayerPlay size={14} />}
              onClick={() => setSeedComposer(true)}
              disabled={watching || persisted.current !== draft.name}
            >
              Test run
            </Button>
          </Tooltip>
        )}
        <Tooltip label="Zoom out">
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            onClick={() => zoomBy(-0.2)}
            aria-label="Zoom out"
          >
            <IconMinus size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Zoom in">
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            onClick={() => zoomBy(0.2)}
            aria-label="Zoom in"
            data-testid="chain-zoom-in"
          >
            <IconPlus size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Fit to view">
          <ActionIcon size="sm" variant="subtle" color="gray" onClick={fit} aria-label="Fit to view">
            <IconMaximize size={14} />
          </ActionIcon>
        </Tooltip>
        {connectFrom && (
          <Group gap={6}>
            <Text size="xs" c="dimmed">
              Click a node to connect from <b>{connectFrom}</b>
            </Text>
            <Button size="compact-xs" variant="subtle" onClick={() => setConnectFrom(null)}>
              Cancel
            </Button>
          </Group>
        )}
        {watching && (
          <Group gap="xs">
            <Badge size="sm" variant="light">Running · {elapsed}s · turn up to {ceiling}</Badge>
            <Button size="xs" color="red" variant="light" leftSection={<IconPlayerStop size={14} />} loading={stopping}
              onClick={async () => { setStopping(true); try { await api.cancelChainRun(run!.runId); } catch (err) { setError(String(err)); } finally { setStopping(false); } }}>
              Stop
            </Button>
          </Group>
        )}
        {!watching && <Button size="xs" variant="subtle" leftSection={<IconSettings size={14} />} onClick={() => setShowSettings((open) => !open)}>Run settings</Button>}
      </div>

      {showSettings && !watching && (
        <Group className="ds-chain-settings" gap="sm" px="sm" pb="sm">
          <NumberInput label="Timeout (seconds)" min={1} value={draft.timeoutSeconds} onChange={(value) => setDraft((d) => ({ ...d, timeoutSeconds: Number(value) || 1 }))} />
          <NumberInput label="Retry attempts" min={1} value={draft.retry.maxAttempts} onChange={(value) => setDraft((d) => ({ ...d, retry: { maxAttempts: Number(value) || 1 } }))} />
          <NumberInput label="Max parallel" description="0 = unbounded" min={0} value={draft.maxParallel ?? 0} onChange={(value) => setDraft((d) => ({ ...d, maxParallel: Number(value) || 0 }))} />
        </Group>
      )}

      {run?.awaiting && (
        <ApprovalBar
          run={run}
          onError={setError}
          onTranscript={onTranscript}
          onResolved={onGateResolved}
        />
      )}
      {run?.outcome && <OutcomeBar outcome={run.outcome} />}
      {reportedCosts.length > 0 && <Text className="ds-chain-cost" size="xs">Partial reported run cost ({reportedCosts.map(({ role }) => role).join(", ")}): {Object.entries(costTotals).map(([currency, amount]) => `${amount.toFixed(2)} ${currency}`).join("; ")}</Text>}

      <div
        ref={surface}
        className="ds-chain-surface"
        onPointerDown={onPointerDown}
        onPointerMove={(e) => {
          onPointerMove(e);
          onNodePointerMove(e);
        }}
        onPointerUp={() => {
          onPointerUp();
          onNodePointerUp();
        }}
        onWheel={onWheel}
        onDoubleClick={fit}
        onKeyDown={(e) => e.key === "Escape" && setConnectFrom(null)}
        tabIndex={0}
        role="application"
        aria-label="Chain graph"
      >
        {/* Overlaid, not stacked in flow: this used to sit between the
            toolbar and the surface, so every toggle resized the surface
            underneath it and shifted what was visible. */}
        {(error || problem) && (!watching || !!error) && (
          <Alert
            variant="light"
            color={error ? "red" : "yellow"}
            icon={<IconAlertTriangle size={14} />}
            className="ds-chain-problem-overlay"
            withCloseButton={!!error}
            onClose={() => setError(null)}
            data-testid="chain-problem"
          >
            <Text size="xs">{error ?? problem}</Text>
          </Alert>
        )}
        <div
          className="ds-chain-plane"
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
          }}
        >
          <svg className="ds-chain-edges" aria-hidden="true">
            <defs>
              <marker
                id="chain-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong, var(--border))" />
              </marker>
            </defs>
            {draft.edges.map((e, index) => {
              const from = positions[e.from];
              const to = positions[e.to];
              if (!from || !to) return null;
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={edgePath(from, to, loops.has(index))}
                  className="ds-chain-edge"
                  data-loop={loops.has(index) || undefined}
                  markerEnd="url(#chain-arrow)"
                />
              );
            })}
          </svg>

          {draft.edges.map((e, index) => {
            const from = positions[e.from];
            const to = positions[e.to];
            if (!from || !to) return null;
            const mid = edgeMidpoint(from, to, loops.has(index));
            const needsGate = loops.has(index) && !e.gate;
            return (
              <button
                key={`gate-${e.from}-${e.to}`}
                type="button"
                className="ds-chain-gate"
                data-needs-gate={needsGate || undefined}
                style={{ left: mid.x, top: mid.y }}
                disabled={watching}
                onClick={() => setEditingEdge(index)}
                aria-label={`Edge ${e.from} to ${e.to}${e.gate ? "" : ", no gate"}`}
              >
                {e.gate?.type === "verify" ? (
                  <IconCheck size={12} />
                ) : e.gate?.type === "approval" ? (
                  <IconArrowBackUp size={12} />
                ) : needsGate ? (
                  <IconAlertTriangle size={12} />
                ) : (
                  <IconRefresh size={12} style={{ opacity: 0.5 }} />
                )}
              </button>
            );
          })}

          {roles.map((role) => {
            const p = positions[role];
            const nodeRun = run?.nodes?.[role];
            const state = nodeRun?.state ?? run?.states[role];
            const agentName = agents.find((a) => a.id === draft.nodes[role].agent)?.name ?? draft.nodes[role].agent;
            /** Shared by the click and the keyboard: connect, open the
             *  transcript while watching, or open the editor. */
            const activate = () => {
              if (connectFrom) connect(role);
              else if (watching && nodeRun?.sessionId) onTranscript?.(nodeRun.sessionId);
              else if (!watching) setEditing(role);
            };
            return (
              <div
                key={role}
                className="ds-chain-node"
                data-state={stateName(state)}
                data-entry={draft.entry === role || undefined}
                data-connecting={connectFrom === role || undefined}
                style={{ left: p.x, top: p.y, width: NODE_W }}
                onPointerDown={(e) => onNodePointerDown(e, role)}
                onClick={() => {
                  // A click that dragged the node was a move, not a request
                  // to edit it.
                  if (dragging.current?.moved) return;
                  activate();
                }}
                // A double-click on a node used to bubble up to the surface's
                // own onDoubleClick (fit), so opening a node's editor also
                // yanked the viewport to a fresh fit.
                onDoubleClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    activate();
                  } else if ((e.key === "Delete" || e.key === "Backspace") && !watching) {
                    e.preventDefault();
                    removeNode(role);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`Node ${role}${agentName ? `, ${agentName}` : ""}`}
                data-testid={`chain-node-${role}`}
              >
                <div className="ds-chain-node-head">
                  <span className="ds-chain-node-role">{role}</span>
                  {draft.entry === role && (
                    <span className="ds-chain-node-entry">start</span>
                  )}
                </div>
                <div className="ds-chain-node-agent">
                  {agents.find((a) => a.id === draft.nodes[role].agent)?.name ??
                    draft.nodes[role].agent ??
                    "no agent"}
                  {draft.nodes[role].model && (
                    <span className="ds-chain-node-model">
                      {draft.nodes[role].model}
                    </span>
                  )}
                </div>
                <div className="ds-chain-node-guideline">
                  {draft.nodes[role].guideline || "No guideline yet"}
                </div>
                {state && <span className="ds-chain-node-state">{stateLabel(state)}</span>}
                {nodeRun?.iterations && <span className="ds-chain-node-meta">turn {nodeRun.iterations}</span>}
                {nodeRun?.cost && <span className="ds-chain-node-meta">{nodeRun.cost.amount.toFixed(2)} {nodeRun.cost.currency}</span>}
                {nodeRun?.taskCalls?.map((task, index) => <TaskCall key={`${task.title}-${index}`} task={task} />)}
                {!watching && (
                  <button
                    type="button"
                    className="ds-chain-node-port"
                    aria-label={`Connect from ${role}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setConnectFrom(role);
                    }}
                  >
                    →
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {roles.length === 0 && (
          <div className="ds-chain-empty">
            <Text size="sm" c="dimmed">
              An empty canvas. Add a node, bind it to an agent, and connect it to
              the next one.
            </Text>
          </div>
        )}
      </div>

      {/* Node editor — role, guideline, agent (D16's scoped picker). */}
      <Modal
        opened={seedComposer}
        onClose={() => setSeedComposer(false)}
        title="Test this chain"
        size="sm"
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">{nodeCount} {nodeCount === 1 ? "agent" : "agents"} · up to {ceiling} agent turns</Text>
          <TextInput label="Seed" value={seed} onChange={(event) => setSeed(event.currentTarget.value)} placeholder="What should this test do?" />
          <Group justify="flex-end"><Button variant="default" size="xs" onClick={() => setSeedComposer(false)}>Cancel</Button><Button size="xs" disabled={!seed.trim()} onClick={() => { onRun?.(persisted.current!, seed.trim()); setSeedComposer(false); }}>Start test</Button></Group>
        </Stack>
      </Modal>

      <Modal
        opened={!!node}
        onClose={() => setEditing(null)}
        title={`Node: ${editing ?? ""}`}
        size="md"
      >
        {node && editing && (
          <Stack gap="sm">
            <TextInput
              label="Role"
              description="What this step is called. Also how the next node refers to its output."
              defaultValue={editing}
              // `target`, not `currentTarget`: by the time a blur handler
              // runs, `currentTarget` can already be null, and reading it
              // throws hard enough to take the whole canvas down.
              onBlur={(e) => renameNode(editing, e.target.value.trim())}
              data-testid="node-role"
            />
            <Select
              label="Agent"
              description="Which installed agent runs this role."
              data={agents.map((a) => ({ value: a.id, label: a.name }))}
              value={node.agent || null}
              onChange={(value) =>
                value && setDraft((d) => applyNodePatch(d, editing, { agent: value }))
              }
              data-testid="node-agent"
            />
            <Select
              label="Model"
              description="Which model that agent runs on. Left empty, the node follows the thread's model."
              placeholder={modelsLoading ? "Loading models…" : models.length ? "Agent default" : "No models offered"}
              disabled={modelsLoading || !models.length}
              clearable
              // Agents offer well over a hundred models; an unfiltered list
              // is unscrollable in practice, the same reason the chat's
              // picker has a search box.
              searchable
              nothingFoundMessage="No model by that name"
              data={models.map((m) => ({ value: m.id, label: m.name }))}
              value={node.model ?? null}
              onChange={(value) =>
                setDraft((d) => applyNodePatch(d, editing, { model: value }))
              }
              data-testid="node-model"
            />
            <Textarea
              label="Guideline"
              description="How this role should act. Applied on every turn, on top of the original request and the previous step's output — retries start a fresh session but see the same upstream output."
              autosize
              minRows={3}
              value={node.guideline}
              onChange={(e) =>
                setDraft((d) => applyNodePatch(d, editing, { guideline: e.target.value }))
              }
              data-testid="node-guideline"
            />
            <Group justify="space-between">
              {/* A node that already is the entry says so. Disabling the
                  button instead read as broken next to a live Delete — the
                  state was communicated only by the control being dead. */}
              {draft.entry === editing ? (
                <Badge size="sm" variant="light" data-testid="node-is-entry">
                  Start of chain
                </Badge>
              ) : (
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={() => setDraft((d) => ({ ...d, entry: editing }))}
                >
                  Start here
                </Button>
              )}
              <Button
                size="xs"
                color="red"
                variant="light"
                leftSection={<IconTrash size={14} />}
                onClick={() => removeNode(editing)}
              >
                Delete node
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      {/* Edge editor — the edge is the single source of truth for what
          happens between two nodes, so its gate lives here and nowhere else. */}
      <Modal
        opened={!!edge}
        onClose={() => setEditingEdge(null)}
        title={edge ? `${edge.from} → ${edge.to}` : ""}
        size="md"
      >
        {edge && editingEdge !== null && (
          <Stack gap="sm">
            {loops.has(editingEdge) && (
              <Alert variant="light" color="yellow" icon={<IconAlertTriangle size={14} />}>
                <Text size="xs">
                  This edge loops back. It needs a gate and an iteration cap
                  before the chain can be saved.
                </Text>
              </Alert>
            )}
            <Select
              label="Gate"
              description="What has to happen before the run crosses this edge. On a loop, a passing gate ends the loop."
              data={[
                { value: "none", label: "None — pipe straight through" },
                { value: "verify", label: "Verify command" },
                { value: "approval", label: "Human approval" },
              ]}
              value={edge.gate?.type ?? "none"}
              onChange={(value) =>
                setDraft((d) => {
                  const edges = [...d.edges];
                  edges[editingEdge] = {
                    ...edges[editingEdge],
                    gate:
                      value === "verify"
                        ? { type: "verify", command: verifyCommands[0] ?? "" }
                        : value === "approval"
                          ? { type: "approval" }
                          : undefined,
                    // A loop edge needs a real cap in the model, not just a
                    // number shown in the field: saving with the default
                    // still on screen used to fail with "needs a maximum
                    // iteration count" while the input plainly read 3.
                    maxIterations: loops.has(editingEdge)
                      ? (edges[editingEdge].maxIterations ?? DEFAULT_MAX_ITERATIONS)
                      : edges[editingEdge].maxIterations,
                  };
                  return { ...d, edges };
                })
              }
              data-testid="edge-gate"
            />
            {edge.gate?.type === "verify" && (
              <Select
                label="Verify command"
                description="A named command from this project's settings. Palisade runs it and reads the exit code."
                data={verifyCommands}
                value={edge.gate.command || null}
                onChange={(value) =>
                  value &&
                  setDraft((d) => {
                    const edges = [...d.edges];
                    edges[editingEdge] = {
                      ...edges[editingEdge],
                      gate: { type: "verify", command: value },
                    };
                    return { ...d, edges };
                  })
                }
              />
            )}
            {loops.has(editingEdge) && (
              <NumberInput
                label="Maximum iterations"
                description="A hard backstop, whatever the gate says."
                min={1}
                value={edge.maxIterations ?? DEFAULT_MAX_ITERATIONS}
                onChange={(value) =>
                  setDraft((d) => {
                    const edges = [...d.edges];
                    edges[editingEdge] = {
                      ...edges[editingEdge],
                      maxIterations: Number(value) || 1,
                    };
                    return { ...d, edges };
                  })
                }
                data-testid="edge-cap"
              />
            )}
            <Button
              size="xs"
              color="red"
              variant="light"
              leftSection={<IconTrash size={14} />}
              onClick={() => {
                setDraft((d) => ({
                  ...d,
                  edges: d.edges.filter((_, i) => i !== editingEdge),
                }));
                setEditingEdge(null);
              }}
            >
              Delete edge
            </Button>
          </Stack>
        )}
      </Modal>
    </div>
  );
}

/** Docked, not modal: the graph stays visible while a human decides. */
function ApprovalBar({ run, onError, onTranscript, onResolved }: { run: RunView; onError: (message: string) => void; onTranscript?: (sessionId: string) => void; onResolved?: (decision: "approve" | "sendBack" | "reject") => void }) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"approve" | "sendBack" | "reject" | null>(null);
  if (!run.awaiting) return null;
  const resolved = run.awaiting.resolved;
  const decide = async (decision: "approve" | "sendBack" | "reject") => {
    setPending(decision);
    try {
      await api.resolveChainGate(run.runId, decision, decision === "sendBack" ? note : undefined);
      onResolved?.(decision);
    } catch (err) {
      onError(String(err));
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="ds-chain-approval" data-testid="chain-approval">
      <Text size="xs">
        <b>{run.awaiting.from}</b> is waiting for you.
      </Text>
      {run.awaiting.output && <Text className="ds-chain-approval-evidence" size="xs">{run.awaiting.output}</Text>}
      {run.nodes?.[run.awaiting.from]?.sessionId && <Button size="compact-xs" variant="subtle" onClick={() => onTranscript?.(run.nodes![run.awaiting!.from].sessionId!)}>View output</Button>}
      {resolved ? <Text size="xs">{resolved === "approve" ? "Approved" : resolved === "sendBack" ? "Sent back" : "Rejected"}</Text> : <>
      <TextInput
        size="xs"
        placeholder="Note (for send back)"
        aria-label="Send-back note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        style={{ flex: 1, minWidth: 160 }}
      />
      <Button size="xs" loading={pending === "approve"} disabled={!!pending} onClick={() => void decide("approve")}>
        Approve
      </Button>
      <Button
        size="xs"
        variant="default"
        loading={pending === "sendBack"} disabled={!!pending || !note.trim()} onClick={() => void decide("sendBack")}
      >
        Send back
      </Button>
      <Button
        size="xs"
        color="red"
        variant="light"
        loading={pending === "reject"} disabled={!!pending} onClick={() => void decide("reject")}
      >
        Reject
      </Button>
      </>}
    </div>
  );
}

/** Tier 0 only: an agent Task call, not fabricated nested-session monitoring. */
function TaskCall({ task }: { task: { title: string; status: "running" | "done" | "failed"; result?: string } }) {
  const [expanded, setExpanded] = useState(false);
  return <div className="ds-chain-task"><Button size="compact-xs" variant="subtle" onClick={() => setExpanded((open) => !open)}>{task.title} · {task.status}</Button>{expanded && task.result && <Text size="xs">{task.result}</Text>}</div>;
}

/** Colour is never the only signal — every outcome states its reason. */
function OutcomeBar({ outcome }: { outcome: api.ChainOutcome }) {
  const good = outcome.kind === "completed";
  return (
    <Alert
      variant="light"
      color={good ? "green" : "red"}
      icon={good ? <IconCheck size={14} /> : <IconAlertTriangle size={14} />}
      m="xs"
      data-testid="chain-outcome"
    >
      <Text size="xs">{outcomeText(outcome)}</Text>
    </Alert>
  );
}

export function outcomeText(outcome: api.ChainOutcome): string {
  switch (outcome.kind) {
    case "completed":
      return "Chain finished.";
    case "rejected":
      return `Rejected at ${outcome.at}.`;
    case "gateFailed":
      return `Stopped after ${outcome.at}: \`${outcome.command}\` did not pass.`;
    case "capReached":
      return `Stopped: the loop through ${outcome.at} hit its cap of ${outcome.maxIterations}.`;
    case "timedOut": {
      // A sub-minute budget rounded to "0-minute limit", which reads as a
      // bug rather than a setting.
      const limit =
        outcome.afterSeconds < 60
          ? `${outcome.afterSeconds}-second`
          : `${Math.round(outcome.afterSeconds / 60)}-minute`;
      return `Stopped at ${outcome.at}: the run passed its ${limit} limit.`;
    }
    case "retriesExhausted":
      return `Stopped at ${outcome.at} after ${outcome.attempts} attempts: ${outcome.message}`;
    case "cancelled":
      return `Stopped by you${outcome.at.length ? `: ${outcome.at.join(", ")}` : "."}`;
    case "blocked":
      return outcome.reason;
  }
}

function stateName(state: api.ChainNodeState | undefined): string | undefined {
  if (!state) return undefined;
  if (typeof state === "string") return state;
  if ("kind" in state) return state.kind;
  return "blocked" in state ? "blocked" : "retrying";
}

function stateLabel(state: api.ChainNodeState): string {
  if (typeof state !== "string") {
    const blocked = "kind" in state
      ? state.kind === "blocked" ? { met: state.met, required: state.required } : undefined
      : "blocked" in state ? state.blocked : undefined;
    if (blocked?.met !== undefined && blocked.required !== undefined) return `waiting on ${blocked.met} of ${blocked.required}`;
    const attempt = "kind" in state ? state.attempt : state.retrying;
    return `retry ${attempt ?? 1}`;
  }
  return state;
}

/** A forward edge is a straight line; a loop bows above so it can be read. */
function edgePath(from: Point, to: Point, loop: boolean): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  if (!loop) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const lift = Math.max(70, Math.abs(from.x - to.x) / 3);
  return `M ${from.x} ${y1} C ${from.x - lift} ${y1 - lift}, ${x2 + NODE_W + lift} ${y2 - lift}, ${x2 + NODE_W} ${y2}`;
}

function edgeMidpoint(from: Point, to: Point, loop: boolean): Point {
  if (loop) {
    return {
      x: (from.x + to.x + NODE_W) / 2,
      y: Math.min(from.y, to.y) - 26,
    };
  }
  return {
    x: (from.x + NODE_W + to.x) / 2 - 10,
    y: (from.y + to.y) / 2 + NODE_H / 2 - 10,
  };
}
