import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from "d3-force";

/**
 * Force-directed view of Graphify's `graph.json`, with a filterable community
 * legend.
 *
 * Colour here is a *grouping* cue, not the identity channel — identity lives in
 * the legend (name + count), the hover label, and click-to-isolate. That
 * matters because a node-link graph is an all-pairs form: any two communities
 * can end up adjacent, and only four of the categorical hues clear the
 * all-pairs CVD floor. Slots beyond the documented eight are never given a
 * generated hue; they fold into a neutral "Other".
 */

// Categorical slots, dark steps, in fixed order. Never cycled, never extended.
const SERIES = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
];
const OTHER = "#8b93a1";
const OTHER_LABEL = "Other";
const SURFACE = "#14161a";

type RawNode = { id?: string | number; [key: string]: unknown };
type RawLink = { source?: unknown; target?: unknown; [key: string]: unknown };

type Node = {
  id: string;
  label: string;
  community: string;
  degree: number;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
};
type Link = { source: Node | string; target: Node | string };

/** Graphify's node attributes aren't pinned, so try the plausible keys. */
function communityOf(node: RawNode): string {
  for (const key of ["community", "group", "cluster", "module", "type", "kind", "category"]) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "ungrouped";
}

function labelOf(node: RawNode): string {
  for (const key of ["label", "name", "title", "id"]) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return String(node.id ?? "?");
}

const endpointId = (value: unknown): string =>
  typeof value === "object" && value !== null
    ? String((value as RawNode).id ?? "")
    : String(value ?? "");

export type GraphModel = {
  nodes: Node[];
  links: Link[];
  communities: { name: string; count: number; color: string }[];
};

export function buildModel(graph: { nodes?: unknown; links?: unknown; edges?: unknown }): GraphModel {
  const rawNodes = Array.isArray(graph.nodes) ? (graph.nodes as RawNode[]) : [];
  const rawLinks = Array.isArray(graph.links)
    ? (graph.links as RawLink[])
    : Array.isArray(graph.edges)
      ? (graph.edges as RawLink[])
      : [];

  const nodes: Node[] = rawNodes
    .filter((node) => node && node.id !== undefined && node.id !== null)
    .map((node) => ({
      id: String(node.id),
      label: labelOf(node),
      community: communityOf(node),
      degree: 0,
    }));
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const links: Link[] = [];
  for (const link of rawLinks) {
    const source = byId.get(endpointId(link.source));
    const target = byId.get(endpointId(link.target));
    // Drop dangling edges — d3-force throws on an unresolvable endpoint.
    if (!source || !target || source === target) continue;
    source.degree += 1;
    target.degree += 1;
    links.push({ source: source.id, target: target.id });
  }

  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.community, (counts.get(node.community) ?? 0) + 1);
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );

  // Colour follows the entity: a community keeps its hue no matter what the
  // filter hides, because the ranking is computed once over the whole graph.
  const colors = new Map<string, string>();
  ranked.forEach(([name], index) => {
    colors.set(name, index < SERIES.length ? SERIES[index] : OTHER);
  });

  const named = ranked.slice(0, SERIES.length).map(([name, count]) => ({
    name,
    count,
    color: colors.get(name)!,
  }));
  const foldedCount = ranked.slice(SERIES.length).reduce((sum, [, count]) => sum + count, 0);
  const communities = foldedCount
    ? [...named, { name: OTHER_LABEL, count: foldedCount, color: OTHER }]
    : named;

  // Everything past slot 8 answers to the single "Other" entry in the legend.
  const folded = new Set(ranked.slice(SERIES.length).map(([name]) => name));
  for (const node of nodes) {
    if (folded.has(node.community)) node.community = OTHER_LABEL;
  }

  return { nodes, links, communities };
}

const radiusOf = (node: Node) => Math.min(9, 3 + Math.sqrt(node.degree));

/**
 * Pull each node gently toward its community's centroid. Link structure alone
 * only clusters communities that happen to be densely interlinked; this makes
 * the grouping legible even when they aren't, which is the whole point of
 * colouring by community.
 */
