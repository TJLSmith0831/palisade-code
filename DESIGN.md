---
name: FlooNetwork
description: Cross-machine coding-agent orchestrator with a two-mode (Spec / Go) console, code-map graph, and embedded project notes.
colors:
  bg: "#0a0b0d"
  surface: "#121316"
  surface-warm: "#1a1c21"
  fg: "#f3f4f6"
  muted: "#8e939e"
  border: "#22242b"
  accent: "#2cf575"
  accent-on: "#071a0d"
  twilight-glow: "#081a10"
  success: "#10b981"
  warn: "#f59e0b"
  danger: "#ef4444"
typography:
  display:
    fontFamily: '"Super Sans VF", system-ui, -apple-system, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif'
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "0.96"
    letterSpacing: "-0.0275em"
  body:
    fontFamily: '"Super Sans VF", system-ui, -apple-system, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "1.5"
    letterSpacing: "normal"
  mono:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "1.5"
    letterSpacing: "normal"
rounded:
  sm: "8px"
  md: "8px"
  lg: "16px"
  pill: "9999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "12": "48px"
components:
  btn-warm:
    backgroundColor: "{colors.surface-warm}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  btn-warm-hover:
    backgroundColor: "{colors.surface-warm}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  chat-send-btn:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-on}"
    rounded: "{rounded.sm}"
    padding: "0"
    size: "32px"
  mode-btn-active:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "6px"
    padding: "6px 16px"
  thread-item-active:
    backgroundColor: "{colors.surface-warm}"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
  chat-content:
    backgroundColor: "{colors.surface-warm}"
    textColor: "{colors.fg}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  chat-content-user:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  spec-badge:
    backgroundColor: "color-mix(in oklab, {colors.accent}, transparent 80%)"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  note-item:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    rounded: "{rounded.sm}"
    padding: "12px"
  command-bar-box:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.lg}"
    padding: "0"
  toast:
    backgroundColor: "{colors.fg}"
    textColor: "{colors.bg}"
    rounded: "{rounded.sm}"
    padding: "12px 16px"
---

## Overview

FlooNetwork is a desktop coding-agent console, not a web page. The whole interface lives inside a single full-viewport window with `overflow: hidden` — there is no document scroll, only panes scroll. The visual world is a **premium dark operator's console**: a luxurious near-black field (`#0a0b0d`) cut by a single vibrant "Dragon Fire Green" accent (`#2cf575`) that glows against the dark like a terminal cursor. Everything else is restrained charcoal, off-white ink, and a muted grey-blue for metadata.

**Creative North Star: "The Dragon Fire Console."** A focused operator's cockpit where one glowing green thread — the agent's intent — cuts through quiet darkness. The accent is scarce and meaningful: it marks the active session, the send button, the spec badge, the live graph node, the diff additions. When you see green, something is alive and actionable.

The product's core gesture is the **Spec / Go mode toggle**. Spec Mode is the read-only planning state — a smoky twilight-green banner sits under the top nav, the agent replies with interactive spec checklists, and a "Synthesize & Handoff" action culminates in a cinematic handoff overlay (a spinning glow ring over a streaming console). Go Mode is the instant-apply state — the banner hides, the agent replies terse, and the workspace flips to the Code Change Diff tab to show the applied patch. The same executor drives both; the visual system signals which mode is live through the banner, the avatar treatment (Gemma's `G` sits in twilight-green; Claude's `C` sits in solid accent-on-green), and the chat content shape (checklist vs. plain prose).

**Key Characteristics:**
- **One-ink dark field.** A single near-black background with two charcoal surfaces (`surface`, `surface-warm`); no light mode, no gradients except the spec banner's twilight glow.
- **Scarce glowing accent.** Dragon Fire Green appears only on actionable, "live" elements — active thread rail, send button, spec badge, graph pulse, diff additions, focus ring, markdown list bullets.
- **Three-column cockpit.** Sessions (left, 260px), workspace (center, chat + diff tabs), and Code Map / Files / Notes (right, 340px, collapsed by default). Both sidebars collapse via `⌘\` / `⌘J` and slide out with a 200ms transform.
- **Mono for metadata, sans for prose.** Monospace carries timestamps, file paths, line numbers, kbd hints, and uppercase micro-labels; the variable sans carries everything the user reads as language.
- **Quiet motion, 150–200ms.** State transitions are fast and eased (`cubic-bezier(0.2, 0, 0, 1)`); the only long animation is the handoff spinner (1s linear), reserved for the mode-transition ritual.

## Colors

The palette is a dark neutral field with one glowing green accent and three semantic status hues. **The One Accent Rule.** Dragon Fire Green is the only chromatic brand color; it is reserved for live, actionable, or "agent-is-doing-something" surfaces. Never use it for decoration, dividers, or static chrome.

**Primary**
- **Dragon Fire Green** (`#2cf575`) — the single brand accent. Active thread rail, send button, spec badge border/text, graph pulse dot, diff addition text, focus ring, markdown bullet. Hover lightens 8% in OKLAB; active lightens 15%.
- **Dragon Fire On-Green** (`#071a0d`) — deep black-green ink for any text or icon sitting on a green fill (send button glyph, Claude avatar).

