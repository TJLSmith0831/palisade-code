import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  PREFIX_BUDGET_CHARS,
  SUFFIX_BUDGET_CHARS,
  acceptGhostText,
  dismissGhostText,
  extractContext,
  fimCompletion,
  GhostTextWidget,
  ghostTextState,
  setGhostText,
  stripStarterOverlap,
} from "../completion/GhostTextPlugin";

describe("GhostTextPlugin", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(new Error("no mock"));
  });

  function viewWith(doc: string, sel: number) {
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: sel },
        extensions: fimCompletion(
          { enabled: true, acceptKeybinding: "Alt-Tab" },
          "abc",
          "src/foo.ts"
        ),
      }),
    });
    return view;
  }

  it("fimCompletion returns an array of extensions", () => {
    const ext = fimCompletion(
      { enabled: true, acceptKeybinding: "Alt-Tab" },
      "abc",
      "src/foo.ts"
    );
    expect(Array.isArray(ext)).toBe(true);
    expect(ext.length).toBeGreaterThan(0);
  });

  it("extractContext returns prefix and suffix around the cursor", () => {
    const view = viewWith("function add() {\n  \n}", 18);
    const ctx = extractContext(view);
    expect(ctx.pos).toBe(18);
    expect(ctx.prefix).toBe("function add() {\n ");
    expect(ctx.suffix).toBe(" \n}");
  });

  it("extractContext is budgeted to prefix/suffix limits", () => {
    const prefix = "a".repeat(PREFIX_BUDGET_CHARS + 50);
    const suffix = "b".repeat(SUFFIX_BUDGET_CHARS + 50);
    const view = viewWith(prefix + "|" + suffix, prefix.length + 1);
    const ctx = extractContext(view);
    expect(ctx.prefix.length).toBeLessThanOrEqual(PREFIX_BUDGET_CHARS);
    expect(ctx.suffix.length).toBeLessThanOrEqual(SUFFIX_BUDGET_CHARS);
  });

  it("shows ghost text after dispatching a setGhostText effect", () => {
    const view = viewWith("function add() {\n  \n}", 18);
    view.dispatch({
      effects: setGhostText.of({
        text: "return x + y;",
        from: 18,
        keybinding: "Alt-Tab",
      }),
    });
    const ghost = view.state.field(ghostTextState);
    expect(ghost).toEqual({
      text: "return x + y;",
      from: 18,
      keybinding: "Alt-Tab",
    });
  });

  it("acceptGhostText inserts the completion and clears it", () => {
    const view = viewWith("function add() {\n  \n}", 19);
    view.dispatch({
      effects: setGhostText.of({
        text: "return x + y;",
        from: 19,
        keybinding: "Alt-Tab",
      }),
    });
    const accepted = acceptGhostText(view);
    expect(accepted).toBe(true);
    expect(view.state.field(ghostTextState)).toBeNull();
    expect(view.state.doc.toString()).toBe(
      "function add() {\n  return x + y;\n}"
    );
    expect(view.state.selection.main.head).toBe(32);
  });

  it("acceptGhostText does nothing when no ghost text is shown", () => {
    const view = viewWith("hello", 5);
    const accepted = acceptGhostText(view);
    expect(accepted).toBe(false);
  });

  it("dismissGhostText clears the ghost text", () => {
    const view = viewWith("function add() {\n  \n}", 18);
    view.dispatch({
      effects: setGhostText.of({
        text: "return x + y;",
        from: 18,
        keybinding: "Alt-Tab",
      }),
    });
    const dismissed = dismissGhostText(view);
    expect(dismissed).toBe(true);
    expect(view.state.field(ghostTextState)).toBeNull();
    expect(view.state.doc.toString()).toBe("function add() {\n  \n}");
  });

  it("dismissGhostText does nothing when no ghost text is shown", () => {
    const view = viewWith("hello", 5);
    const dismissed = dismissGhostText(view);
    expect(dismissed).toBe(false);
  });

  it("typing schedules and shows a completion after the debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invokeMock.mockResolvedValue({
      completion: "return x + y;",
      modelLatencyMs: 12.34,
    });

    const view = viewWith("function add() {\n  \n}", 18);
    view.dispatch({
      changes: { from: 18, to: 18, insert: "r" },
      selection: { anchor: 19 },
      userEvent: "input.type",
    });

    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => view.state.field(ghostTextState) !== null, {
      timeout: 2000,
    });

    const ghost = view.state.field(ghostTextState);
    // Prefix ends in "r"; the model regenerated "return x + y;". The leading
    // "r" is stripped so accepting yields "return x + y;" rather than "rreturn".
    expect(ghost?.text).toBe("eturn x + y;");

    vi.useRealTimers();
    view.destroy();
  });

  it("hitting Enter schedules and shows a completion after the debounce", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invokeMock.mockResolvedValue({
      completion: "\n    ZZZZ",
      modelLatencyMs: 12.34,
    });

    const view = viewWith("if XXXX:\n    YYYY\nelse:", 23);
    // Simulate Enter: insert newline and move cursor. CodeMirror uses "input"
    // for Enter in some configurations; we accept any userEvent.
    view.dispatch({
      changes: { from: 23, to: 23, insert: "\n" },
      selection: { anchor: 24 },
      userEvent: "input",
    });

    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => view.state.field(ghostTextState) !== null, {
      timeout: 2000,
    });

    const ghost = view.state.field(ghostTextState);
    expect(ghost?.text).toBe("\n    ZZZZ");

    vi.useRealTimers();
    view.destroy();
  });

  it("moving the cursor dismisses ghost text", async () => {
    const view = viewWith("function add() {\n  \n}", 18);
    view.dispatch({
      effects: setGhostText.of({
        text: "return x + y;",
        from: 18,
        keybinding: "Alt-Tab",
      }),
    });
    view.dispatch({
      selection: { anchor: 0 },
      userEvent: "select",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(view.state.field(ghostTextState)).toBeNull();
  });

  describe("stripStarterOverlap", () => {
    it("strips a fully-regenerated starter word (the reported fromfrom bug)", () => {
      // User typed "from"; model regenerated "from fastmcp.client ...".
      // Ghost text must drop the leading "from" so accept yields "from fastmcp..."
      // instead of "fromfrom fastmcp...".
      expect(
        stripStarterOverlap("from", "from fastmcp.client import Client")
      ).toBe(" fastmcp.client import Client");
    });

    it("strips a regenerated starter when prefix has trailing whitespace", () => {
      // User typed "import " (keyword + space); model regenerated "import os".
      // Strip "import " (incl. one space) so accept yields "import os", not "import  os".
      expect(stripStarterOverlap("import ", "import os")).toBe("os");
    });

    it("strips a partial overlap (typed 'fr', completion 'from ...')", () => {
      expect(
        stripStarterOverlap("fr", "from fastmcp.client import Client")
      ).toBe("om fastmcp.client import Client");
    });

    it("does not strip when there is no overlap", () => {
      expect(stripStarterOverlap("def ", "return x + y;")).toBe(
        "return x + y;"
      );
    });

    it("does not strip a single shared char that is coincidental, not regen", () => {
      // prefix "x", completion "return ..." — no word overlap, nothing stripped.
      expect(stripStarterOverlap("x", "return x + y;")).toBe("return x + y;");
    });

    it("strips a regenerated keyword followed by more text (for i in range)", () => {
      // User typed "for"; model regenerated "for i in range(10)".
      // Strip "for" but keep the following space so accept yields "for i in range(10)".
      expect(stripStarterOverlap("for", "for i in range(10)")).toBe(
        " i in range(10)"
      );
    });

    it("returns the completion unchanged when prefix is empty", () => {
      expect(stripStarterOverlap("", "from fastmcp")).toBe("from fastmcp");
    });

    it("returns the completion unchanged when completion is empty", () => {
      expect(stripStarterOverlap("from", "")).toBe("");
    });
  });

  it("typing a starter word strips the regenerated prefix from the ghost text", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    invokeMock.mockResolvedValue({
      completion: "from fastmcp.client import Client",
      modelLatencyMs: 12.34,
    });

    const view = viewWith("from", 4);
    view.dispatch({
      changes: { from: 3, to: 3, insert: "m" },
      selection: { anchor: 4 },
      userEvent: "input.type",
    });

    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => view.state.field(ghostTextState) !== null, {
      timeout: 2000,
    });

    const ghost = view.state.field(ghostTextState);
    // The leading "from" is stripped so accepting produces "from fastmcp..."
    // rather than "fromfrom fastmcp...".
    expect(ghost?.text).toBe(" fastmcp.client import Client");

    vi.useRealTimers();
    view.destroy();
  });

  describe("GhostTextWidget multi-line rendering", () => {
    it("uses inline-flex and no verticalAlign for single-line completions", () => {
      const widget = new GhostTextWidget("return x + y;", "Alt-Tab");
      const dom = widget.toDOM() as HTMLElement;
      expect(dom.tagName).toBe("SPAN");
      expect(dom.style.display).toBe("inline-flex");
      // Text span preserves whitespace and renders greyed.
      const textSpan = dom.querySelector(".cm-ghostText") as HTMLElement;
      expect(textSpan).not.toBeNull();
      expect(textSpan.style.whiteSpace).toBe("pre");
      // Hint sits before the text span.
      const hint = dom.querySelector("span") as HTMLElement;
      expect(hint.textContent).toBe("⌥⇥");
      expect(hint.style.verticalAlign).toBe("");
    });

    it("uses inline display for multi-line completions so newlines render as breaks", () => {
      const widget = new GhostTextWidget("\n    ZZZZ", "Alt-Tab");
      const dom = widget.toDOM() as HTMLElement;
      expect(dom.style.display).toBe("inline");
      // Flex-only alignment props are not set on the multi-line container.
      expect(dom.style.alignItems).toBe("");
      expect(dom.style.gap).toBe("");
      // Text span still preserves whitespace so \\n renders as a line break.
      const textSpan = dom.querySelector(".cm-ghostText") as HTMLElement;
      expect(textSpan.style.whiteSpace).toBe("pre");
      expect(textSpan.textContent).toBe("\n    ZZZZ");
      // Hint is lifted so it stays visible on the first line.
      const hint = dom.querySelector("span") as HTMLElement;
      expect(hint.style.verticalAlign).toBe("super");
    });

    it("eq returns true only when both text and keybinding match", () => {
      const a = new GhostTextWidget("foo", "Alt-Tab");
      const same = new GhostTextWidget("foo", "Alt-Tab");
      const diffText = new GhostTextWidget("bar", "Alt-Tab");
      const diffKey = new GhostTextWidget("foo", "Tab");
      expect(a.eq(same)).toBe(true);
      expect(a.eq(diffText)).toBe(false);
      expect(a.eq(diffKey)).toBe(false);
    });
  });
});
