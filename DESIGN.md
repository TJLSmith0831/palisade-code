---
name: PalisadeCode
description: Cross-machine coding-agent IDE — file tree, CodeMirror editor, git diff, terminal, and a live codebase-map graph around an agent chat/diff console.
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

Palisade Code is a desktop IDE for driving a coding agent (Claude Code or Codex) against a real project — file tree, CodeMirror editor, git diff/staging, a PTY terminal, and a live force-directed map of the codebase, wrapped around an agent chat and diff console. It reads as a serious developer tool first: near-black, dense, monospace-leaning, native macOS window chrome. One color — Dragon Fire Green — cuts through that neutrality to mark whatever is live, active, or agent-touched: the active file-tree row, the active tab, diff additions, the focus ring, the codebase-map's pulse. Everything else stays a disciplined charcoal.

This is the same visual language the product has carried since its chat-console days (`--accent`, `--bg`, `--surface-warm` are unchanged), retargeted at an IDE shell: a three-column workspace (resizable file explorer · tabbed editor/chat/diff center · resizable threads/codebase-map/terminal sidebar) replaced the earlier fixed-width chat cockpit as the product moved from "watch the agent talk" to "work alongside the agent in the same files."

**Key Characteristics:**
- **One-ink dark field, native chrome.** A near-black background (`oklch(18% 0.005 250)`) with three charcoal surface steps (`surface`, `surface-warm`, `editor-bg`); window traffic lights are native macOS controls (via an AppKit plugin), not drawn in CSS. Light mode exists (`data-theme="light"` or OS auto-detect) as a full token-for-token mirror.
- **Scarce glowing accent.** Dragon Fire Green marks the active tree row, active tab underline, active thread rail, diff additions, focus rings, and the codebase-map's live node — never decoration.
- **Three-column, both rails resizable.** Left file-explorer rail (193px default, 160–420px) and right threads/codebase-map/terminal panel (300px default, 260–820px) both drag-resize and collapse via `⌘\` / `⌘J`, sliding fully out of the layout (not overlaying it) so the center workspace reclaims their width.
- **Mono for anything machine-shaped.** File paths, line numbers, tab labels, uppercase micro-labels, diff content, and the terminal all use the monospace stack; the sans stack carries everything read as a sentence.
- **Command-bar family for every transient surface.** The file palette (`⌘P`), find-in-files (`⌘⇧F`), settings, and every confirm/rename/branch-picker prompt share one `Modal` component: a blurred-backdrop overlay centered at 18vh, `role="dialog"`, Tab-trapped focus.

## Colors

A dark neutral field with one glowing green accent and three semantic status hues, expressed in OKLCH so the accent hue is swappable live (the Settings panel's 6-preset color picker rewrites `--accent-hue` on `:root`).

### Primary
- **Dragon Fire Green** (`oklch(88% 0.21 var(--accent-hue, 145))`): the single brand accent. Active file-tree/thread row, active tab underline, diff-addition text, focus ring, the codebase-map's pulsing node, the branch-switch icon.
- **Dragon Fire On-Green** (`oklch(20% 0.03 var(--accent-hue, 145))`): ink for anything sitting on a solid accent fill.

### Secondary
- **Twilight Glow** (`oklch(18% 0.03 var(--accent-hue, 145))`): still live in the chat pane specifically — the Spec Mode banner's gradient/border and the assistant chat-avatar fill. The one place a second accent-adjacent tone is allowed, scoped to "the agent is in read-only planning mode."

### Neutral
- **Background** (`oklch(18% 0.005 250)`): the window field.
- **Chrome background** (`oklch(15% 0.004 250)`): top chrome, editor tab bar — slightly darker than the field so structural chrome recedes behind content.
- **Editor background** (`oklch(20% 0.005 250)`): the CodeMirror surface and active editor tab — slightly lighter than the field so the working document reads as "up."
- **Surface** (`oklch(22% 0.006 250)`) / **Surface Warm** (`oklch(26% 0.008 250)`): panel and hover-state fills; warm is the resting state for buttons, inactive tree/thread rows, and hover.
- **Active row** (`oklch(24% 0.020 var(--accent-hue, 145))`, accent-tinted): reserved specifically for the currently-open codebase-map node's neighborhood highlight.
- **Foreground** (`oklch(96% 0.003 250)`): primary ink.
- **Muted** (`oklch(66% 0.012 250)`): secondary text, metadata, placeholder hints, inactive tab/icon color.
- **Border** (`oklch(30% 0.010 250)`): the only divider color in the system.

### Semantic status
- **Success** (`oklch(72% 0.15 160)`): diff-addition background/text.
- **Warn** (`oklch(76% 0.15 65)`): the preflight-status warning state.
- **Danger** (`oklch(64% 0.22 25)`): diff-deletion text, destructive-action buttons (discard, delete), the error banner.

**The One Accent Rule.** Dragon Fire Green never appears on borders, dividers, or static chrome — only on something live: an active state, an addition, a focus ring, a link between two files the agent just touched.

**Measured contrast** (computed from these OKLCH tokens against `bg`): `fg` 16.7:1, `muted` 6.1:1, `accent` 14.0:1, `success` 8.1:1, `danger` 5.0:1, `warn` 8.5:1 — every text pairing clears WCAG AA, most clear AAA.

## Typography

**Body — system-ui stack** (13px base, `1.5` line-height): everything read as prose — chat messages, empty-state copy, error banners, settings labels.

**Mono — `ui-monospace, SF Mono, JetBrains Mono, Menlo`**: file paths and tree labels, tab labels, line numbers, diff content, the terminal, uppercase section labels (`Staged Changes`, `Turn History`), badges, `<kbd>` hints. Set small (9–12px) since this is a dense, information-forward tool, not an editorial surface.

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

**Measured scale (px):** 9 (kbd/tab micro-labels) · 10 · 11 (buttons, badges, tab labels, uppercase section headings) · 12 (mono metadata, body default in dense panels) · 13 (base body, commit box) · 16 (modal input, only place body text gets room to breathe).

## Layout

A fixed full-viewport shell (`height: 100vh; overflow: hidden`) — no document scroll, only individual panes scroll.

- **Top chrome — 36px.** Native macOS traffic lights at the OS level (not CSS); a right-aligned utility cluster of 32px icon buttons (left-sidebar toggle, theme cycle, right-sidebar toggle, terminal toggle, settings, preflight/executor status). The whole bar is a manual drag region (`onMouseDown` distinguishes single-click-drag from double-click-maximize, since Tauri's `data-tauri-drag-region` alone can't).
- **Left rail — file explorer only, 193px default (160–420px), resizable + collapsible (`⌘\`).** Indented tree rows with inline chevrons; right-click opens a context menu (New File/Folder, and Rename/Delete when a row is targeted); rows support drag-and-drop move onto a folder or the tree background.
- **Center workspace — flexes.** A 28px tab bar (Editor / Console Chat / Code Change Diff, Editor first and default) over a breadcrumb row, then the active pane. Editor is CodeMirror 6 with per-language extensions and inline image/video preview (zoomable) for binary files. Diff pane shows staged/working sections with hunk-level stage/unstage and a sticky fetch/pull/push + commit box. Chat pane is the agent console (Spec/Go mode toggle, streaming events, turn history).
- **Right panel — Workspace/Threads/Codebase-Map/Terminal, 300px default (260–820px), resizable + collapsible (`⌘J`), open by default.** A pinned workspace-picker + branch-switch row sits above a three-tab bar; Terminal only appears as a tab when its placement is set to "sidebar" (it defaults to a bottom panel, toggled independently via `⌘\``).
- **Both rails collapse by sliding fully out** (negative margin, 200ms) rather than overlaying the workspace — the center reclaims their width. Below 760px this is unchanged: the rails don't relayout further; there is no smaller breakpoint tier.
- **Two overlay families float above everything, both `z-index: 100`:** the `Modal` command-bar family (blurred backdrop, centered at 18vh) for the file palette, find-in-files, settings, and confirm/rename/branch prompts; a separate lightweight `context-menu` popover for file-tree right-clicks.

