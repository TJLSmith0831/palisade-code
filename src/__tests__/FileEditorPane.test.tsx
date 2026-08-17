import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { act } from "react";
import { openSearchPanel, searchKeymap } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import type { ReactElement } from "react";

// Hoisted so individual tests can re-point a command (a stale-save refusal,
// a file whose content changed underneath the editor) instead of being stuck
// with one fixed router — same pattern App.test.tsx uses.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
// The pane listens for `lsp-status` (Amendment 2); without this the real
// event module reaches for a Tauri runtime that isn't there.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Lightweight stand-in for the WYSIWYG Markdown editor — the real one is a
// heavy dependency that doesn't need to be exercised to verify the pane's
// wiring. The mock exposes the same controlled-editor surface the pane uses.
vi.mock("@uiw/react-md-editor", () => {
  const MDEditor = ({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (value: string) => void;
  }) => (
    <textarea
      data-testid="md-editor"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  );
  MDEditor.Markdown = ({ source }: { source: string }) => (
    <div data-testid="md-preview">{source}</div>
  );
  return { default: MDEditor };
});

import FileEditorPane, { evictProjectSessions } from "../FileEditorPane";

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

/** Reaches the mounted EditorView through the DOM node CodeMirror tags. */
function viewFromDom(): EditorView {
  const content = document.querySelector(".cm-content") as HTMLElement & {
    cmTile?: unknown;
  };
  const seen = new Set<unknown>();
  const find = (node: unknown, depth: number): EditorView | null => {
    if (!node || depth > 4 || typeof node !== "object" || seen.has(node))
      return null;
    seen.add(node);
    const candidate = node as { dispatch?: unknown; state?: { doc?: unknown } };
    if (typeof candidate.dispatch === "function" && candidate.state?.doc) {
      return node as EditorView;
    }
    for (const key of Object.keys(node)) {
      const hit = find((node as Record<string, unknown>)[key], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  const view = find(content.cmTile, 0);
  if (!view) throw new Error("no EditorView mounted");
  return view;
}

describe("FileEditorPane", () => {
  beforeEach(() => {
    // Editing sessions live at module scope so they can outlive the pane
    // unmounting. That also means they outlive a test, so each one starts
    // from a clean slate rather than inheriting the last test's document.
    evictProjectSessions("abc");
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "read_file_content")
          return Promise.resolve("line one\nline two\n");
        if (cmd === "read_file_base64") return Promise.resolve("Zm9v");
        if (cmd === "write_file_content") return Promise.resolve();
        if (cmd === "complete_code" && typeof args?.prefix === "string")
          return Promise.resolve({
            completion: args.prefix + "e one",
            modelLatencyMs: 12.34,
          });
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      }
    );
  });

  it("prompts for a file when none is selected", () => {
    render(<FileEditorPane projectHash="abc" path={null} />);
    expect(screen.getByText(/select a file/i)).toBeDefined();
  });

  it("renders file content in a CodeMirror editor once loaded (open from tree)", async () => {
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
    await waitFor(() =>
      expect(screen.getByTestId("file-editor")).toBeDefined()
    );
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "line one"
      )
    );
    expect(screen.getByText("src/foo.ts")).toBeDefined();
  });

  it("wires --code-text and syntax token CSS variables into the CodeMirror theme", async () => {
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "line one"
      )
    );
    // CodeMirror injects its theme styles as <style> tags in the document
    // head. Assert the CSS variables appear in the generated styles — both
    // the base text color and the per-token-type syntax highlighting vars.
    const styleText = [...document.querySelectorAll("style")]
      .map((s) => s.textContent ?? "")
      .join("\n");
    expect(styleText).toContain("var(--code-text)");
    expect(styleText).toContain("var(--code-comment)");
    expect(styleText).toContain("var(--code-keyword)");
    expect(styleText).toContain("var(--code-string)");
  });

  it("shows a plain-text editor for an unrecognized file extension without erroring", async () => {
    render(<FileEditorPane projectHash="abc" path="data/file.xyz" />);
    await waitFor(() =>
      expect(screen.getByTestId("file-editor")).toBeDefined()
    );
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "line one"
      )
    );
    expect(screen.queryByTestId("file-editor-error")).toBeNull();
  });

  it("marks dirty on edit and saves via the Save button, clearing the dirty indicator", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <FileEditorPane projectHash="abc" path="src/foo.ts" onSave={onSave} />
    );
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "line one"
      )
    );

    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    expect(saveBtn).toHaveProperty("disabled", true);

    const content = document.querySelector(".cm-content") as HTMLElement;
    content.focus();
    await user.type(content, "x");

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /save \*/i })).toBeDefined()
    );

    await user.click(screen.getByRole("button", { name: /save \*/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^save$/i })).toHaveProperty(
        "disabled",
        true
      )
    );
  });

  it("reports dirty state changes via onDirtyChange, so a caller can guard navigation away from unsaved edits", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    render(
      <FileEditorPane
        projectHash="abc"
        path="src/foo.ts"
        onDirtyChange={onDirtyChange}
      />
    );
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "line one"
      )
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith("src/foo.ts", false);

    const content = document.querySelector(".cm-content") as HTMLElement;
    content.focus();
    await user.type(content, "x");
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith("src/foo.ts", true)
    );

    await user.click(screen.getByRole("button", { name: /save \*/i }));
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith("src/foo.ts", false)
    );
  });

  it("does not remount the CodeMirror view on save (preserves cursor/undo/scroll state)", async () => {
    const user = userEvent.setup();
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "line one"
      )
    );

    const contentBefore = document.querySelector(
      ".ds-editor-body .cm-content"
    ) as HTMLElement;
    contentBefore.focus();
    await user.type(contentBefore, "x");
    await user.click(screen.getByRole("button", { name: /save \*/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^save$/i })).toHaveProperty(
        "disabled",
        true
      )
    );

    const contentAfter = document.querySelector(".ds-editor-body .cm-content");
    expect(contentAfter).toBe(contentBefore);
  });

  it("shows AI ghost text inline and dismisses it on Escape", async () => {
    const user = userEvent.setup();
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "line one"
      )
    );

    const content = document.querySelector(".cm-content") as HTMLElement;
    content.focus();
    await user.type(content, "lin");

    // D1: debounce is 3000ms, so waitFor needs a timeout beyond that.
    await waitFor(
      () => expect(document.querySelector(".cm-ghostText")).not.toBeNull(),
      { timeout: 5000 }
    );

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.querySelector(".cm-ghostText")).toBeNull()
    );
  });

  it("renders an image preview (not the text editor) for a .gif path, with working zoom", async () => {
    const user = userEvent.setup();
    render(<FileEditorPane projectHash="abc" path="assets/demo.gif" />);
    await waitFor(() =>
      expect(screen.getByTestId("file-editor-media")).toBeDefined()
    );
    expect(screen.queryByTestId("file-editor-error")).toBeNull();
    const img = document.querySelector("img") as HTMLImageElement;
    expect(img.src).toBe("data:image/gif;base64,Zm9v");
    expect(screen.getByTestId("image-zoom-level").textContent).toBe("100%");

    await user.click(screen.getByTestId("image-zoom-in"));
    expect(screen.getByTestId("image-zoom-level").textContent).toBe("125%");
    expect(img.style.transform).toBe("scale(1.25)");
  });

  it("renders a video preview for an .mp4 path", async () => {
    render(<FileEditorPane projectHash="abc" path="assets/clip.mp4" />);
    await waitFor(() =>
      expect(screen.getByTestId("file-editor-media")).toBeDefined()
    );
    expect(document.querySelector("video")).not.toBeNull();
  });

  it("has in-buffer find wired up, panel and Cmd+F binding both", async () => {
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "line one"
      )
    );
    expect(document.querySelector(".cm-search")).toBeNull();

    // Driving the real Cmd+F through jsdom doesn't reach CodeMirror's
    // keymap, so this asserts the two halves separately: the search
    // extension is installed (its panel opens), and Mod-f is bound to the
    // command that opens it.
    const view = viewFromDom();
    act(() => {
      openSearchPanel(view);
    });
    await waitFor(() =>
      expect(document.querySelector(".cm-search")).not.toBeNull()
    );

    expect(searchKeymap.some((binding) => binding.key === "Mod-f")).toBe(true);
  });

  it("renders a fold gutter so long blocks can be collapsed", async () => {
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
    await waitFor(() =>
      expect(screen.getByTestId("file-editor")).toBeDefined()
    );
    await waitFor(() =>
      expect(document.querySelector(".cm-foldGutter")).not.toBeNull()
    );
  });

  describe("files it declines to open", () => {
    it("explains a binary file instead of failing to decode it", async () => {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "read_file_content")
          return Promise.reject(new Error("BINARY:"));
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      });
      render(<FileEditorPane projectHash="abc" path="build/out.bin" />);

      await waitFor(() =>
        expect(screen.getByTestId("file-unopenable")).toBeDefined()
      );
      expect(screen.getByTestId("file-unopenable").textContent).toContain(
        "binary"
      );
      expect(screen.queryByTestId("file-editor-error")).toBeNull();
    });

    it("names the size of a file too large to edit", async () => {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "read_file_content")
          return Promise.reject(new Error("TOO_LARGE: 52428800"));
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      });
      render(<FileEditorPane projectHash="abc" path="logs/huge.log" />);

      await waitFor(() =>
        expect(screen.getByTestId("file-unopenable")).toBeDefined()
      );
      expect(screen.getByTestId("file-unopenable").textContent).toContain(
        "50.0 MB"
      );
    });

    it("still reports a genuine read failure as an error", async () => {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "read_file_content")
          return Promise.reject(new Error("cannot read file: EACCES"));
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      });
      render(<FileEditorPane projectHash="abc" path="secret.txt" />);

      await waitFor(() =>
        expect(screen.getByTestId("file-editor-error")).toBeDefined()
      );
      expect(screen.queryByTestId("file-unopenable")).toBeNull();
    });
  });

  // Reconciliation with changes Palisade didn't make — an agent turn writing to
  // disk, a branch switch, another editor.
  describe("when the file changes on disk", () => {
    it("reloads silently if nothing of the user's would be lost", async () => {
      const { rerender } = render(
        <FileEditorPane
          projectHash="abc"
          path="src/foo.ts"
          externalChange={null}
        />
      );
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain(
          "line one"
        )
      );

      // What the agent left behind.
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "read_file_content")
          return Promise.resolve("rewritten by the agent\n");
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      });
      rerender(
        <FileEditorPane
          projectHash="abc"
          path="src/foo.ts"
          externalChange={{ path: "src/foo.ts", at: 1 }}
        />
      );

      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain(
          "rewritten by the agent"
        )
      );
      expect(screen.queryByTestId("file-conflict-banner")).toBeNull();
    });

    it("raises the conflict banner instead of discarding unsaved edits", async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <FileEditorPane
          projectHash="abc"
          path="src/foo.ts"
          externalChange={null}
        />
      );
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain(
          "line one"
        )
      );

      const content = document.querySelector(".cm-content") as HTMLElement;
      content.focus();
      await user.type(content, "mine");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /save \*/i })).toBeDefined()
      );

      rerender(
        <FileEditorPane
          projectHash="abc"
          path="src/foo.ts"
          externalChange={{ path: "src/foo.ts", at: 1 }}
        />
      );

      await waitFor(() =>
        expect(screen.getByTestId("file-conflict-banner")).toBeDefined()
      );
      // The user's edit is still there — nothing was silently thrown away.
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "mine"
      );
    });

    it("shows the new content after 'discard mine, reload', not the version it had before", async () => {
      const user = userEvent.setup();
      const { rerender } = render(
        <FileEditorPane
          projectHash="abc"
          path="src/foo.ts"
          externalChange={null}
        />
      );
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain(
          "line one"
        )
      );

      const content = document.querySelector(".cm-content") as HTMLElement;
      content.focus();
      await user.type(content, "mine");
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /save \*/i })).toBeDefined()
      );

      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "read_file_content")
          return Promise.resolve("what the agent wrote\n");
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      });
      rerender(
        <FileEditorPane
          projectHash="abc"
          path="src/foo.ts"
          externalChange={{ path: "src/foo.ts", at: 1 }}
        />
      );
      await waitFor(() =>
        expect(screen.getByTestId("file-conflict-banner")).toBeDefined()
      );

      await user.click(screen.getByTestId("conflict-reload"));

      // Covers the user-visible behaviour of the reload path. Note it does
      // not reproduce the commit-ordering race that originally broke this
      // (the view was rebuilt only when content crossed null, so a read
      // resolving before that commit left the previous document on screen);
      // jsdom's flush timing hides it. That one was caught by driving the
      // real app, and is prevented structurally by rebuilding per load.
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain(
          "what the agent wrote"
        )
      );
      expect(document.querySelector(".cm-content")?.textContent).not.toContain(
        "mine"
      );
      expect(screen.queryByTestId("file-conflict-banner")).toBeNull();
    });

    it("keeps the cursor put when the change is Palisade's own save", async () => {
      const { rerender } = render(
        <FileEditorPane
          projectHash="abc"
          path="src/foo.ts"
          externalChange={null}
        />
      );
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain(
          "line one"
        )
      );

      const view = viewFromDom();
      act(() => {
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      });
      const before = view.state.selection.main.head;
      expect(before).toBeGreaterThan(0);

      // Saving writes the file, which trips the watcher — disk now matches
      // the buffer, so there is nothing to reload and nothing to reset.
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
      rerender(
        <FileEditorPane
          projectHash="abc"
          path="src/foo.ts"
          externalChange={{ path: "src/foo.ts", at: 1 }}
        />
      );

      await waitFor(() =>
        expect(
          invokeMock.mock.calls.filter((c) => c[0] === "read_file_content")
            .length
        ).toBeGreaterThan(1)
      );
      expect(viewFromDom()).toBe(view);
      expect(view.state.selection.main.head).toBe(before);
    });

    it("ignores a change to a different file", async () => {
      const { rerender } = render(
        <FileEditorPane
          projectHash="abc"
          path="src/foo.ts"
          externalChange={null}
        />
      );
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain(
          "line one"
        )
      );

      rerender(
        <FileEditorPane
          projectHash="abc"
          path="src/foo.ts"
          externalChange={{ path: "src/somewhere-else.ts", at: 1 }}
        />
      );

      expect(screen.queryByTestId("file-conflict-banner")).toBeNull();
    });
  });

  describe("when a save is refused as stale", () => {
    const conflictOnFirstSave = () => {
      let saves = 0;
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "read_file_content")
          return Promise.resolve("line one\nline two\n");
        if (cmd === "write_file_content") {
          saves += 1;
          return saves === 1
            ? Promise.reject(
                new Error(
                  "CONFLICT: src/foo.ts changed on disk since you opened it"
                )
              )
            : Promise.resolve();
        }
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      });
    };

    it("offers the conflict banner rather than reporting a write failure", async () => {
      const user = userEvent.setup();
      conflictOnFirstSave();
      render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain(
          "line one"
        )
      );

      const content = document.querySelector(".cm-content") as HTMLElement;
      content.focus();
      await user.type(content, "x");
      await user.click(screen.getByRole("button", { name: /save \*/i }));

      await waitFor(() =>
        expect(screen.getByTestId("file-conflict-banner")).toBeDefined()
      );
      // A conflict is a choice to offer, not an error to report.
      expect(screen.queryByTestId("file-editor-error")).toBeNull();
    });

    it("overwrites on 'keep mine', dropping the staleness claim so the retry lands", async () => {
      const user = userEvent.setup();
      conflictOnFirstSave();
      const onSave = vi.fn();
      render(
        <FileEditorPane projectHash="abc" path="src/foo.ts" onSave={onSave} />
      );
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain(
          "line one"
        )
      );

      const content = document.querySelector(".cm-content") as HTMLElement;
      content.focus();
      await user.type(content, "x");
      await user.click(screen.getByRole("button", { name: /save \*/i }));
      await waitFor(() =>
        expect(screen.getByTestId("file-conflict-banner")).toBeDefined()
      );

      await user.click(screen.getByTestId("conflict-overwrite"));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      const retry = invokeMock.mock.calls
        .filter((c) => c[0] === "write_file_content")
        .at(-1);
      expect(retry?.[1]).toMatchObject({ expectedPrevious: null });
      await waitFor(() =>
        expect(screen.queryByTestId("file-conflict-banner")).toBeNull()
      );
    });

    it("sends what it believes is on disk with an ordinary save", async () => {
      const user = userEvent.setup();
      render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain(
          "line one"
        )
      );

      const content = document.querySelector(".cm-content") as HTMLElement;
      content.focus();
      await user.type(content, "x");
      await user.click(screen.getByRole("button", { name: /save \*/i }));

      await waitFor(() => {
        const write = invokeMock.mock.calls.find(
          (c) => c[0] === "write_file_content"
        );
        expect(write?.[1]).toMatchObject({
          expectedPrevious: "line one\nline two\n",
        });
      });
    });
  });

  it("keeps a file's unsaved edits and cursor when the pane unmounts and comes back", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    const { unmount } = render(
      <FileEditorPane
        projectHash="abc"
        path="src/foo.ts"
        onDirtyChange={onDirtyChange}
      />
    );
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "line one"
      )
    );

    const content = document.querySelector(".cm-content") as HTMLElement;
    content.focus();
    await user.type(content, "work in progress");
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith("src/foo.ts", true)
    );

    // Looking at the diff, or switching shells, unmounts this pane. The tab
    // list owns dirtiness, so neither may quietly turn the file clean.
    unmount();

    const reopened = vi.fn();
    render(
      <FileEditorPane
        projectHash="abc"
        path="src/foo.ts"
        onDirtyChange={reopened}
      />
    );
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "work in progress"
      )
    );
    await waitFor(() =>
      expect(reopened).toHaveBeenLastCalledWith("src/foo.ts", true)
    );
    // Restored from the cached session, not re-read from disk.
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "read_file_content")
    ).toHaveLength(1);
  });

  it("still reports edits after the pane has unmounted and come back", async () => {
    const user = userEvent.setup();
    const first = render(
      <FileEditorPane projectHash="abc" path="src/foo.ts" />
    );
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "line one"
      )
    );
    // Unmount while clean, so the restored session starts clean too and a
    // later edit is a real false -> true transition.
    first.unmount();

    const onDirtyChange = vi.fn();
    render(
      <FileEditorPane
        projectHash="abc"
        path="src/foo.ts"
        onDirtyChange={onDirtyChange}
      />
    );
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith("src/foo.ts", false)
    );

    const content = document.querySelector(".cm-content") as HTMLElement;
    content.focus();
    await user.type(content, "x");

    // A CodeMirror state carries the extensions that built it, which close
    // over the component instance that created them. Restoring one wholesale
    // left the update listener reporting into a component that no longer
    // existed, and the file quietly stopped going dirty from then on.
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith("src/foo.ts", true)
    );
  });

  it("starts from disk again once a file's session has been evicted (its tab closed)", async () => {
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "line one"
      )
    );

    evictProjectSessions("abc");
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_file_content")
        return Promise.resolve("fresh from disk\n");
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("fresh from disk")
    );
  });

  describe("Markdown RTE and preview mode", () => {
    it("renders the WYSIWYG editor (no preview) for a .md file by default", async () => {
      render(<FileEditorPane projectHash="abc" path="README.md" />);
      // Wait for the file to load and seed the WYSIWYG editor.
      await waitFor(() =>
        expect(
          (screen.getByTestId("md-editor") as HTMLTextAreaElement).value
        ).toContain("line one")
      );
      // CodeMirror stays mounted as the backing store but is hidden.
      const cm = screen.getByTestId("file-editor-cm");
      expect(cm.style.display).toBe("none");
    });

    it("renders CodeMirror (not the RTE) for a non-markdown file", async () => {
      render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
      await waitFor(() =>
        expect(screen.getByTestId("file-editor-cm")).toBeDefined()
      );
      expect(screen.queryByTestId("md-editor")).toBeNull();
    });

    it("fires onToggleMdPreview on Cmd+Shift+V for a .md file", async () => {
      const onToggleMdPreview = vi.fn();
      render(
        <FileEditorPane
          projectHash="abc"
          path="README.md"
          onToggleMdPreview={onToggleMdPreview}
        />
      );
      await waitFor(() =>
        expect(screen.getByTestId("file-editor-cm")).toBeDefined()
      );

      fireEvent.keyDown(window, {
        key: "v",
        metaKey: true,
        shiftKey: true,
      });
      expect(onToggleMdPreview).toHaveBeenCalledTimes(1);
    });

    it("does not fire onToggleMdPreview on Cmd+Shift+V for a non-markdown file", async () => {
      const onToggleMdPreview = vi.fn();
      render(
        <FileEditorPane
          projectHash="abc"
          path="src/foo.ts"
          onToggleMdPreview={onToggleMdPreview}
        />
      );
      await waitFor(() =>
        expect(screen.getByTestId("file-editor-cm")).toBeDefined()
      );

      fireEvent.keyDown(window, {
        key: "v",
        metaKey: true,
        shiftKey: true,
      });
      expect(onToggleMdPreview).not.toHaveBeenCalled();
    });

    it("marks dirty and saves from the RTE", async () => {
      const user = userEvent.setup();
      const onSave = vi.fn();
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "read_file_content") return Promise.resolve("# Title\n");
        if (cmd === "write_file_content") return Promise.resolve();
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      });
      render(
        <FileEditorPane projectHash="abc" path="README.md" onSave={onSave} />
      );
      await waitFor(() =>
        expect(screen.getByTestId("md-editor")).toBeDefined()
      );

      const editor = screen.getByTestId("md-editor") as HTMLTextAreaElement;
      await user.type(editor, "!");
      // The save button should become enabled (dirty).
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /save \*/i })).toBeDefined()
      );
      await user.click(screen.getByRole("button", { name: /save \*/i }));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(onSave.mock.calls[0][0].after).toContain("!");
    });
  });
});
