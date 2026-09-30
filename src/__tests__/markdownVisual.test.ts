import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { markdownVisual } from "../markdownVisual";

function lines(doc: string) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: markdownVisual(() => {}, "abc", "notes.md") }),
    parent: document.body,
  });
  const result = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")];
  return { view, result };
}

describe("markdownVisual", () => {
  it("indents list items by nesting depth and hides the source's leading spaces", () => {
    const { view, result } = lines("- outer\n  - inner");
    expect(result[0].classList.contains("ds-md-list-item")).toBe(true);
    expect(result[0].style.getPropertyValue("--md-depth")).toBe("1");
    expect(result[1].style.getPropertyValue("--md-depth")).toBe("2");
    expect(result[1].textContent).toBe("• inner");
    view.destroy();
  });

  it("marks blank lines as paragraph gaps, except inside a code fence", () => {
    const { view, result } = lines("one\n\ntwo\n```\n\n```");
    expect(result.map((line) => line.classList.contains("ds-md-gap"))).toEqual([false, true, false, false, false, false]);
    view.destroy();
  });

  it("marks a fence's first and last rows so the block gets rounded ends", () => {
    const { view, result } = lines("```\ncode\n```");
    expect(result.map((line) => line.className.replace("cm-line", "").trim())).toEqual([
      "ds-md-fence ds-md-fence-start",
      "ds-md-fence",
      "ds-md-fence ds-md-fence-end",
    ]);
    view.destroy();
  });

  it("leaves a local image without src while it loads, then shows its data URL", async () => {
    let resolve!: (base64: string) => void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let view!: EditorView;
    await act(async () => { view = lines("![logo](docs/logo.png)").view; });
    const img = () => view.dom.querySelector(".ds-md-widget img");
    expect(img()).not.toBeNull();
    expect(img()!.hasAttribute("src")).toBe(false);
    await act(async () => { resolve("AAAA"); });
    expect(img()!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(errors.mock.calls.some((call) => String(call[0]).includes("empty string"))).toBe(false);
    errors.mockRestore();
    view.destroy();
  });
});