**Secondary**
- **Twilight Glow** (`#081a10`) — rich green-black used only for the Spec Mode banner gradient start and the Gemma agent avatar fill. The smoky bridge between the dark field and the green accent.

**Neutral**
- **Background** (`#0a0b0d`) — luxurious deep near-black; the page field and chat user-bubble fill.
- **Surface** (`#121316`) — panels and main workspaces; the handoff console fill.
- **Surface Warm** (`#1a1c21`) — warm charcoal for buttons, inactive items, hover fills, file-tree hover, right-tab bar background, scrollbar thumb base.
- **Foreground** (`#f3f4f6`) — crisp off-white primary ink; also the toast background (inverted).
- **Muted** (`#8e939e`) — grey-blue for secondary text, captions, metadata, line numbers, placeholder hints.
- **Border** (`#22242b`) — crisp subtle divider; the only border color in the system.

**Semantic status**
- **Success** (`#10b981`) — refined green for diff addition text and addition flash endpoint.
- **Warn** (`#f59e0b`) — amber (reserved for status indicators).
- **Danger** (`#ef4444`) — red for diff deletion text and the muted-sound toggle state.

Selection highlight is the accent at 75% transparency over foreground ink. Scrollbar thumb is the border color, pill-rounded, lifting 10% toward white on hover.

## Typography

A two-voice system: one variable sans for everything human-readable, one monospace for everything machine-shaped. **The Two-Voice Rule.** If the user reads it as a sentence, it's the sans; if the user reads it as a path, a timestamp, a key, or a label, it's the mono. Never set prose in monospace, never set a file path in the sans.

- **Display / Body — "Super Sans VF"** (system-ui stack fallback). One family serves both display and body; hierarchy comes from size and weight, not from a second family. Headings use tight leading (`0.96`) and display tracking (`-0.0275em`); body uses `1.5` leading and normal tracking. Antialiased with `optimizeLegibility`.
- **Mono — `ui-monospace, SF Mono, JetBrains Mono, Menlo`** for file paths, line numbers, timestamps, kbd chips, uppercase micro-labels (`SPEC INTERVIEW`, `Gemma Spec Pipeline`, `New Note Target`), note editor body, and diff content. Set at 11–13px with `1.4–1.5` leading.

**Type scale (px):**
- Micro Label — 12 (`text-xs`): kbd hints, meta, micro-labels.
- Caption — 14 (`text-sm`): thread titles, chat content, button labels, tab labels, sidebar body.
- Body / Button / Nav — 16 (`text-base`): chat input, command-bar input, brand name.
- Body Heading — 20 (`text-lg`): handoff overlay heading.
- Card Heading — 22 (`text-xl`).
- Feature Title — 28 (`text-2xl`).
- Section Heading — 48 (`text-3xl`).
- Display Hero — 64 (`text-4xl`).

Uppercase mono labels carry `0.05–0.08em` letter-spacing. The brand name uses `-0.01em` tracking at weight 600. Weights are binary in practice: 400 for body, 500 for tabs, 600 for active/important (active thread, active tab, brand, buttons, file-tree active), 700 for avatar glyphs.

## Layout

A fixed full-viewport cockpit. `body` is `height: 100vh; overflow: hidden; display: flex; flex-direction: column`. The app container is a three-column flex row filling the remaining height under a 56px top nav.

**The Three-Column Cockpit Rule.** Left and right rails are fixed pixel widths; the center workspace flexes. Both rails collapse by sliding out of the viewport via negative margin (`-260px` / `-340px`) over 200ms — they do not overlay, they yield their space to the workspace.

