---
name: PalisadeCode
description: Cross-machine coding-agent IDE — an 11-panel activity rail, CodeMirror editor, git diff, terminal, and a live codebase-map graph around an agent chat/diff console.
colors:
  bg: "oklch(18% 0.005 250)"
  chrome-bg: "oklch(15% 0.004 250)"
  editor-bg: "oklch(20% 0.005 250)"
  surface: "oklch(22% 0.006 250)"
  surface-warm: "oklch(26% 0.008 250)"
  active-row: "oklch(24% 0.020 var(--accent-hue, 145))"
  fg: "oklch(96% 0.003 250)"
  muted: "oklch(66% 0.012 250)"
  border: "oklch(30% 0.010 250)"
  accent: "oklch(88% 0.21 var(--accent-hue, 145))"
  accent-on: "oklch(20% 0.03 var(--accent-hue, 145))"
  twilight-glow: "oklch(18% 0.03 var(--accent-hue, 145))"
  success: "oklch(72% 0.15 160)"
  warn: "oklch(76% 0.15 65)"
  danger: "oklch(64% 0.22 25)"
  danger-on: "oklch(98% 0.02 25)"
  code-comment: "oklch(66% 0.012 250)"
  code-text: "oklch(96% 0.003 250)"
  code-keyword: "oklch(73% 0.17 280)"
  code-atom: "oklch(72% 0.15 160)"
  code-number: "oklch(78% 0.12 95)"
  code-string: "oklch(72% 0.11 50)"
  code-regexp: "oklch(72% 0.15 25)"
  code-variable: "oklch(82% 0.04 240)"
  code-variable-def: "oklch(82% 0.08 240)"
  code-type: "oklch(75% 0.1 180)"
  code-property: "oklch(82% 0.04 240)"
  code-function: "oklch(82% 0.11 95)"
  code-meta: "oklch(66% 0.01 250)"
  code-invalid: "oklch(64% 0.22 25)"
typography:
  body:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "11px"
    fontWeight: 600
  mono:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace'
    fontSize: "12px"
    fontWeight: 400
  monoSmall:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace'
    fontSize: "10px"
    fontWeight: 400
  monoMicro:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace'
    fontSize: "9.5px"
    fontWeight: 600
  display:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "21px"
    fontWeight: 700
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "9999px"
spacing:
  "1": "2px"
  "2": "4px"
  "3": "6px"
  "4": "8px"
  "5": "12px"
  "6": "16px"
components:
  icon-btn:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    size: "32px"
  icon-btn-hover:
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
  rail-btn:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    size: "32px"
  rail-btn-active:
    backgroundColor: "{colors.active-row}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
  tab-active:
    backgroundColor: "{colors.editor-bg}"
    textColor: "{colors.fg}"
    rounded: "6px 6px 0 0"
  tree-row-active:
    backgroundColor: "{colors.active-row}"
    textColor: "{colors.fg}"
    rounded: "{rounded.xs}"
  thread-item-active:
    backgroundColor: "{colors.surface-warm}"
    textColor: "{colors.fg}"
    rounded: "0 {rounded.sm} {rounded.sm} 0"
  badge-spec:
    backgroundColor: "color-mix(in oklab, {colors.accent}, transparent 80%)"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  modal:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
  diff-add:
    backgroundColor: "color-mix(in oklab, {colors.success}, transparent 94%)"
    textColor: "{colors.success}"
  diff-remove:
    backgroundColor: "color-mix(in oklab, {colors.danger}, transparent 94%)"
    textColor: "{colors.danger}"
---

# Design System: Palisade Code

## Overview

**Creative North Star: "The Dragon Fire Workbench"**

Palisade Code is a desktop IDE for driving a coding agent (Claude Code or Codex) against a real project — an icon activity rail into eleven task panels, CodeMirror editor, git diff/staging, a PTY terminal, and a live force-directed map of the codebase, wrapped around an agent chat and diff console. It reads as a serious developer tool first: near-black, dense, monospace-leaning, native macOS window chrome. One color — Dragon Fire Green — cuts through that neutrality to mark whatever is live, active, or agent-touched: the active rail icon, the active tab, diff additions, the focus ring, the codebase-map's pulse. Everything else stays a disciplined charcoal.