function clusterForce(nodes: Node[]) {
  return (alpha: number) => {
    const sums = new Map<string, { x: number; y: number; n: number }>();
    for (const node of nodes) {
      const sum = sums.get(node.community) ?? { x: 0, y: 0, n: 0 };
      sum.x += node.x ?? 0;
      sum.y += node.y ?? 0;
      sum.n += 1;
      sums.set(node.community, sum);
    }
    const strength = alpha * 0.35;
    for (const node of nodes) {
      const sum = sums.get(node.community)!;
      const nodeAny = node as Node & { vx: number; vy: number };
      nodeAny.vx += (sum.x / sum.n - (node.x ?? 0)) * strength;
      nodeAny.vy += (sum.y / sum.n - (node.y ?? 0)) * strength;
    }
  };
}

export default function GraphView({ graph }: { graph: object }) {
  const model = useMemo(() => buildModel(graph), [graph]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<{ node: Node; x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef({ k: 1, x: 0, y: 0 });
  const fitRef = useRef<((width: number, height: number) => void) | null>(null);
  /** Once the reader pans or zooms, auto-fit stops taking the view from them. */
  const touchedRef = useRef(false);

  const colorFor = useMemo(
    () => new Map(model.communities.map((c) => [c.name, c.color])),
    [model],
  );

  // Filtering hides marks; it never re-runs the layout, so the surviving nodes
  // stay exactly where the reader last saw them.
  const visible = (node: Node) => !hidden.has(node.community);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Seed each community on its own arc so they start apart and the layout
    // settles into separated clusters rather than one undifferentiated ball.
    const order = new Map(model.communities.map((c, index) => [c.name, index]));
    const spread = Math.max(240, model.nodes.length * 0.7);
    model.nodes.forEach((node, index) => {
      const slot = order.get(node.community) ?? 0;
      const angle = (slot / Math.max(1, order.size)) * Math.PI * 2;
      node.x = Math.cos(angle) * spread + Math.cos(index) * 30;
      node.y = Math.sin(angle) * spread + Math.sin(index) * 30;
    });

    const simulation = forceSimulation<Node>(model.nodes)
      .force("link", forceLink<Node, Link>(model.links).id((n) => n.id).distance(26).strength(0.7))
      .force("charge", forceManyBody().strength(-55).distanceMax(360))
      .force("collide", forceCollide<Node>().radius((n) => radiusOf(n) + 1.5))
      .force("x", forceX().strength(0.03))
      .force("y", forceY().strength(0.03))
      .force("cluster", clusterForce(model.nodes));

    let frame = 0;
    let fitted = false;

    /** Frame the settled layout once, unless the reader has already moved. */
    const fitToView = (width: number, height: number) => {
      const xs = model.nodes.map((n) => n.x ?? 0);
      const ys = model.nodes.map((n) => n.y ?? 0);
      if (!xs.length) return;
      const pad = 24;
      const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs));
      const spanY = Math.max(1, Math.max(...ys) - Math.min(...ys));
      const k = Math.min(6, Math.max(0.2, Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY)));
      viewRef.current = {
        k,
        x: width / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * k,
        y: height / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * k,
      };
    };
    fitRef.current = fitToView;

    const draw = () => {
      const context = canvas.getContext("2d");
      if (!context) return;
      const { width, height } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }
      if (!fitted && simulation.alpha() < 0.05 && !touchedRef.current) {
        fitToView(width, height);
        fitted = true;
      }

      const { k, x: panX, y: panY } = viewRef.current;
      context.save();
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = SURFACE;
      context.fillRect(0, 0, width, height);
      context.translate(panX, panY);
      context.scale(k, k);

      // Recessive edges first, tinted by their source community.
      context.globalAlpha = 0.22;
      context.lineWidth = 1 / k;
      for (const link of model.links) {
        const source = link.source as Node;
        const target = link.target as Node;
        if (!visible(source) || !visible(target)) continue;
        context.beginPath();
        context.strokeStyle = colorFor.get(source.community) ?? OTHER;
        context.moveTo(source.x ?? 0, source.y ?? 0);
        context.lineTo(target.x ?? 0, target.y ?? 0);
        context.stroke();
      }

      context.globalAlpha = 1;
      for (const node of model.nodes) {
        if (!visible(node)) continue;
        context.beginPath();
        context.fillStyle = colorFor.get(node.community) ?? OTHER;
        context.arc(node.x ?? 0, node.y ?? 0, radiusOf(node), 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      simulation.stop();
    };
  }, [model, colorFor, hidden]);

  // --- pointer: hover labels, drag to pan, wheel to zoom -------------------

  const toGraph = (event: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const { k, x, y } = viewRef.current;
    return {
      x: (event.clientX - rect.left - x) / k,
      y: (event.clientY - rect.top - y) / k,
      screenX: event.clientX - rect.left,
      screenY: event.clientY - rect.top,
    };
  };

  const dragging = useRef<{ x: number; y: number } | null>(null);

  const onMove = (event: React.MouseEvent) => {
    const point = toGraph(event);
    if (dragging.current) {
      viewRef.current.x += event.clientX - dragging.current.x;
      viewRef.current.y += event.clientY - dragging.current.y;
      dragging.current = { x: event.clientX, y: event.clientY };
      touchedRef.current = true;
      setHover(null);
      return;
    }
    let closest: Node | null = null;
    let best = Infinity;
    for (const node of model.nodes) {
      if (!visible(node)) continue;
      const dx = (node.x ?? 0) - point.x;
      const dy = (node.y ?? 0) - point.y;
      const distance = dx * dx + dy * dy;
      // Hit target is bigger than the mark.
      const reach = (radiusOf(node) + 6) ** 2;
      if (distance < reach && distance < best) {
        best = distance;
        closest = node;
      }
    }
    setHover(closest ? { node: closest, x: point.screenX, y: point.screenY } : null);
  };

  const onWheel = (event: React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const view = viewRef.current;
    touchedRef.current = true;
    const next = Math.min(6, Math.max(0.2, view.k * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
    // Keep the point under the cursor fixed while zooming.
    view.x = mouseX - ((mouseX - view.x) / view.k) * next;
    view.y = mouseY - ((mouseY - view.y) / view.k) * next;
    view.k = next;
  };

  const toggle = (name: string) =>
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const allShown = hidden.size === 0;

  return (
    <div className="graph-view" data-testid="graph-view">
      <div className="graph-canvas-wrap">
        <canvas
          ref={canvasRef}
          data-testid="graph-canvas"
          onMouseMove={onMove}
          onMouseDown={(event) => (dragging.current = { x: event.clientX, y: event.clientY })}
          onMouseUp={() => (dragging.current = null)}
          onMouseLeave={() => {
            dragging.current = null;
            setHover(null);
          }}
          onDoubleClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            touchedRef.current = false;
            fitRef.current?.(rect.width, rect.height);
          }}
          onWheel={onWheel}
        />
        {hover && (
          <div
            className="graph-tooltip"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
            data-testid="graph-tooltip"
          >
            <strong>{hover.node.label}</strong>
            <span>
              {hover.node.community} · {hover.node.degree} edges
            </span>
          </div>
        )}
        <div className="graph-hint">drag to pan · scroll to zoom · double-click to fit</div>
      </div>

      <aside className="communities" data-testid="communities">
        <h4>Communities</h4>
        <label className="community all">
          <input
            type="checkbox"
            checked={allShown}
            onChange={() => setHidden(allShown ? new Set(model.communities.map((c) => c.name)) : new Set())}
            data-testid="community-all"
          />
          Select all
        </label>
        <div className="community-list">
          {model.communities.map((community) => (
            <label key={community.name} className="community">
              <input
                type="checkbox"
                checked={!hidden.has(community.name)}
                onChange={() => toggle(community.name)}
              />
              <span className="dot" style={{ background: community.color }} />
              <span className="community-name" title={community.name}>
                {community.name}
              </span>
              <span className="community-count">{community.count}</span>
            </label>
          ))}
        </div>
      </aside>
    </div>
  );
}
