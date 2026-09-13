---
name: Palisade Code
description: A minimalist, intuitive workbench for orchestrating ACP agents.
colors:
  backdrop: "oklch(11% 0.015 var(--accent-hue, 145))"
  chrome-bg: "oklch(15% 0.004 250)"
  workbench-charcoal: "oklch(18% 0.005 250)"
  editor-bg: "oklch(20% 0.005 250)"
  surface: "oklch(22% 0.006 250)"
  surface-warm: "oklch(26% 0.008 250)"
  selected-surface: "oklch(24% 0.02 var(--accent-hue, 145))"
  foreground: "oklch(96% 0.003 250)"
  muted: "oklch(66% 0.012 250)"
  border: "oklch(30% 0.01 250)"
  agent-signal: "oklch(88% 0.21 var(--accent-hue, 145))"
  agent-signal-ink: "oklch(20% 0.03 var(--accent-hue, 145))"
  twilight-glow: "oklch(18% 0.03 var(--accent-hue, 145))"
  success: "oklch(72% 0.15 160)"
  warning: "oklch(76% 0.15 65)"
  danger: "oklch(64% 0.22 25)"
  danger-ink: "oklch(98% 0.02 25)"
typography:
  display:
    fontFamily: '"Geist Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: '"Geist Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: '"Geist Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.4
  subhead:
    fontFamily: '"Geist Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  micro:
    fontFamily: '"Geist Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.05em"
  mono:
    fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace'
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
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
  button-primary:
    backgroundColor: "{colors.agent-signal}"
    textColor: "{colors.agent-signal-ink}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  input:
    backgroundColor: "{colors.surface-warm}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "6px 10px"
  active-navigation:
    backgroundColor: "{colors.selected-surface}"
    textColor: "{colors.agent-signal}"
    rounded: "{rounded.sm}"
    size: "32px"
  composer-picker:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "34px"
  command-chip:
    backgroundColor: "{colors.selected-surface}"
    textColor: "{colors.agent-signal}"
    rounded: "{rounded.pill}"
    padding: "3px 8px"
  project-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "{spacing.xl}"
  chain-node:
    backgroundColor: "{colors.surface-warm}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
---

# Design System: Palisade Code

## Overview

**Creative North Star: "The Minimalist, Intuitive Agent Workbench"**

Palisade Code should feel like an idyllic place to do serious work: ordered, calm, and quietly alive. Dense tools sit in a legible hierarchy of neutral planes, while Agent Signal marks the current selection, live process, or next meaningful action. The result is minimalist without becoming anhedonic—visual pleasure comes from clarity, responsive state, and moments of restrained warmth rather than ornament.

The system practices quietly tactile restraint. Controls answer with a tonal lift, a crisp focus halo, or a short transition; running sessions pulse softly; chain nodes change state with deliberate color; onboarding carries one ambient glow. Those responses make the workbench feel inhabited while keeping attention on code, agents, and evidence.

Editor and Vibe are two arrangements of the same mounted workspace rather than separate identities. The theme can move between dark and light, and users can change the accent hue, shell colors, editor colors, and editor font without breaking the hierarchy.

**Key Characteristics:**

- Compact desktop density with a 36px utility chrome, a 44px activity rail, and resizable work surfaces.
- Themeable neutral planes organized around one configurable Agent Signal accent.
- Human-readable sans text paired with mono for code, paths, commands, values, and technical status.
- Borders and tonal steps at rest; shadow only for floating context or an intentional active lift.
- Quiet tactile feedback through 120–180ms transitions, focus halos, state pulses, and restrained ambient motion.

## Colors

The default dark palette begins with Workbench Charcoal and cool, near-neutral structural planes. Light mode mirrors the same semantic roles with pale, low-chroma surfaces. Agent Signal follows the user-selected accent hue, so the system names color by purpose rather than assuming green is permanent.

### Primary

- **Agent Signal:** Reserved for selected, focused, live, agent-touched, or primary-action state.
- **Agent Signal Ink:** Maintains readable content on a solid signal fill.
- **Selected Surface:** Carries low-intensity selection without competing with the foreground.

### Neutral

- **Workbench Charcoal:** The dark-mode working canvas and tonal anchor.
- **Chrome, Editor, Surface, and Warm Surface:** Form a closely stepped hierarchy for navigation, work areas, panels, controls, and hover lift.
- **Foreground, Muted, and Border:** Separate primary content, secondary context, and structural boundaries.