This is the same visual language the product has carried since its chat-console days (`--accent`, `--bg`, `--surface-warm` are unchanged), retargeted at an IDE shell twice over: first a three-column workspace replaced the earlier fixed-width chat cockpit, then the left column itself grew from a single file-explorer rail into a VS Code-style activity bar (`NavRail`) feeding eleven interchangeable panels — explorer, search, source control, specs, codebase map, run configs, MCP servers, database, history, workspace, settings — as the product's agent-facing surface area grew past "files plus chat."

**Key Characteristics:**
- **One-ink dark field, native chrome.** A near-black background (`oklch(18% 0.005 250)`) with three charcoal surface steps (`surface`, `surface-warm`, `editor-bg`); window traffic lights are native macOS controls (via an AppKit plugin), not drawn in CSS. Light mode exists (`data-theme="light"` or OS auto-detect) as a full token-for-token mirror, syntax-highlighting palette included.
- **Scarce glowing accent.** Dragon Fire Green marks the active rail icon, active tab underline, active thread rail, diff additions, focus rings, and the codebase-map's live node — never decoration.
- **A narrow icon rail gates eleven panels, not a fixed file tree.** The 44px `NavRail` is permanent chrome; the 193px-default (160–420px) resizable slot beside it now renders whichever one of eleven panels is active — file explorer is one tenant among many, not the rail's sole purpose. The right threads/codebase-map/terminal panel (300px default, 260–820px) is unchanged. Both slides fully out on collapse (`⌘\` / `⌘J`), never overlaying the workspace.
- **Two shell arrangements, one DOM.** A `data-preset` attribute (`editor` default, `vibe`) re-sequences the same mounted rail/panel/editor/chat tree via flexbox `order` rather than mounting a second layout — see Layout §Vibe/Editor preset flip.
- **Mono for anything machine-shaped.** File paths, line numbers, tab labels, uppercase micro-labels, diff content, the terminal, and now a full 13-token syntax-highlighting palette all use the monospace stack; the sans stack carries everything read as a sentence.
- **Command-bar family for every transient surface.** The file palette (`⌘P`), find-in-files (`⌘⇧F`), settings, and every confirm/rename/branch-picker prompt share one `Modal` component: a blurred-backdrop overlay centered at 18vh, `role="dialog"`, Tab-trapped focus.

## Colors

