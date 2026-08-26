import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  breakpointGutter,
  effectiveLine,
  breakpointsFor,
  setBreakpoints,
  setDebugLine,
} from "../breakpointGutter";
import type { Breakpoint } from "../api";

const bp = (over: Partial<Breakpoint> = {}): Breakpoint => ({
  path: "src/lib.rs",
  line: 9,
  enabled: true,
  condition: null,
  verified: null,
  actualLine: null,
  message: null,
  ...over,
});

const viewWith = (lines: number, onToggle = vi.fn()) =>
  new EditorView({
    state: EditorState.create({
      doc: Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n"),
      extensions: [breakpointGutter(onToggle)],
    }),
  });

describe("breakpointGutter", () => {
  it("holds the breakpoints it is given", () => {
    const view = viewWith(20);
    expect(breakpointsFor(view.state)).toHaveLength(0);
    view.dispatch({ effects: setBreakpoints.of([bp(), bp({ line: 12 })]) });
    expect(breakpointsFor(view.state).map((b) => b.line)).toEqual([9, 12]);
    view.destroy();
  });

  it("drops breakpoints past the end of the file rather than throwing", () => {
    // A file shrank under a stored breakpoint — normal after an edit.
    const view = viewWith(5);
    view.dispatch({ effects: setBreakpoints.of([bp({ line: 999 }), bp({ line: 3 })]) });
    expect(breakpointsFor(view.state).map((b) => b.line)).toEqual([3]);
    view.destroy();
  });

  it("draws a moved breakpoint where the adapter actually bound it", () => {
    // Placed on a blank line, slid to the next statement. Drawing it where
    // the user clicked would be a lie about where execution stops.
    const view = viewWith(20);
    view.dispatch({
      effects: setBreakpoints.of([bp({ line: 7, actualLine: 9, verified: true })]),
    });
    const marks = view.dom.querySelectorAll(".ds-breakpoint");
    expect(marks.length).toBe(1);
    expect(marks[0].getAttribute("data-line")).toBe("9");
    view.destroy();
  });

  it("distinguishes verified, rejected, unknown and disabled breakpoints", () => {
    const view = viewWith(20);
    view.dispatch({
      effects: setBreakpoints.of([
        bp({ line: 1, verified: true }),
        bp({ line: 2, verified: false, message: "no code here" }),
        bp({ line: 3, verified: null }),
        bp({ line: 4, enabled: false }),
      ]),
    });
    const states = [...view.dom.querySelectorAll(".ds-breakpoint")].map((el) =>
      el.getAttribute("data-state"),
    );
    // "not sent to an adapter yet" is not the same as "rejected", and must
    // not be drawn as one.
    expect(states).toEqual(["verified", "rejected", "unknown", "disabled"]);
    view.destroy();
  });

  it("explains a rejected breakpoint in its tooltip", () => {
    const view = viewWith(20);
    view.dispatch({
      effects: setBreakpoints.of([bp({ line: 2, verified: false, message: "no code here" })]),
    });
    expect(view.dom.querySelector(".ds-breakpoint")?.getAttribute("title")).toContain(
      "no code here",
    );
    view.destroy();
  });

  it("renders a breakpoint column for the click target", () => {
    // The click itself isn't asserted here: jsdom performs no layout, so
    // CodeMirror renders zero `.cm-gutterElement`s and there is nothing to
    // dispatch on. What the handler does with a click is one expression
    // (`doc.lineAt(block.from).number`), covered by `effectiveLine` below
    // and by the dogfood pass.
    const view = viewWith(20);
    expect(view.dom.querySelector(".ds-breakpoint-col")).not.toBeNull();
    view.destroy();
  });

  it("reports where a breakpoint really is", () => {
    expect(effectiveLine(bp({ line: 7 }))).toBe(7);
    expect(effectiveLine(bp({ line: 7, actualLine: 9 }))).toBe(9);
  });

  it("highlights the line the program is stopped on, and clears it on continue", () => {
    const view = viewWith(20);
    view.dispatch({ effects: setDebugLine.of(6) });
    expect(view.dom.querySelectorAll(".ds-debug-current").length).toBeGreaterThan(0);

    view.dispatch({ effects: setDebugLine.of(null) });
    expect(view.dom.querySelectorAll(".ds-debug-current")).toHaveLength(0);
    view.destroy();
  });

  it("ignores a stopped line outside the document rather than throwing", () => {
    const view = viewWith(3);
    view.dispatch({ effects: setDebugLine.of(500) });
    expect(view.dom.querySelectorAll(".ds-debug-current")).toHaveLength(0);
    view.destroy();
  });
});
