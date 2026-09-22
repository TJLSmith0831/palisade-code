import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Divider,
  Drawer,
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
  IconPencil,
  IconRobot,
  IconSettings,
} from "@tabler/icons-react";
import * as api from "./api";
import { useElapsed } from "./useElapsed";
import { announceChainsChanged } from "./ChainsPanel";
import { describeError } from "./errors";

// The chain builder canvas and its live run view — one surface in two states,
// per the design brief: run mode is the same graph "watching", not a
// navigation away from what was built.
//
// This is the one place the app draws its own graph rather than reaching for
// Mantine first: DESIGN.md's implementation stack has no graph-canvas
// primitive, and Tabler has no node/edge component. Everything inside a node
// (inputs, selects, buttons) is still Mantine.

/** A node card is a fixed box so edges have somewhere to anchor: the port
 *  sits on its right edge at half NODE_H. The height is the card's resting
 *  size — head, agent line, two guideline lines — so a card that grows with
 *  run state simply hangs below its anchor. */
const NODE_W = 220;
const NODE_H = 84;
/** Drag snap and the dot grid drawn on the surface share one pitch, so a
 *  dropped node always lands on a visible dot. */
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
 * The widest fan-out tier the chain can actually dispatch at once — how many
 * nodes could be ready in the same round, ignoring `maxParallel` (D13). A
 * layered BFS over forward (non-loop) edges only, matching the runner's own
 * barrier rule: a loop-closing edge never counts toward its target's forward
 * in-degree, so a loop head's width isn't held hostage by its own back edge.
 */