### Semantic and code color

- **Success, Warning, and Danger:** Communicate outcomes and risk only when paired with language, a glyph, or an icon.
- Syntax colors remain independent of application state so code meaning never competes with agent state.

**The One Signal Rule.** Agent Signal marks attention and state, never decoration; routine chrome and inactive controls remain neutral.

**The Theme-by-Role Rule.** New colors must preserve their semantic role in dark, light, and user-customized themes instead of depending on one fixed hue.

**The Reserved Hue Rule.** `--danger` (25), `--warn` (65) and `--success` (160) own their hues. An accent hue a user can select must clear every one of them by at least 30 degrees, so that Agent Signal never reads as a status.

The rule is about hue rather than lightness because light mode has no room on the lightness axis. In dark, Agent Signal separates by sitting at 88% against a semantic band of 64-76%. Light mode's accent sits at 46%, inside its 42-48% band, and cannot move down: measured in the running app at 38% and again at 30%, the sRGB gamut collapses chroma across the warm quadrant and Amber, Rose, Red and Orange all converge on the same brown. It cannot move up either without inverting `--accent-on` from light ink to dark, which is a different change.

So the presets clear the semantics instead. Red (25) sat on `--danger` exactly and Orange (55) ten degrees off `--warn`; both are replaced by Lime (120) and Magenta (325). Dragon Green stays at 145, fifteen degrees from `--success`, as a stated exception: it is the product's identity colour, and `--success` only ever draws as a thin chain-node border, never as a fill beside an accent fill.

## Typography

**Display Font:** Geist Sans, Inter, then the system sans stack.

**Body Font:** Geist Sans, Inter, then the system sans stack.

**Label/Mono Font:** The platform UI monospace stack, led by SF Mono on macOS when available.

**Character:** Sentence-level language is calm and direct in sans. Anything a developer scans, copies, compares, or parses moves to mono, creating a natural boundary between explanation and operation.

### Hierarchy

- **Display:** Sparse onboarding and introductory headings only; it should never become the default working rhythm.
- **Body:** Messages, descriptions, and ordinary interface prose.
- **Label:** Compact controls, panel headings, and short action language.
- **Subhead:** Empty-state headings and prominent single-field inputs — the one step between Body and Display. Already shipped as Mantine's `xl` in `main.tsx`; named here so it stops reading as an off-scale deviation.
- **Micro:** Metadata, uppercase section labels, state text, and keyboard chords.
- **Mono:** Code, paths, terminal output, tabs, branches, values, and tabular technical data.

**The Read/Run Rule.** Use sans for understanding and mono for operating.

## Layout

The application fills a desktop window beneath a fixed utility bar. A narrow activity rail opens one task-focused side panel beside the main editor and chat workspace; a terminal and problems region can rise from the bottom. Editor prioritizes files and code, while Vibe reorders the same surfaces to prioritize sessions and conversation.

The spacing rhythm is compact and deliberate. Small steps structure rows, icon groups, labels, and inline controls; larger steps are reserved for messages, overlays, onboarding cards, and breathing room around primary decisions. Resizable regions preserve user choice, while collapsed regions leave the flex layout entirely rather than covering content.

At narrower desktop widths, the session list yields first, then fixed side widths compress, then the side panel hides while the activity rail remains available. The shell protects a usable editor/chat surface before preserving every simultaneous column.

**The One Workspace Rule.** Editor and Vibe may reorder or emphasize surfaces, but they must share the same component vocabulary, state language, and mounted project context.

## Elevation & Depth

Resting UI is flat. Closely stepped neutral surfaces and one-pixel borders create everyday depth. Menus, palettes, tooltips, modals, and floating inspectors receive compact ambient shadow; the onboarding composer earns a softer Agent Signal lift only while focused. Modal scrims are dark and lightly blurred.

The tactile quality comes from response rather than permanent elevation. Hover lifts one tonal step, focus adds the shared signal halo, and pressed or selected state resolves immediately. Motion is short for operational state, slower only for the onboarding ambience, and removed when the operating system requests reduced motion.

### Shadow Vocabulary