## Elevation & Depth

Mostly flat — this is a workbench, not a card deck. Borders (`--border`, the only divider color) do the dividing; shadow is reserved for things that float above the field.

- **Flat** (`none`): the default for panels, tree/thread rows, tabs, the editor.
- **Raised** (`0 4px 20px rgba(0,0,0,0.35)` / `0 8px 24px rgba(0,0,0,0.35)`): the two floating-layer weights — modal command-bars get the lighter one, the file-tree context menu and settings-panel-triggered overlays the heavier.
- **Scrim** (`--scrim`, `rgba(0,0,0,0.68)` + `backdrop-filter: blur(5px)`): the dim behind every Modal-family overlay (file palette, find-in-files, settings, confirm/rename/branch prompts). One value, one token — an overlay that wants a different darkness is a new elevation decision, not a local tweak.
- **Focus ring** (`0 0 0 2px color-mix(in oklab, var(--accent), transparent 55%)`): every focusable control (`button`, `input`, `select`, plus keyboard-activatable tree/thread/branch rows) gets this on `:focus-visible`, globally, once.
- **Active-tab lift** (`box-shadow: 0 2px 8px rgba(0,0,0,0.3)`): the only shadow on something that isn't an overlay — the active mode-selector button.

## Shapes

A five-step radius scale, smallest to largest: `4px` (chips, inline inputs) · `5–6px` (buttons, tabs, most controls — used near-interchangeably; treat as one "sm" step) · `8px` (modal command-bar) · `9999px` pill (badges, the scrollbar thumb) · `12px` (the window shell itself, a one-off outer radius). No larger card/panel radius exists — panels, the editor, and the terminal are all square-cornered; roundedness is reserved for controls and the window edge.

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
  `.ds-section-heading` pattern are the local idiom on top of Mantine;
  reuse them rather than adding a second wrapper.