export function concurrentWidth(draft: Draft): number {
  const loopIndices = loopEdgeIndices(draft);
  const forwardIn = new Map<string, number>();
  for (const role of Object.keys(draft.nodes)) forwardIn.set(role, 0);
  draft.edges.forEach((edge, index) => {
    if (loopIndices.has(index)) return;
    forwardIn.set(edge.to, (forwardIn.get(edge.to) ?? 0) + 1);
  });
  let frontier = Object.keys(draft.nodes).filter((role) => (forwardIn.get(role) ?? 0) === 0);
  const remaining = new Map(forwardIn);
  const seen = new Set<string>();
  let width = frontier.length;
  while (frontier.length) {
    const next: string[] = [];
    for (const role of frontier) {
      seen.add(role);
      draft.edges.forEach((edge, index) => {
        if (edge.from !== role || loopIndices.has(index)) return;
        const left = (remaining.get(edge.to) ?? 0) - 1;
        remaining.set(edge.to, left);
        if (left === 0 && !seen.has(edge.to)) next.push(edge.to);
      });
    }
    width = Math.max(width, next.length);
    frontier = next;
  }
  return width;
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
  if (!draft.name.trim()) return "Give the playbook a name before saving.";
  if (Object.keys(draft.nodes).length === 0) return "Add at least one node.";
  if (!draft.nodes[draft.entry]) return "Pick which node the playbook starts at.";
  // Keyed, not `n.role`: the map key *is* the role, and a node whose `role`
  // field went missing is precisely the case that used to report itself as
  // "undefined has no agent bound to it".
  const missingAgent = Object.entries(draft.nodes).find(([, n]) => !n.agent);
  if (missingAgent) return `${missingAgent[0]} has no agent bound to it.`;
  const missingModel = Object.entries(draft.nodes).find(([, n]) => !n.model);
  if (missingModel) return `${missingModel[0]} has no model bound to it.`;
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
  /** Fired after a successful save, with the saved name — D15: the tab that
   *  built this chain adopts its identity, and stops opening a second tab
   *  beside its own "new chain" one. */
  onSaved?: (name: string) => void;
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
  onSaved,
  onTranscript,
  run,
  onGateResolved,
}: Props) {
  const [draft, setDraftNow] = useState<Draft>(emptyDraft);

  /**
   * The last few drafts, newest last, for Mod+Z.
   *
   * Delete and Backspace on a focused node removed it and every edge attached
   * to it immediately, with no undo, no confirm and no beforeunload — and
   * nodes are tabIndex={0}, so a stray Backspace while tabbing was a live way
   * to lose the most expensive thing a user builds by hand here.
   *
   * One mechanism rather than three: snapshotting inside the setter means
   * node deletes, edge deletes and accidental drags are all covered by the
   * same undo without a single call site opting in, and without a confirm
   * dialog in front of an action that is now cheap to reverse.
   */
  const undoStack = useRef<Draft[]>([]);
  const UNDO_DEPTH = 10;

  const setDraft = useCallback<React.Dispatch<React.SetStateAction<Draft>>>((update) => {
    setDraftNow((prev) => {
      const next = typeof update === "function" ? (update as (d: Draft) => Draft)(prev) : update;
      if (next === prev) return prev;
      // StrictMode invokes this updater twice with the same `prev`; the
      // identity check keeps the second pass from stacking a duplicate.
      if (undoStack.current[undoStack.current.length - 1] !== prev) {
        undoStack.current.push(prev);
        if (undoStack.current.length > UNDO_DEPTH) undoStack.current.shift();
      }
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    const previous = undoStack.current.pop();
    if (previous) setDraftNow(previous);
  }, []);
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
  /**
   * Whether the viewport is where the user put it.
   *
   * fit() ran only from the toolbar button and a double-click, so opening a
   * chain left nodes wherever the last session's pan happened to leave them —
   * observed at 1280px with the `reviewer` node entirely outside the pane.
   * Fitting on load and on resize fixes that, but it must not yank a viewport
   * the user has deliberately zoomed or panned, so anything that moves the
   * view by hand claims it and only fit() gives it back.
   */
  const viewIsUsers = useRef(false);
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
    // Switching chains is not an edit. Undoing across it would drop the user
    // into a chain they were never editing, so the history starts over.
    undoStack.current = [];
    if (!chainName) {
      setDraftNow(emptyDraft());
      return;
    }
    let live = true;
    api
      .listChains(projectHash)
      .then((chains) => {
        const found = chains.find((c) => c.name === chainName);
        if (live && found) {
          setDraftNow(found);
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
      .catch((err) => live && setError(describeError(err, { loading: "this playbook" })));
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
      .then((state) => {
        if (!live) return;
        setModels(state.models);
        // A model is required to save (no model = no node) — pick the
        // agent's first offered model the same way addNode picks the first
        // installed agent, so a freshly added node is savable without
        // forcing a manual choice when there's an obvious default.
        if (editing && state.models[0] && !nodesRef.current[editing]?.model) {
          setDraft((d) => applyNodePatch(d, editing, { model: state.models[0].id }));
        }
      })
      .catch(() => live && setModels([]))
      .finally(() => live && setModelsLoading(false));
    return () => {
      live = false;
    };
  }, [projectHash, editingAgent, editing]);

  const roles = useMemo(() => Object.keys(draft.nodes), [draft.nodes]);
  const loops = useMemo(() => loopEdgeIndices(draft), [draft]);
  const problem = draftProblem(draft);
  const ceiling = useMemo(() => turnCeiling(draft), [draft]);
  const width = useMemo(() => concurrentWidth(draft), [draft]);
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
      onSaved?.(draft.name);
      setError(null);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(describeError(err, { action: "save this playbook" }));
    }
  };

  /** Back to what is on disk (or to an empty canvas for a playbook that
   *  never was). Goes through the undo stack, so a discard is itself one
   *  Mod+Z away from being undone. */
  const discard = () => {
    setDraft(JSON.parse(savedSnapshot.current) as Draft);
    setEditing(null);
    setEditingEdge(null);
    setConnectFrom(null);
    setError(null);
  };

  // ------------------------------------------------------------ pan and zoom

  const panning = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent) => {
    if (event.target !== surface.current) return;
    // Clicking empty canvas abandons a half-drawn connection. Esc does the
    // same, but a mouse-only user should never need the keyboard to back out.
    setConnectFrom(null);
    viewIsUsers.current = true;
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
      viewIsUsers.current = true;
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
    viewIsUsers.current = true;
    setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
  };

  /** Toolbar zoom, for a mouse with no modifier keys in reach. */
  const zoomBy = (delta: number) => {
    viewIsUsers.current = true;
    setView((v) => ({ ...v, zoom: clampZoom(v.zoom + delta) }));
  };

  /** Frames every node — the double-click gesture the codebase map already
   *  uses. A fixed zoom of 1 parked the top-left node at (40, 40) regardless
   *  of the graph's actual extent, so half a wide chain rendered off-screen;
   *  this scales to the surface's real measured size instead. */
  const fit = useCallback(() => {
    viewIsUsers.current = false;
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
    // Fit, but never magnify: a one-node chain in a wide pane should sit at
    // its natural size rather than blowing up to fill the space.
    const zoom = clampZoom(
      Math.min(1, (viewW - padding * 2) / graphW, (viewH - padding * 2) / graphH)
    );
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

  /** Set on pointerup when the just-finished drag moved the node, and
   *  read-and-cleared by the click that follows it (D14). `dragging.current`
   *  itself can't serve this purpose: `onNodePointerUp` nulls it before the
   *  click fires (pointerup always precedes click), so a guard reading it at
   *  click time always saw `null`. Reset on the next pointerdown so an
   *  interrupted gesture (pointerup with no matching click) can't leave it
   *  stuck suppressing a later, unrelated click. */
  const justDragged = useRef(false);

  const onNodePointerDown = (event: React.PointerEvent, role: string) => {
    if (watching) return;
    event.stopPropagation();
    justDragged.current = false;
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
    if (dragging.current?.moved) justDragged.current = true;
    dragging.current = null;
  };

  /**
   * Fit the graph when a chain opens, and again whenever the pane resizes.
   *
   * Keyed on the set of node roles rather than on `positions`, which changes
   * on every drag — refitting mid-drag would fight the hand that is moving
   * the node. Both paths defer to viewIsUsers: once someone has zoomed or
   * panned, the canvas stops repositioning their view behind them.
   */
  const nodeRoles = Object.keys(draft.nodes).sort().join("\u0000");
  useEffect(() => {
    if (!nodeRoles) return;
    fit();
    // fit is recreated whenever positions change; depending on it here would
    // refit on every drag, which is exactly what this must not do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeRoles]);

  useEffect(() => {
    const el = surface.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!viewIsUsers.current) fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  /**
   * Mod+Z anywhere in the canvas.
   *
   * On the window rather than the canvas element because the thing a user
   * most wants to undo — a node deleted with Backspace — also removes the
   * element that had focus, so by the time the keystroke for the undo
   * arrives there is nothing inside the canvas holding it.
   */
  useEffect(() => {
    if (watching) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z" || !(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      // A text field has its own undo, and taking Mod+Z away from a half
      // typed guideline would be its own kind of data loss.
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || el?.isContentEditable) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, watching]);

  const node = editing ? draft.nodes[editing] : null;
  const edge = editingEdge !== null ? draft.edges[editingEdge] : null;

  return (
    <div className="ds-chain-canvas-wrap" data-testid="chain-canvas">
      {/* Ten controls in one wrapping row, every button variant="default",
          so "Test run" — which spends money — looked exactly like "Save",
          which writes a file. Four categories are now four groups, split by
          dividers: identity, authoring, execution, viewport. The status
          strings that used to sit between the buttons moved to their own
          line below, where they read as state rather than as something to
          click. */}
      <div className="ds-chain-toolbar">
        <TextInput
          size="xs"
          placeholder="Playbook name"
          aria-label="Playbook name"
          value={draft.name}
          disabled={watching}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          data-testid="chain-name"
          style={{ width: 200 }}
        />

        <Divider orientation="vertical" />

        <Group gap={6} wrap="nowrap" data-testid="chain-authoring-group">
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
          {!watching && (
            <Button
              size="xs"
              variant="subtle"
              leftSection={<IconSettings size={14} />}
              onClick={() => setShowSettings((open) => !open)}
            >
              Run settings
            </Button>
          )}
        </Group>

        {(onRun && persisted.current) || watching ? <Divider orientation="vertical" /> : null}

        <Group gap={6} wrap="nowrap" data-testid="chain-execution-group">
          {onRun && persisted.current && !watching && (
            <Tooltip
              label={
                persisted.current === draft.name
                  ? `Test run ${draft.name}`
                  : "Save this playbook before starting a test run"
              }
            >
              {/* The one action here that spends money and takes time. It is
                  the dominant action in this local decision, so it carries
                  the accent fill and nothing else in the row does. */}
              <Button
                size="xs"
                variant="filled"
                leftSection={<IconPlayerPlay size={14} />}
                onClick={() => setSeedComposer(true)}
                disabled={persisted.current !== draft.name}
                data-testid="chain-test-run"
              >
                Test run
              </Button>
            </Tooltip>
          )}
          {watching && (
            <Button
              size="xs"
              color="danger"
              variant="light"
              leftSection={<IconPlayerStop size={14} />}
              loading={stopping}
              onClick={async () => { setStopping(true); try { await api.cancelChainRun(run!.runId); } catch (err) { setError(describeError(err, { action: "stop this run" })); } finally { setStopping(false); } }}
            >
              Stop
            </Button>
          )}
        </Group>

        <Group gap={2} wrap="nowrap" ml="auto" data-testid="chain-viewport-group">
          <Tooltip label="Zoom out">
            <ActionIcon
              size="sm"
              variant="subtle"
              color="neutral"
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
              color="neutral"
              onClick={() => zoomBy(0.2)}
              aria-label="Zoom in"
              data-testid="chain-zoom-in"
            >
              <IconPlus size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Fit to view">
            <ActionIcon size="sm" variant="subtle" color="neutral" onClick={fit} aria-label="Fit to view">
              <IconMaximize size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </div>

      {/* State, not actions. Unsaved changes are not here: they dock at the
          bottom of the canvas with their own Save and Discard, so the one
          thing a user can lose is never a quiet line of text. */}
      {(nodeCount > 0 || connectFrom || watching) && (
        <div className="ds-chain-statusbar" data-testid="chain-statusbar">
          {watching && (
            <Badge size="sm" variant="light">
              Running · {elapsed}s · turn up to {ceiling}
            </Badge>
          )}
          {/* D13: states how wide the chain actually runs, so a user can tell
              sequential from parallel without running it. Scoped to this one
              line — no tier layout, no run-time grouping treatment. */}
          {nodeCount > 0 && (
            <Text size="xs" c="dimmed" data-testid="chain-width">
              Runs {width === 1 ? "1 node" : `up to ${width} nodes`} at once
              {!!draft.maxParallel && ` (capped at ${draft.maxParallel})`}
            </Text>
          )}
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
        </div>
      )}

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
        aria-label="Playbook graph"
        // The dot grid is painted on the surface, not the plane, so it never
        // scales its dots into blobs — it just follows the pan and re-pitches
        // with the zoom, the way a real drafting grid would.
        style={{
          backgroundPosition: `${view.x}px ${view.y}px`,
          backgroundSize: `${GRID * view.zoom}px ${GRID * view.zoom}px`,
        }}
      >
        {/* Overlaid, not stacked in flow: this used to sit between the
            toolbar and the surface, so every toggle resized the surface
            underneath it and shifted what was visible. */}
        {(error || problem) && (!watching || !!error) && (
          <Alert
            variant="light"
            color={error ? "danger" : "warn"}
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
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border)" />
              </marker>
            </defs>
            {draft.edges.map((e, index) => {
              const from = positions[e.from];
              const to = positions[e.to];
              if (!from || !to) return null;
              // Output flows down an edge while its source node is running,
              // so that edge — and only that edge — moves.
              const live =
                stateName(run?.nodes?.[e.from]?.state ?? run?.states[e.from]) === "executing";
              return (
                <path
                  key={`${e.from}->${e.to}`}
                  d={edgePath(from, to, loops.has(index))}
                  className="ds-chain-edge"
                  data-loop={loops.has(index) || undefined}
                  data-live={live || undefined}
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
                data-selected={editing === role || undefined}
                style={{ left: p.x, top: p.y, width: NODE_W }}
                onPointerDown={(e) => onNodePointerDown(e, role)}
                onClick={() => {
                  // A click that dragged the node was a move, not a request
                  // to edit it (D14).
                  if (justDragged.current) {
                    justDragged.current = false;
                    return;
                  }
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
                  <span className="ds-chain-node-glyph" aria-hidden="true">
                    <IconRobot size={13} />
                  </span>
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
                {state && (
                  <span className="ds-chain-node-state">
                    <span className="ds-chain-node-dot" aria-hidden="true" />
                    {stateLabel(state)}
                  </span>
                )}
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
          <div className="ds-chain-empty" data-testid="chain-canvas-empty">
            <Text size="sm" fw={600}>
              Start a playbook
            </Text>
            <Text size="xs" c="dimmed">
              Agents hand work to each other along edges; gates decide when
              a run may continue.
            </Text>
            {!watching && (
              <Button
                size="xs"
                variant="filled"
                leftSection={<IconPlus size={14} />}
                onClick={addNode}
                data-testid="chain-empty-add-node"
              >
                Add your first node
              </Button>
            )}
            <dl className="ds-chain-empty-terms">
              <dt>Node</dt>
              <dd>One role, bound to an installed agent and a model.</dd>
              <dt>Edge</dt>
              <dd>Click a node, then the node it hands its output to.</dd>
              <dt>Gate</dt>
              <dd>
                Pauses a run at an edge for a <code>verify</code> command or
                your approval.
              </dd>
              <dt>Loop</dt>
              <dd>An edge pointing back needs a gate and a maximum iteration count.</dd>
            </dl>
          </div>
        )}

        {/* Railway's "apply changes" bar: edits stage on the canvas and are
            written by one action, docked where the eye lands last. Save and
            Discard live here and nowhere else, so an unsaved canvas is never
            a quiet warning next to a row of unrelated buttons. */}
        {(dirty || saved) && !watching && (
          <div className="ds-chain-changes" data-testid="chain-changes-bar" role="status">
            {saved && !dirty ? (
              <Text size="xs" c="success" fw={500}>
                <IconCheck size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                Saved
              </Text>
            ) : (
              <>
                <Text size="xs" c="warn" fw={500} data-testid="chain-dirty">
                  <IconPencil size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                  Unsaved changes
                </Text>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="neutral"
                  onClick={discard}
                  data-testid="chain-discard"
                >
                  Discard
                </Button>
                <Button
                  size="compact-xs"
                  variant="filled"
                  leftSection={<IconDeviceFloppy size={12} />}
                  onClick={() => void save()}
                  data-testid="chain-save"
                >
                  Save
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Node editor — role, guideline, agent (D16's scoped picker). */}
      <Modal
        opened={seedComposer}
        onClose={() => setSeedComposer(false)}
        title="Test this playbook"
        size="sm"
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">{nodeCount} {nodeCount === 1 ? "agent" : "agents"} · up to {ceiling} agent turns</Text>
          <TextInput label="Seed" value={seed} onChange={(event) => setSeed(event.currentTarget.value)} placeholder="What should this test do?" />
          <Group justify="flex-end"><Button variant="default" size="xs" onClick={() => setSeedComposer(false)}>Cancel</Button><Button size="xs" disabled={!seed.trim()} onClick={() => { onRun?.(persisted.current!, seed.trim()); setSeedComposer(false); }}>Start test</Button></Group>
        </Stack>
      </Modal>

      <Drawer
        opened={!!node}
        onClose={() => setEditing(null)}
        title={`Node: ${editing ?? ""}`}
        position="right"
        size="sm"
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
              description="Which model that agent runs on. Required — a node with no model can't be saved."
              placeholder={modelsLoading ? "Loading models…" : models.length ? "Pick a model" : "No models offered"}
              disabled={modelsLoading || !models.length}
              // Agents offer well over a hundred models; an unfiltered list
              // is unscrollable in practice, the same reason the chat's
              // picker has a search box.
              searchable
              nothingFoundMessage="No model by that name"
              data={models.map((m) => ({ value: m.id, label: m.name }))}
              value={node.model ?? null}
              onChange={(value) =>
                value && setDraft((d) => applyNodePatch(d, editing, { model: value }))
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
                color="danger"
                variant="light"
                leftSection={<IconTrash size={14} />}
                onClick={() => removeNode(editing)}
              >
                Delete node
              </Button>
            </Group>
          </Stack>
        )}
      </Drawer>

      {/* Edge editor — the edge is the single source of truth for what
          happens between two nodes, so its gate lives here and nowhere else. */}
      <Drawer
        opened={!!edge}
        onClose={() => setEditingEdge(null)}
        title={edge ? `${edge.from} → ${edge.to}` : ""}
        position="right"
        size="sm"
      >
        {edge && editingEdge !== null && (
          <Stack gap="sm">
            {loops.has(editingEdge) && (
              <Alert variant="light" color="warn" icon={<IconAlertTriangle size={14} />}>
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
              color="danger"
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
      </Drawer>
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
      onError(describeError(err));
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
        color="danger"
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
      color={good ? "success" : "danger"}
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
      return "Playbook finished.";
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

/** A forward edge leaves and arrives horizontally — an S-curve between the
 *  two ports, with control points pulled far enough out that even a steep
 *  hop still reads as "output goes that way". A loop bows above so it can be
 *  read. Both curves are symmetric, so `edgeMidpoint` stays a plain average. */
function edgePath(from: Point, to: Point, loop: boolean): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  if (!loop) {
    const pull = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + pull} ${y1}, ${x2 - pull} ${y2}, ${x2} ${y2}`;
  }
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