A dark neutral field with one glowing green accent, three semantic status hues, and a dedicated syntax-highlighting set, expressed in OKLCH so the accent hue is swappable live (the Settings panel's 6-preset color picker rewrites `--accent-hue` on `:root`, which every accent-derived token — `accent`, `accent-on`, `twilight-glow`, `active-row` — reads through a `var()` fallback chain).

### Primary
- **Dragon Fire Green** (`oklch(88% 0.21 var(--accent-hue, 145))`): the single brand accent. Active rail icon, active tab underline, diff-addition text, focus ring, the codebase-map's pulsing node, the branch-switch icon.
- **Dragon Fire On-Green** (`oklch(20% 0.03 var(--accent-hue, 145))`): ink for anything sitting on a solid accent fill.

### Secondary
- **Twilight Glow** (`oklch(18% 0.03 var(--accent-hue, 145))`): still live in the chat pane specifically — the Spec Mode banner's gradient/border and the assistant chat-avatar fill. The one place a second accent-adjacent tone is allowed, scoped to "the agent is in read-only planning mode."

### Neutral
- **Background** (`oklch(18% 0.005 250)`): the window field.
- **Chrome background** (`oklch(15% 0.004 250)`): top chrome, the nav rail, editor tab bar — slightly darker than the field so structural chrome recedes behind content.
- **Editor background** (`oklch(20% 0.005 250)`): the CodeMirror surface and active editor tab — slightly lighter than the field so the working document reads as "up."
- **Surface** (`oklch(22% 0.006 250)`) / **Surface Warm** (`oklch(26% 0.008 250)`): panel and hover-state fills; warm is the resting state for buttons, inactive tree/thread rows, and hover.
- **Active row** (`oklch(24% 0.020 var(--accent-hue, 145))`, accent-tinted): the active `NavRail` icon's fill and the currently-open codebase-map node's neighborhood highlight — any "this is the selected panel/node" state.
- **Foreground** (`oklch(96% 0.003 250)`): primary ink.
- **Muted** (`oklch(66% 0.012 250)`): secondary text, metadata, placeholder hints, inactive tab/icon color.
- **Border** (`oklch(30% 0.010 250)`): the only divider color in the system.

### Semantic status
- **Success** (`oklch(72% 0.15 160)`): diff-addition background/text.
- **Warn** (`oklch(76% 0.15 65)`): the preflight-status warning state.
- **Danger** (`oklch(64% 0.22 25)`): diff-deletion text, destructive-action buttons (discard, delete), the error banner.
- **Danger On** (`oklch(98% 0.02 25)`): ink for anything sitting on a solid danger fill — added once a destructive-action button needed light text on a red field rather than assuming white.

### Syntax highlighting (CodeMirror)
A 13-token set powering editor syntax color, fully mirrored in light mode: `code-comment` (muted-adjacent), `code-text` (default ink), `code-keyword` (`oklch(73% 0.17 280)`, violet), `code-atom` (`oklch(72% 0.15 160)`, reuses the success hue for booleans/null-likes), `code-number` (`oklch(78% 0.12 95)`, amber), `code-string` (`oklch(72% 0.11 50)`, warm orange), `code-regexp` (`oklch(72% 0.15 25)`, reuses the danger hue), `code-variable` / `code-property` (`oklch(82% 0.04 240)`, cool low-chroma blue), `code-variable-def` (`oklch(82% 0.08 240)`, the same blue at higher chroma for definition sites), `code-type` (`oklch(75% 0.1 180)`, teal), `code-function` (`oklch(82% 0.11 95)`, shares the number hue), `code-meta` (near-muted), `code-invalid` (aliases `danger`). This is a system on its own, deliberately not folded into the accent/semantic palette — code color is about language grammar, not app state.

**The One Accent Rule.** Dragon Fire Green never appears on borders, dividers, or static chrome — only on something live: an active state, an addition, a focus ring, a link between two files the agent just touched.

**Measured contrast** (computed from these OKLCH tokens against `bg`): `fg` 16.7:1, `muted` 6.1:1, `accent` 14.0:1, `success` 8.1:1, `danger` 5.0:1, `warn` 8.5:1 — every text pairing clears WCAG AA, most clear AAA.

## Typography

**Body — system-ui stack** (13px base, `1.5` line-height): everything read as prose — chat messages, empty-state copy, error banners, settings labels.

**Mono — `ui-monospace, SF Mono, JetBrains Mono, Menlo`**: file paths and tree labels, tab labels, line numbers, diff content, the terminal, uppercase section labels (`Staged Changes`, `Turn History`), badges, `<kbd>` hints. Set small (9–13px) since this is a dense, information-forward tool, not an editorial surface.

**Display — 21px, one step, currently unused.** Reserved for a first-run
headline above the 13px body step — every other surface is dense working
chrome and stays on the body/mono steps, so a second display size still means
asking what the first one was for. Pre-release, the first-run screen carries
no headline or pitch copy at all (see `OnboardingScreen.test.tsx`): account
gating is still coming, and a claim like "no bundled model, no per-usage
billing" would become false the moment it ships, so the screen states nothing
rather than something that could go stale. If a headline returns once that's
settled, this is the step it uses.

**The Two-Voice Rule.** If it's read as a path, a key, or a label, it's mono; if it's read as a sentence, it's sans. This split predates the IDE pivot and hasn't moved.

**Measured scale (px):** 9 (kbd/tab micro-labels) · 10 · 11 (buttons, badges, tab labels, uppercase section headings) · 12 (mono metadata, body default in dense panels) · 13 (base body, commit box) · 16 (modal input, only place body text gets room to breathe). Half-steps (9.5 / 10.5 / 11.5 / 12.5) appear where a control needs to split the difference between two named sizes rather than commit to a new tier — treat them as that tier's variant, not a seventh size.

## Layout

A fixed full-viewport shell (`height: 100vh; overflow: hidden`) — no document scroll, only individual panes scroll.

- **Top chrome — 36px.** Native macOS traffic lights at the OS level (not CSS); a right-aligned utility cluster of 32px icon buttons (left-sidebar toggle, theme cycle, right-sidebar toggle, terminal toggle, settings, preflight/executor status). The whole bar is a manual drag region (`onMouseDown` distinguishes single-click-drag from double-click-maximize, since Tauri's `data-tauri-drag-region` alone can't).
- **Nav rail — 44px, permanent, icon-only.** A VS Code-style activity bar (`NavRail`): 32×32px buttons at 18px icon size, grouped top-to-bottom into workspace navigation (Explorer, Search, Source Control), a divider, agent-facing surfaces (Specs, Codebase Map, Run configurations, MCP Servers, Database — five items, one past the rail's own ≤4-per-group guideline, kept together because they're all "agent-orchestration surfaces" rather than split for the sake of the count), a flexible spacer, then History/Workspace/Settings pinned to the bottom. The active icon gets the accent-tinted `active-row` fill plus a 2px accent bar that sits on whichever edge faces the opened panel (flips sides in the Vibe preset). Clicking the already-active icon closes its panel (`activePanel: null`, rail-only).
- **Side panel — 193px default (160–420px), resizable + collapsible (`⌘\`).** The slot the rail opens into now serves eleven interchangeable panels sharing one head/body shell convention (`ds-panel-head` title + `ds-panel-body` content): Explorer (indented file tree, inline chevrons, right-click New/Rename/Delete, drag-and-drop move), Search, Source Control, Specs, Codebase Map, Run configurations (project commands plus a nested Verification section — verify commands live here because they're project commands too, not a tenth rail icon), MCP Servers, Database (a lightweight connection/schema/table list — opening a table or a query hands off to a real center-workspace tab, the same list-then-tab pattern as opening a file), History, Workspace, Settings. No panel is privileged as "always there" anymore; the rail itself is the wayfinding and starts with no panel open.
- **Center workspace — flexes.** A 28px tab bar (Editor / Console Chat / Code Change Diff, Editor first and default) over a breadcrumb row, then the active pane. Editor is CodeMirror 6 with per-language extensions (now driving the 13-token syntax palette above) and inline image/video preview (zoomable) for binary files. Diff pane shows staged/working sections with hunk-level stage/unstage and a sticky fetch/pull/push + commit box. Chat pane is the agent console (Spec/Go mode toggle, streaming events, turn history). Opening a database table or query from the side panel adds a tab here, alongside file tabs.
- **Right panel — Workspace/Threads/Codebase-Map/Terminal, 300px default (260–820px), resizable + collapsible (`⌘J`), open by default.** A pinned workspace-picker + branch-switch row sits above a three-tab bar; Terminal only appears as a tab when its placement is set to "sidebar" (it defaults to a bottom panel, toggled independently via `⌘\``).
- **Both the nav-rail's side panel and the right panel collapse by sliding fully out** (negative margin, 200ms) rather than overlaying the workspace — the center reclaims their width. Below 760px this is unchanged: nothing relayouts further; there is no smaller breakpoint tier.
- **Vibe/Editor preset flip.** A single `data-preset` attribute on the shell root (`editor` default, `vibe`) re-sequences the same mounted rail/panel/editor/chat DOM via flexbox `order`, 200ms `cubic-bezier(0.2,0,0,1)` — no second layout is ever mounted. Editor preset reads left-to-right as rail → panel → editor → chat-rail; Vibe re-orders to sessions → chat → editor → panel → rail and flips the panel/rail's border from right-edge to left-edge to match their new position. The Governing Rule this encodes: both presets share one panel inventory and differ only in arrangement, never in content.
- **Two overlay families float above everything, both `z-index: 100`:** the `Modal` command-bar family (blurred backdrop, centered at 18vh) for the file palette, find-in-files, settings, and confirm/rename/branch prompts; a separate lightweight `context-menu` popover for file-tree right-clicks.

## Elevation & Depth

Mostly flat — this is a workbench, not a card deck. Borders (`--border`, the only divider color) do the dividing; shadow is reserved for things that float above the field.

- **Flat** (`none`): the default for panels, tree/thread rows, tabs, the editor.
- **Raised** (`0 4px 20px rgba(0,0,0,0.35)` / `0 8px 24px rgba(0,0,0,0.35)`): the two floating-layer weights — modal command-bars get the lighter one, the file-tree context menu and settings-panel-triggered overlays the heavier.
- **Scrim** (`--scrim`, `rgba(0,0,0,0.68)` + `backdrop-filter: blur(5px)`): the dim behind every Modal-family overlay (file palette, find-in-files, settings, confirm/rename/branch prompts). One value, one token — an overlay that wants a different darkness is a new elevation decision, not a local tweak.
- **Focus ring** (`0 0 0 2px color-mix(in oklab, var(--accent), transparent 55%)`): every focusable control (`button`, `input`, `select`, plus keyboard-activatable tree/thread/branch/rail rows) gets this on `:focus-visible`, globally, once.
- **Active-tab lift** (`box-shadow: 0 2px 8px rgba(0,0,0,0.3)`): the only shadow on something that isn't an overlay — the active mode-selector button.

## Shapes

A five-step radius scale, smallest to largest: `4px` (chips, inline inputs) · `5–6px` (buttons, tabs, rail icons, most controls — used near-interchangeably; treat as one "sm" step) · `8px` (modal command-bar) · `9999px` pill (badges, the scrollbar thumb) · `12px` (the window shell itself, a one-off outer radius). No larger card/panel radius exists — panels, the editor, and the terminal are all square-cornered; roundedness is reserved for controls and the window edge. One piece of drift to close, not a documented step: two rules still reference an undefined `var(--r-pill, 999px)` instead of the `pill` token directly — see Do's and Don'ts.

## Components

### Implementation stack (binding)

Every component in this section is built from **Mantine** (`@mantine/core`,
`@mantine/hooks`) with **Tabler** icons (`@tabler/icons-react`) — these are
the only two UI libraries in the tree, and no third is added. The tokens
above are not a parallel system: they are wired through
`postcss-preset-mantine` and Mantine's CSS-variable theme, so a Mantine
component inherits `--accent`/`--bg`/`--surface` rather than shipping its
own palette.

- **Reach for the Mantine component first.** `Button`, `ActionIcon`,
  `Tabs`, `Modal`, `Menu`, `TextInput`, `Textarea`, `Tooltip`, `Badge`,
  `ScrollArea`, `SegmentedControl`, `Popover` all exist — a hand-rolled
  equivalent is a bug, not a style choice. The shell's `Modal` wrapper and
  `.ds-section-heading`/`.ds-panel-head`/`.ds-panel-body` patterns are the
  local idiom on top of Mantine; reuse them rather than adding a second
  wrapper.
- **Every icon is a Tabler icon.** No inline `<svg>`, no emoji-as-icon, no
  second icon set. Nav rail, title bar, status bar, status chips, and panel
  headers all draw from `@tabler/icons-react` at a consistent stroke
  weight (rail icons specifically at `size={18} stroke={1.6}`).
- **Custom CSS is for layout and tokens, not for rebuilding widgets.**
  Flex/grid arrangement, `order` for the Vibe/Editor preset flip, and
  token overrides via `styles`/`classNames` are fine; a bespoke
  dropdown/dialog/tab implementation is not.

### Icon buttons
32px square, transparent fill, 1px border, 6px radius, muted icon that lifts to foreground on hover; a `.ok`/`.warn`/`.bad` state variant recolors border+icon (used by the preflight/executor-status button). Shared by every top-chrome utility button and the editor's image zoom controls.

### Nav rail buttons
Same 32×32px footprint as icon buttons but border-free: transparent fill, muted 18px Tabler icon, 6px radius. The active button diverges from the plain icon-button pattern — it gets the accent-tinted `active-row` background plus a 2px solid-accent bar riding one edge of the button (`::before`, side flips with the Vibe/Editor preset) — the only place in the shell an "active" state combines a fill change with an edge marker rather than picking one. A small accent dot badges the Source Control icon when the working tree is dirty; text/icon color is never the sole signal (see Do's and Don'ts).

### Side panel (head/body shell)
The convention every one of the eleven `NavRail` destinations shares: an optional `ds-panel-head` (an 11px uppercase label naming the panel — added after early reviewers read the unlabelled rail icons and had to click to find out what each one was) over a scrollable `ds-panel-body`. Panels compose their own content inside that body (a tree, a form, a list-plus-detail split) but never replace the head/body wrapper with a bespoke frame.

### Tabs
Two families, same underline language: the 28px editor tab bar (active tab lifts to `editor-bg` with a top-rounded 6px card and a 1px border matching the editor below it; the diff tab additionally tints accent-green when active) and the right-panel tab bar (flatter — active state is just a 2px accent underline, no fill change).

### Tree / list rows (file tree, thread list, branch picker, database connection rows)
All share one interaction contract: `role="button" tabIndex={0}`, click or Enter/Space to activate, hover/focus lift to `surface-warm`. The active file-tree row additionally gets the accent-tinted `active-row` fill; the active thread gets a 2px accent left rail with a right-only 6px radius.

### Modal (`role="dialog"`)
The shared wrapper behind the file palette, find-in-files, settings, and every confirm/rename/branch prompt: `overlay` (fixed, blurred, centered at 18vh) → `commandbar` (`bg` fill, 1px border, 8px radius, 12×14 padding). Focuses its first control on mount (unless a child already claimed focus via its own `autoFocus`) and traps Tab within itself while open.

### Diff view
Each hunk: 44px right-aligned mono line numbers in `surface-warm`, then content. Additions get a 6%-green tint with green text and a leading `+`; deletions get 6%-red with red text and a leading `-` — color is never the only signal, the leading glyph always carries the same information. Section labels (`Staged Changes`, `Changes`, `Turn History`) are `h2`s styled as 11px uppercase mono micro-labels (`.ds-section-heading`), not literal `h4`s — no heading level above `h1` gets skipped anywhere in the shell.

### Chat pane / Spec Mode banner
The Console Chat tab still carries the product's original agent-console identity inside the IDE shell: a `twilight-glow`-gradient banner ("Spec Mode — read-only planning") appears directly under the header whenever the active thread is in spec (read-only/plan) mode, and disappears in go (write-enabled) mode. Assistant turns render as a chat bubble with a 28px avatar filled `twilight-glow`; the user's own turns have no avatar treatment and align without a bubble card. This is the one surface where the chat-console lineage is still visually explicit, not just structurally present.

### Codebase-map (Graphify)
Force-directed canvas, `surface` background, `grab`/`grabbing` cursor, drag to pan, wheel to zoom, double-click to refit. Nodes are colored by community from a fixed 8-slot CVD-safe categorical palette (`#3987e5`, `#d95926`, `#199e70`, `#c98500`, `#d55181`, `#008300`, `#9085e9`, `#e66767`); anything past slot 8 folds into a neutral "Other." The paint loop only runs while the force simulation is still settling or the view was just touched (pan/zoom/resize) — it doesn't spin forever once idle.

### Database panel and grid
The side-panel list (connections → schemas → tables) follows the shared tree/list row contract above; opening a table or a saved query hands off to a real center-workspace tab rather than rendering the grid in the sidebar — the sidebar's job is always "find the thing," never "edit the thing," matching how Explorer only lists files while the editor tab does the work.

### Badges
Pill-radius, 1px `currentColor` border, uppercase 11px mono, text always present alongside color (`spec`/`go` mode badges, the `new` untracked-file badge) — never color as the only signal.

## Do's and Don'ts

### Do:
- **Do** reserve Dragon Fire Green for live/active/agent-touched surfaces only.
- **Do** set anything path-, key-, or metadata-shaped in the mono stack; prose in the sans stack.
- **Do** collapse the resizable rails by sliding them fully out of the flex layout, never by overlaying the workspace.
- **Do** route every transient prompt (confirm, rename, palette, settings) through the shared `Modal` component rather than a bespoke overlay div.
- **Do** give every tree/list row real keyboard operability (`role="button" tabIndex={0}` + Enter/Space), not click-only.
- **Do** pair color with a second signal (a glyph, text, an icon) for anything status-bearing — never color alone.
- **Do** keep a new `NavRail` panel to the shared `ds-panel-head`/`ds-panel-body` convention rather than framing it with a bespoke wrapper.

### Don't:
- **Don't** hand-roll a widget Mantine already ships, and **don't** draw an inline `<svg>` where a Tabler icon exists — see Components §Implementation stack.
- **Don't** introduce a second brand chromatic color — accent is Dragon Fire Green only; everything else is neutral, semantic status, or the syntax-highlighting set.
- **Don't** shadow a resting panel, row, or tab — shadows are for floating layers and the active mode button only.
- **Don't** use a radius outside the documented five steps, and don't add a new `var(--r-pill, ...)`-style fallback for an undefined variable — reference `{rounded.pill}`/`9999px` directly; two existing rules still carry that dead fallback and should be cleaned up when touched.
- **Don't** skip a heading level (no bare `h4` with nothing above it — every section heading routes through the app's single `h1` down to `h2`).
- **Don't** rely on `placeholder` as an input's only accessible name — every primary input carries its own `aria-label` alongside the placeholder.
- **Don't** put a heavy, edit-capable surface (a data grid, a big form) inside a `NavRail` side panel — the panel finds things, a center-workspace tab is where they're worked on (see Database panel and grid).