- **Focus Halo:** A two-pixel Agent Signal mix around every keyboard-focusable control.
- **Floating Context:** A compact ambient shadow for menus, palettes, and tooltips.
- **Prominent Float:** A larger ambient shadow for popovers and floating inspectors.
- **Focused Composer:** A low-chroma signal shadow that makes the primary input feel awake.

**The Resting-Plane Rule.** Shadows indicate a floating layer or a deliberate active lift, never an ordinary panel, row, tab, or card.

## Shapes

The form language is gently compact rather than soft or bubbly. Small rows and chips use the tightest curves; controls, tabs, and rail buttons use a modest curve; composers, palettes, canvases, and cards use the medium curve; the transparent desktop window carries the largest curve. Pills are reserved for modes, compact status, and removable command tokens.

Borders are functional separators. Editor and panel surfaces remain square where they meet so the workspace reads as one fitted instrument rather than a stack of floating cards. Accent edges are thin state indicators, not decoration.

## Components

### Buttons

- **Shape:** Compact and gently curved, with enough padding for confident activation.
- **Primary:** Agent Signal fill with matched signal ink, reserved for the one dominant action in a local decision.
- **Ghost:** Transparent and muted at rest; hover lifts to foreground and, where appropriate, a warmer surface.
- **Hover / Focus:** A short tonal response and the universal focus halo. Disabled state reduces opacity without erasing the label.

### Chips

- **Style:** Compact pills bind a selected command, agent, model, mode, or status to nearby content.
- **State:** Neutral chips remain quiet. A selected command uses Selected Surface and Agent Signal; chain commands use the code-keyword hue so their different execution meaning is not colorless.

### Cards / Containers

- **Corner Style:** Medium curves for onboarding choices, Graphify canvases, composers, and floating containers; fitted workspace panes remain square.
- **Background:** Surface at rest and Warm Surface on interactive lift.
- **Shadow Strategy:** Flat by default; shadow follows the elevation rules above.
- **Border:** One-pixel structural boundaries, strengthened with an Agent Signal mix for primary or focused state.
- **Internal Padding:** Compact in operating surfaces and more generous on onboarding choices.

### Inputs / Fields

- **Style:** Warm Surface fill, foreground text, muted placeholder, structural border, and compact control height.
- **Focus:** One signal-colored edge plus the shared halo; composite composers apply focus to the whole container.
- **Error / Disabled:** Error uses Danger with explanatory text; disabled state remains legible at reduced opacity.

### Navigation

The activity rail uses muted Tabler icons in compact square targets. Hover adds a neutral lift; active state combines Selected Surface, Agent Signal, and a thin inset edge that follows the work-facing side when the shell reverses. Tabs use mono labels and lift onto their content plane; flatter chat and bottom tabs use an accent edge or underline.

### Agent Chain Node

Chain nodes are neutral workbench tiles until execution gives one node Agent Signal priority. Completed nodes keep only a quiet success border, retrying nodes use warning, and failed nodes use danger. Ports remain hidden until hover or keyboard focus so the canvas stays readable at rest.

### Conversation

Chat is one continuous working log rather than a stack of decorative cards. Agent turns gain a quiet Twilight Glow avatar; user turns remain comparatively bare. Tool calls, permissions, file edits, and failures share a compact container grammar and make their state explicit in text.

## Do's and Don'ts

### Do:

- **Do** reserve Agent Signal for selected, focused, live, agent-touched, or primary-action state.
- **Do** create delight through immediate tactile response, excellent alignment, and calm transitions.
- **Do** preserve the established compact spacing, radius, and type scales across CSS and Mantine components.
- **Do** make every custom interactive row keyboard-operable with hover, focus, and an accessible name.
- **Do** pair semantic color with wording, an icon, or a glyph.
- **Do** use Mantine and Tabler before introducing a new control or icon language.

### Don't:

- **Don't** make minimalism emotionally vacant; retain warmth in active, successful, and first-run moments.
- **Don't** assume a fixed brand hue or allow a stock library blue to leak into the shell.
- **Don't** place shadows on resting panels, rows, tabs, or ordinary cards.
- **Don't** use Selected Surface as generic hover feedback; hover remains neutral so selection stays distinct.
- **Don't** turn every tool into a floating card or place heavy editable content inside a navigation panel.
- **Don't** rely on placeholders, color alone, or agent narration to explain an action or state.
