# Design brief: Agent Chain Builder UI (canvas + live run view)

Confirmed via `/impeccable shape` + `/impeccable document` (2026-08-23),
against the refreshed `DESIGN.md`. Governs tasks.md §9 (chain canvas
builder) and §10 (live DAG run view).

## 1. Job and audience
The builder (sole user today) assembles named, reusable multi-agent
pipelines without hand-managing separate threads. Reached deliberately via
a new `NavRail` icon in the agent-facing group (joins Specs, Codebase Map,
Run configurations, MCP Servers, Database). Operate mode: task completion,
not persuasion.

## 2. Outcome and proof
Build a chain, save it, invoke it (`|=` or as a thread's go-mode executor),
watch it run, resolve approval gates. A node's "passed" state traces to a
verify command's real exit code, never agent self-report. Real evidence
in-view: each node's actual session transcript, click-through.

## 3. Selected direction
- **Visual authority**: DESIGN.md's Dragon Fire Workbench, unmodified.
- **Structural pattern (binding)**: new `NavRail` icon -> opens a **Side
  Panel (head/body)** (`ds-panel-head`/`ds-panel-body`) listing saved
  chains + "New Chain" -> selecting one opens the canvas as a
  **center-workspace tab**. This mirrors DESIGN.md's Database panel
  pattern exactly, and its accompanying Don't is binding here: *"Don't put
  a heavy, edit-capable surface... inside a NavRail side panel — the panel
  finds things, a center-workspace tab is where they're worked on."* The
  sidebar stays list-only; all editing happens in the tab.
- **Presets**: per DESIGN.md's Governing Rule, the Chains panel is added
  once to the shared panel inventory and reflows under both Vibe and
  Editor presets via their existing `order` rules — no preset-specific UI.
- **Focal moment**: live node-highlight-on-execute is the One Accent Rule's
  clearest payoff. At rest the canvas is entirely neutral (charcoal cards,
  `--border` connectors); the instant a node executes it is the only
  accent-green thing on screen, styled like the Nav Rail Button's active
  treatment (`active-row` fill + accent edge) — reuse that language rather
  than inventing a third "this is live" treatment.
- **Implementation consequence**: the canvas is custom-built. DESIGN.md's
  Implementation Stack has no graph-canvas primitive (Mantine/Tabler don't
  cover it) — this is the one legitimate exception to "reach for Mantine
  first." Flag this gap back to `/impeccable document` once shipped.

## 4. Scope and boundaries
- Fidelity: full flow, production-ready. Both canvas and live run view.
- Built for larger graphs from v1: pan/zoom/fit-to-view, reusing the
  Codebase-map canvas's existing interaction language (`grab`/`grabbing`
  cursor, drag-to-pan, wheel-to-zoom, double-click-to-refit) — no new
  canvas convention invented.
- Untouched: three-column shell, NavRail's existing icon inventory/
  grouping, the Modal family (confirm/rename/delete), semantic tokens.
- Anti-goals: no fan-out/fan-in rendering (decisions.md D10); no second
  graph-canvas library; no force-directed physics (chain layout is
  user-placed, unlike Codebase-map's simulated layout).

## 5. States and ranges
- Content: 2-4 nodes typical, unbounded with pan/zoom beyond that.
- Sidebar: empty ("no chains yet" + New Chain) / populated list (standard
  tree/list-row contract: keyboard-operable, `surface-warm` hover).
- Canvas build states: empty canvas, node added, forward edge (plain
  line), loop edge (curved arrowhead back, gate/cap required before save
  — see spec's "Loop edge without a gate is invalid" scenario), inline
  validation error, saved.
- Run states per node: queued (neutral) -> executing (accent glow, Nav
  Rail Button-style active treatment) -> done (quiet success tint, past
  tense, not a persistent fill) / crashed-retrying (warn, retry count
  visible) / blocked (danger, pre-run agent-unavailable check).
- Run-level: paused-at-approval-gate (warn-tinted edge + docked
  approve/reject/send-back-with-note control, graph stays visible, no
  modal takeover), done, aborted-timeout/rejected/retries-exhausted
  (danger + explicit reason text — color is never the only signal, per
  the diff/badge components' existing rule).

## 6. Interaction and layout
- Sidebar: flat chain list + New Chain, `ds-panel-head` title, mirrors
  FileTree/DatabasePanel row conventions exactly.
- Canvas tab: full center-workspace width, `surface` background like
  Codebase-map. Nodes are cards (radius scale's "sm" step) showing role
  name, bound agent, guideline preview; click opens the node editor (role,
  guideline `Textarea`, agent `Select` sourced from registry preflight —
  decisions.md D16, a deliberate documented exception to detection-not-
  config, scoped to chain nodes only).
- Edges carry directional arrowheads; a gate renders as a small icon-chip
  on the edge itself — the edge is the single source of truth for "what
  happens between these two nodes," no separate sidebar form for it.
- Run mode is the same canvas toggled into a "watching" state (editing
  disabled), not a navigation away from what was built.
- Transitions: 150-200ms cross-fade/pulse on node-state change, matching
  the shell's own preset-flip timing (`200ms cubic-bezier(0.2,0,0,1)`).

## 7. Constraints and open decisions for the builder
- Platform: web/Tauri, no native concerns.
- Accessibility: keyboard-first per PRODUCT.md — node cards reachable via
  Tab in graph order, edge/gate editing reachable from its originating
  node. Canvas interactions are inherently mouse-first; this needs
  deliberate design, not an afterthought.
- Components: Mantine `Card`/`Select`/`Textarea`/`Badge`/`ActionIcon`,
  Tabler icons throughout, the documented `ds-panel-head`/`ds-panel-body`
  wrapper for the sidebar — no second wrapper invented.
- Left to the builder: exact node card dimensions, edge-routing algorithm
  (test against a 4-node loop before committing), the new rail icon's
  specific Tabler glyph.
