---
name: Palisade Code
description: A configurable, dense desktop workbench for coding-agent work.
colors:
  chrome-bg: "oklch(15% 0.004 250)"
  bg: "oklch(18% 0.005 250)"
  editor-bg: "oklch(20% 0.005 250)"
  surface: "oklch(22% 0.006 250)"
  surface-warm: "oklch(26% 0.008 250)"
  active-row: "oklch(24% 0.02 var(--accent-hue, 145))"
  fg: "oklch(96% 0.003 250)"
  muted: "oklch(66% 0.012 250)"
  border: "oklch(30% 0.01 250)"
  accent: "oklch(88% 0.21 var(--accent-hue, 145))"
  accent-on: "oklch(20% 0.03 var(--accent-hue, 145))"
  success: "oklch(72% 0.15 160)"
  warn: "oklch(76% 0.15 65)"
  danger: "oklch(64% 0.22 25)"
typography:
  body:
    fontFamily: '"Geist Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: '"Geist Sans", Inter, system-ui, sans-serif'
    fontSize: "11px"
    fontWeight: 600
  mono:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace'
    fontSize: "12px"
    fontWeight: 400
rounded:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
components:
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    size: "32px"
  active-navigation:
    backgroundColor: "{colors.active-row}"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    size: "32px"
  modal:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
---

# Design System: Palisade Code

## Overview

**Creative North Star: "The Adaptive Agent Workbench"**

Palisade Code is a compact desktop environment for directing agents and inspecting the work they produce. Its visual language is operational rather than branded: quiet neutral planes establish a stable field, precise borders divide dense information, and a configurable accent singles out the one thing that needs attention now. The interface stays recognizably one product when a user changes its accent, shell palette, editor colors, or light/dark scheme.

The two workspace arrangements have different priorities, not different identities. Editor prioritizes files and code; Vibe prioritizes conversation and sessions. They share one mounted structure, one token system, and one component vocabulary.

**Key Characteristics:**

- Native desktop-density: a 36px utility chrome, 44px activity rail, compact rows, and resizable task surfaces.
- A neutral, themeable foundation with user-selectable accent and editor/shell palettes.
- Sans for readable language and mono for code, paths, commands, values, labels, and status.
- Borders and tonal steps create resting hierarchy; shadow is reserved for floating context.
- Standard controls come from Mantine and icons from Tabler.

## Colors

The default is a cool dark workbench; light mode mirrors every shell and syntax role. `--accent-hue` defaults to 145 but Settings exposes green, blue, violet, amber, rose, teal, red, and orange choices. The color system must therefore describe roles rather than assuming one permanent brand hue.

### Primary

- **Active Accent** (`oklch(88% 0.21 var(--accent-hue, 145))`): selection, keyboard focus, active navigation, and live agent state.
- **Accent Ink** (`oklch(20% 0.03 var(--accent-hue, 145))`): content on an accent fill.
- **Selected Surface** (`oklch(24% 0.02 var(--accent-hue, 145))`): low-intensity selection fill.

### Neutral

- **Chrome** (`oklch(15% 0.004 250)`), **canvas** (`oklch(18% 0.005 250)`), and **editor** (`oklch(20% 0.005 250)`) establish the structural planes.
- **Surface** (`oklch(22% 0.006 250)`) and **raised surface** (`oklch(26% 0.008 250)`) distinguish panels, controls, and hover lifts.
- **Foreground**, **muted**, and **border** provide normal hierarchy and 1px separation.

### Semantic and code color

- Success, warning, and danger (`oklch(72% 0.15 160)`, `oklch(76% 0.15 65)`, `oklch(64% 0.22 25)`) always appear with a label, glyph, or icon.
- Syntax colors are independent of application state: violet keywords, green atoms, amber numbers/functions, orange strings, blue variables, teal types, and muted comments.

**The Active-Only Rule.** Accent color marks attention and state, not decoration. Inactive chrome, borders, and routine buttons remain neutral.

## Typography

**Body Font:** Geist Sans, Inter, then the system sans stack.

**Mono Font:** `ui-monospace`, SF Mono, JetBrains Mono, then platform fallbacks.

**Character:** Text that a person reads as a sentence uses the sans voice. Text that a developer scans, copies, or parses uses mono.

### Hierarchy

