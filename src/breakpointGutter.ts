import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { Breakpoint } from "./api";

/** Replaces every breakpoint shown in this view. */
export const setBreakpoints = StateEffect.define<Breakpoint[]>();

/** The line the program is stopped on, or null when it is running. */
export const setDebugLine = StateEffect.define<number | null>();

const breakpointField = StateField.define<Breakpoint[]>({
  create: () => [],
  update(current, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setBreakpoints)) continue;
      // Clamped to the document: breakpoints outlive the edits that shrink a
      // file, and `doc.line()` past the end throws.
      const lines = transaction.state.doc.lines;
      return effect.value.filter((b) => {
        const line = b.actualLine ?? b.line;
        return line >= 1 && line <= lines;
      });
    }
    return current;
  },
});

const debugLineField = StateField.define<number | null>({
  create: () => null,
  update(current, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setDebugLine)) continue;
      const line = effect.value;
      if (line == null || line < 1 || line > transaction.state.doc.lines) return null;
      return line;
    }
    return current;
  },
});

export function breakpointsFor(state: {
  field: (f: typeof breakpointField) => Breakpoint[];
}) {
  return state.field(breakpointField);
}

/** Where a breakpoint really is: what the adapter bound, or where the user
 *  put it while nothing has said otherwise. */
export function effectiveLine(breakpoint: Breakpoint): number {
  return breakpoint.actualLine ?? breakpoint.line;
}

/**
 * How confident we are about this breakpoint, as four distinct states.
 *
 * "Never sent to an adapter" is deliberately its own state rather than being
 * folded into "rejected": a breakpoint set before a debug session starts is
 * not broken, and drawing it as broken would make every pre-launch
 * breakpoint look wrong.
 */
function stateOf(breakpoint: Breakpoint): "verified" | "rejected" | "unknown" | "disabled" {
  if (!breakpoint.enabled) return "disabled";
  if (breakpoint.verified === true) return "verified";
  if (breakpoint.verified === false) return "rejected";
  return "unknown";
}

class BreakpointMarker extends GutterMarker {
  constructor(
    private readonly breakpoint: Breakpoint,
    private readonly line: number
  ) {
    super();
  }
  toDOM() {
    const dot = document.createElement("span");
    const state = stateOf(this.breakpoint);
    dot.className = `ds-breakpoint is-${state}`;
    dot.dataset.line = String(this.line);
    dot.dataset.state = state;
    dot.textContent = "●";
    const moved =
      this.breakpoint.actualLine != null && this.breakpoint.actualLine !== this.breakpoint.line
        ? ` (moved from line ${this.breakpoint.line})`
        : "";
    const reason = this.breakpoint.message ? ` — ${this.breakpoint.message}` : "";
    const condition = this.breakpoint.condition ? ` when ${this.breakpoint.condition}` : "";
    dot.title = `Breakpoint at line ${this.line}${condition}${moved}${reason}`;
    return dot;
  }
}

const currentLineDecoration = Decoration.line({ class: "ds-debug-current" });

const currentLineHighlight = EditorView.decorations.compute(
  [debugLineField],
  (state) => {
    const line = state.field(debugLineField);
    const builder = new RangeSetBuilder<Decoration>();
    if (line != null) builder.add(state.doc.line(line).from, state.doc.line(line).from, currentLineDecoration);
    return builder.finish();
  }
);

/**
 * The breakpoint column, plus the highlight for the line execution is
 * stopped on.
 *
 * `onToggle` fires on a gutter click with the 1-based line, which is the
 * whole gesture — a click either places a breakpoint or removes one.
 */
export function breakpointGutter(onToggle: (line: number) => void): Extension {
  return [
    breakpointField,
    debugLineField,
    currentLineHighlight,
    gutter({
      class: "ds-breakpoint-col",
      lineMarker(view, block) {
        const line = view.state.doc.lineAt(block.from).number;
        const hit = view.state
          .field(breakpointField)
          .find((b) => effectiveLine(b) === line);
        return hit ? new BreakpointMarker(hit, line) : null;
      },
      lineMarkerChange: (update) =>
        update.transactions.some((t) =>
          t.effects.some((e) => e.is(setBreakpoints) || e.is(setDebugLine))
        ),
      // No initialSpacer: it renders a real marker into the DOM, which reads
      // as a breakpoint that isn't there. The column's width is reserved in
      // CSS instead.
      domEventHandlers: {
        mousedown(view, block) {
          onToggle(view.state.doc.lineAt(block.from).number);
          return true;
        },
      },
    }),
    EditorView.baseTheme({
      ".ds-breakpoint-col": { minWidth: "14px", cursor: "pointer" },
      ".ds-breakpoint": { fontSize: "11px", lineHeight: "1" },
      ".ds-breakpoint.is-verified": { color: "var(--danger, #e5484d)" },
      // Unknown = not yet sent to an adapter. Hollowed rather than coloured
      // like a rejection, which it isn't.
      ".ds-breakpoint.is-unknown": { color: "var(--danger, #e5484d)", opacity: "0.55" },
      ".ds-breakpoint.is-rejected": { color: "var(--warn)" },
      ".ds-breakpoint.is-disabled": { color: "var(--muted)", opacity: "0.5" },
      ".ds-debug-current": {
        background: "color-mix(in oklab, var(--warn), transparent 82%)",
      },
    }),
  ];
}