- **Every icon is a Tabler icon.** No inline `<svg>`, no emoji-as-icon, no
  second icon set. Rail, title bar, status bar, status chips, and panel
  headers all draw from `@tabler/icons-react` at a consistent stroke
  weight.
- **Custom CSS is for layout and tokens, not for rebuilding widgets.**
  Flex/grid arrangement, `order` for the Vibe/Editor preset flip, and
  token overrides via `styles`/`classNames` are fine; a bespoke
  dropdown/dialog/tab implementation is not.

### Icon buttons
32px square, transparent fill, 1px border, 6px radius, muted icon that lifts to foreground on hover; a `.ok`/`.warn`/`.bad` state variant recolors border+icon (used by the preflight/executor-status button). Shared by every top-chrome utility button and the editor's image zoom controls.

### Tabs
Two families, same underline language: the 28px editor tab bar (active tab lifts to `editor-bg` with a top-rounded 6px card and a 1px border matching the editor below it; the diff tab additionally tints accent-green when active) and the right-panel tab bar (flatter — active state is just a 2px accent underline, no fill change).

### Tree / list rows (file tree, thread list, branch picker)
All three now share one interaction contract: `role="button" tabIndex={0}`, click or Enter/Space to activate, hover/focus lift to `surface-warm`. The active file-tree row additionally gets the accent-tinted `active-row` fill; the active thread gets a 2px accent left rail with a right-only 6px radius.

### Modal (`role="dialog"`)
The shared wrapper behind the file palette, find-in-files, settings, and every confirm/rename/branch prompt: `overlay` (fixed, blurred, centered at 18vh) → `commandbar` (`bg` fill, 1px border, 8px radius, 12×14 padding). Focuses its first control on mount (unless a child already claimed focus via its own `autoFocus`) and traps Tab within itself while open.

### Diff view
Each hunk: 44px right-aligned mono line numbers in `surface-warm`, then content. Additions get a 6%-green tint with green text and a leading `+`; deletions get 6%-red with red text and a leading `-` — color is never the only signal, the leading glyph always carries the same information. Section labels (`Staged Changes`, `Changes`, `Turn History`) are `h2`s styled as 11px uppercase mono micro-labels (`.ds-section-heading`), not literal `h4`s — no heading level above `h1` gets skipped anywhere in the shell.

### Chat pane / Spec Mode banner
The Console Chat tab still carries the product's original agent-console identity inside the IDE shell: a `twilight-glow`-gradient banner ("Spec Mode — read-only planning") appears directly under the header whenever the active thread is in spec (read-only/plan) mode, and disappears in go (write-enabled) mode. Assistant turns render as a chat bubble with a 28px avatar filled `twilight-glow`; the user's own turns have no avatar treatment and align without a bubble card. This is the one surface where the chat-console lineage is still visually explicit, not just structurally present.

### Codebase-map (Graphify)
Force-directed canvas, `surface` background, `grab`/`grabbing` cursor, drag to pan, wheel to zoom, double-click to refit. Nodes are colored by community from a fixed 8-slot CVD-safe categorical palette (`#3987e5`, `#d95926`, `#199e70`, `#c98500`, `#d55181`, `#008300`, `#9085e9`, `#e66767`); anything past slot 8 folds into a neutral "Other." The paint loop only runs while the force simulation is still settling or the view was just touched (pan/zoom/resize) — it doesn't spin forever once idle.

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

### Don't:
- **Don't** hand-roll a widget Mantine already ships, and **don't** draw an inline `<svg>` where a Tabler icon exists — see Components §Implementation stack.
- **Don't** introduce a second brand chromatic color — accent is Dragon Fire Green only; everything else is neutral or semantic status.
- **Don't** shadow a resting panel, row, or tab — shadows are for floating layers and the active mode button only.
- **Don't** use a radius outside the documented five steps.
- **Don't** skip a heading level (no bare `h4` with nothing above it — every section heading routes through the app's single `h1` down to `h2`).
- **Don't** rely on `placeholder` as an input's only accessible name — every primary input carries its own `aria-label` alongside the placeholder.