- **Body** (400, 13px, 1.5): messages, descriptions, and ordinary UI text.
- **Label** (600, 11px): compact controls and panel headings.
- **Mono** (400, 12px): code, paths, terminal, tabs, and values.
- **Micro label** (600, 10px): metadata, status, keyboard chords, and uppercase section labels.
- **Display** (700, 21px): sparse introductory headings, never the default working rhythm.

**The Read/Run Rule.** Sans is for understanding; mono is for operating.

## Layout

The shell fills the window below a 36px top bar. A permanent 44px activity rail exposes twelve destinations: Explorer, Search, Source Control, Workspace, Specs, Codebase Map, Run, MCP, Database, Chains, History, and Settings. The selected destination uses a consistent compact side-panel head/body structure.

Editor orders the workspace as rail → panel → editor → chat. Vibe rearranges the same nodes so sessions and chat lead, followed by editor, panel, and rail. The terminal/problems tray is a resizable bottom region with a 220px default. All collapsible rails exit the flex layout rather than covering work behind them.

Spacing is fixed at 4, 6, 8, 12, and 16px. Dense control groups use the smaller steps; introductory/overlay surfaces use the larger ones.

## Elevation & Depth

Resting UI is flat. Closely stepped neutral surfaces and the border token create hierarchy. Palettes, modals, tooltips, and context menus use `0 4px 20px rgba(0, 0, 0, 0.35)`; prominent popovers use `0 8px 24px rgba(0, 0, 0, 0.35)`. Modal scrims use `rgba(0, 0, 0, 0.68)` and blur.

Every native control and keyboard-operable custom row uses the same visible focus recipe: `0 0 0 2px color-mix(in oklab, var(--accent), transparent 55%)`. Motion is a short 120–180ms state transition and is reduced when the OS asks for reduced motion.

**The Resting-Plane Rule.** Shadows signal a floating layer or a deliberate active lift—not ordinary panels, rows, or tabs.

## Shapes

Use 4px for rows and small chips, 6px for controls/tabs/rail buttons, 8px for command and composer surfaces, 12px for the outer window, and 9999px for pills and circular controls. Editor and panel surfaces remain square. The active rail marker and active-thread inset are 2px state indicators, not an alternate border style.

## Components

### Navigation and side panels

Rail controls are 32px muted Tabler icons. Hover introduces a neutral raised surface; active state adds the selected surface and a 2px accent edge on the work-facing side. Source Control adds a warning dot for uncommitted work. Side panels share an uppercase 11px header and scrollable body.

### Tabs, rows, and badges

Editor tabs are compact mono labels; the active tab lifts onto the editor plane with a 6px top edge. Bottom and chat-rail tabs stay flatter with an accent underline. Lists and tree rows share keyboard activation, 4px corners, neutral hover/focus lift, and the global focus ring. Badges combine text and color in an uppercase mono pill.

### Inputs and overlays

Mantine `Modal`, `Menu`, input, select, button, and popover primitives are the baseline. Controls use 6px corners, raised-surface fill, and border-token outlines. Transient actions share a common modal/scrim family; command, file, and text-search palettes use the same compact row rhythm.

### Operational surfaces

Chat reads as one continuous log: assistant turns use a quiet avatar treatment, user turns are comparatively bare, and tool/permission/error/file-edit events share a 6px container logic. Diff rows pair color with `+` and `−`. A chain canvas remains neutral until a live node receives selected-surface fill and the accent role.

The Graphify view is a bordered 8px canvas with floating tooltip treatment. Database grids inherit the workbench's table variables and truncate oversized values instead of sacrificing the surrounding workspace.

## Do's and Don'ts

### Do:

- **Do** use the active accent for selected, focused, live, or agent-touched state only.
- **Do** preserve the 4/6/8/12/9999px radius scale and 4/6/8/12/16px spacing scale.
- **Do** make every custom interactive row keyboard-operable with hover, focus, and an accessible name.
- **Do** use Mantine and Tabler before adding a custom control or icon implementation.
- **Do** pair semantic color with wording, an icon, or a glyph.

### Don't:

- **Don't** assume a fixed brand hue; the user can change the active accent and shell palette.
- **Don't** add a second local palette or let a stock library blue leak into the shell.
- **Don't** put shadows on resting panels, rows, or tabs.
- **Don't** use selected-surface color as plain hover feedback.
- **Don't** put heavy editable content inside a navigation side panel.
- **Don't** rely on placeholders or color alone to explain an action or state.