- **Top nav — 56px.** Brand left, Spec/Go segmented toggle center, action cluster right (Note `⌘N`, divider, sound toggle, left-sidebar toggle `⌘\`, right-sidebar toggle `⌘J`). Fixed height, border-bottom, never scrolls.
- **Left sidebar — 260px fixed.** Detected Workspace selector, New Thread button, "Active Threads" list (flex-1, scrollable), "Yesterday" archived group, footer. Active thread gets a 3px green left rail and a right-side-only border radius.
- **Main workspace — flexes.** 48px workspace header with Console Chat / Code Change Diff tabs (border-bottom active underline in foreground). Optional Spec Mode banner directly below the header (twilight-glow gradient, hidden in Go Mode). Workspace body is a positioned pane stack — `.pane-view` panes are absolutely stacked and cross-fade via opacity over 150ms; only one is active.
- **Right sidebar — 340px fixed, collapsed by default.** Three-tab bar (Code Map / Files / Notes) over a positioned pane stack with the same cross-fade pattern.

**Responsive behavior:** below 920px the sidebars detach from the flex flow and become `position: fixed` overlays anchored under the top nav at `z-index: 50`, so the workspace takes the full width and the rails float over it when opened.

**Spacing scale:** 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48. Inset padding is typically `space-4` (16px) for panels and inputs; `space-3` (12px) for compact controls; gaps between list items are 2px. The chat container uses `space-4` gaps between bubbles.

## Elevation & Depth

Depth is restrained and mostly flat — this is a console, not a card deck. **The Flat-First Rule.** Borders divide; shadows elevate only what floats above the field (overlays, toast, the active mode button). Never shadow a resting panel.

- **Flat** (`none`) — default for all panels, sidebars, chat bubbles, thread items, tabs.
- **Ring** (`0 0 0 1px var(--border)`) — the dividing border, expressed as a ring so it reads as a crisp 1px edge rather than a 1px box-shadow.
- **Raised** (`0 4px 20px rgba(0, 0, 0, 0.35)`) — only for floating layers: the active mode button, the command-bar box, the toast, the handoff console (the console adds a green-tinted ambient `0 0 30px rgba(44, 245, 117, 0.08)`).
- **Focus ring** (`0 0 0 3px color-mix(in oklab, var(--accent), transparent 60%)`) — a 3px green halo at 40% opacity around focused interactive elements.

The handoff overlay is the one moment of atmospheric depth: a 96%-opaque near-black scrim (`rgba(10, 11, 13, 0.96)`) covering the workspace with a spinning 64px glow ring (border-top in accent) above a green-tinted console — the ritual center of the mode transition.

## Shapes

A binary radius language: 8px for almost everything, 16px for larger containers, pill for status only. **The Two-Radius Rule.** Use `8px` for controls, inputs, buttons, list items, code blocks, and inline elements; use `16px` only for cards, chat bubbles, the command-bar box, the diff view panel, and the handoff console. Use `9999px` (pill) exclusively for status indicators — the spec badge, the scrollbar thumb, the graph pulse dot, the sound-toggle dot. No other radius value exists in the system.

The mode-selector is a 3px-padded rounded container with inner buttons at `radius-sm - 2px` (6px) — the one place a non-token radius appears, deliberately tightening the segmented control so its pills read as inset rather than as siblings of the 8px buttons around them.

## Components

- **Mode selector (Spec / Go).** A 3px-padded segmented control in `surface-warm` with a 1px border. Each button carries an inline SVG icon, a label, and a `<kbd>` shortcut hint. The active button lifts to `bg` with the raised shadow; inactive buttons fade to 0.8 opacity on hover. This is the product's signature control — it changes banner state, avatar treatment, and chat behavior.
- **Thread item.** Two-line list row: title (ellipsis) + mono meta row (mode · time). Hover lifts to `surface-warm` and foreground ink. Active adds a 3px Dragon Fire Green left rail, weight 600, and a right-side-only 8px radius — the rail is the accent's primary navigational use.
- **Chat bubble.** Avatar (32px, 8px radius) + content card. User bubbles align right, row-reverse, with content fill `bg` (recedes); agent bubbles align left with content fill `surface-warm` and a 1px border. Avatars: user `U` in `surface-warm`; Gemma `G` in twilight-glow with accent text; Claude `C` in solid accent with accent-on text. Content is 14px sans in a 16px-radius card.
- **Spec checklist.** Embedded inside an agent chat bubble: a bordered `bg` card with a mono uppercase header ("Gemma Spec Pipeline" · `n/total Complete`), checkbox rows (strike-through + muted when done), and a right-aligned "Approve Handoff to Claude 3.5" `btn-warm`. The checklist is the visual signature of Spec Mode.
- **Code Change Diff.** File title (mono, 14px, 600) + `+/- lines` meta + "Apply Diff" `btn-warm`, over a 16px-radius bordered panel. Each line: 44px right-aligned mono line number in `surface-warm` divided by a right border, then content. Additions get a 6%-green background and green text with a leading `+`; deletions get a 6%-red background and red text with a leading `-`. Additions can flash (`diff-flash`, 1.5s) when freshly applied.
- **Graphify code map.** SVG canvas in `surface-warm` with `grab`/`grabbing` cursor. Nodes are circles with mono labels; links are 1.5px border-colored lines with arrowhead markers. The active node pulses with an accent fill; hover grows the radius from 8 to 12. Drag pans the whole transform group. A footer hint bar sits below: "Drag to pan graph · Click node to inspect file."
- **File explorer.** Indented tree of folder/file rows with inline SVG chevrons (folder) and document icons (file). Hover and active lift to `surface-warm`; active adds weight 600. Clicking a file loads it into the diff pane.
- **Notes editor.** List view: header + "Create note" button + note items (title + 45-char preview, ellipsized). Editor view: 48px header with mono filename + Edit/Preview segmented tabs (active tab inverts to `fg`-on-`bg`), then a positioned edit/preview pane stack. Edit pane is a mono 13px textarea; preview pane renders lightweight markdown (h1/h2/h3, bullets as accent `•`, bold, italic, task-list checkboxes with accent-color). Footer: "Back to list" + "Auto-saved to disk" mono caption.
- **Command bar (`⌘N`).** Centered 540px floating box at 12vh from top, over a 4%-blurred scrim. Input row with a plus icon and placeholder, then a results list with mono uppercase section headers ("New Note Target", "Keyboard Actions") and items showing title + mono kbd hint. The preview item live-updates the filename as you type, appending `.md` if missing.
- **Toast.** Bottom-right, `fg`-on-`bg` inverted pill-less card (8px radius), 14px weight 600, with a green check icon. Slides up 100px and fades over 200ms; auto-dismisses at 3000ms.
- **Buttons.** `btn-warm` is the default action button: `surface-warm` fill, 1px border, 8px radius, 8×12 padding, 14px weight 600, icon+label, border lifts to foreground on hover. The `chat-send-btn` is the only accent-filled button: 32px square, accent fill, accent-on glyph, 8px radius, hover to `accent-hover`.
- **Panel toggle button.** 32px square icon button, 1px border, 8px radius, muted icon; hover lifts border and icon to foreground. The sound toggle has a `.muted` variant that recolors border and icon to danger red.

## Do's and Don'ts

### Do:
- **Do** reserve Dragon Fire Green (`#2cf575`) for live, actionable, or agent-active surfaces only — active thread rail, send button, spec badge, graph pulse, diff additions, focus ring.
- **Do** set file paths, timestamps, line numbers, kbd hints, and uppercase micro-labels in the monospace voice; set prose and UI labels in the sans voice.
- **Do** use the 8px radius for controls and the 16px radius for cards/chat bubbles/diff panels; use the pill (`9999px`) only for status dots, badges, and the scrollbar thumb.
- **Do** collapse the sidebars by sliding them out with a negative margin over 200ms so the workspace reclaims their space — do not overlay them on the workspace at desktop width.
- **Do** signal mode through the banner + avatar treatment + chat content shape as a single coordinated state change.
- **Do** cross-fade positioned panes (`opacity` over 150ms) when switching workspace or right-sidebar tabs.
- **Do** invert the toast (`fg`-on-`bg`) so it reads as a system utterance distinct from the dark chrome.

### Don't:
- **Don't** introduce a second brand chromatic color. Twilight Glow is the only green-adjacent tone; everything else is neutral or semantic status.
- **Don't** shadow resting panels. Shadows are for floating layers only (command bar, toast, handoff console, active mode button).
- **Don't** set prose in monospace or file paths in the sans — the two-voice split is load-bearing.
- **Don't** use a radius other than 8px, 16px, or pill. The 6px mode-pill inset is the sole exception and is reserved for the segmented control.
- **Don't** add gradients except the Spec Mode banner's twilight-glow gradient — the rest of the field is flat color.
- **Don't** use the accent for borders, dividers, or static chrome; the border color (`#22242b`) is the only divider.
- **Don't** promote the right sidebar to open-by-default; it is collapsed by default so the workspace and chat dominate the first viewport.
