import { beforeEach, describe, expect, it, vi } from "vitest";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import type { ReactElement } from "react";

// Hoisted so individual tests can re-point a command (a stale-save refusal,
// a file whose content changed underneath the editor) instead of being stuck
// with one fixed router — same pattern App.test.tsx uses.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import FileEditorPane from "../FileEditorPane";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

describe("FileEditorPane", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_file_content") return Promise.resolve("line one\nline two\n");
      if (cmd === "read_file_base64") return Promise.resolve("Zm9v");
      if (cmd === "write_file_content") return Promise.resolve();
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
  });

  it("prompts for a file when none is selected", () => {
    render(<FileEditorPane projectHash="abc" path={null} />);
    expect(screen.getByText(/select a file/i)).toBeDefined();
  });

  it("renders file content in a CodeMirror editor once loaded (open from tree)", async () => {
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
    await waitFor(() => expect(screen.getByTestId("file-editor")).toBeDefined());
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("line one"));
    expect(screen.getByText("src/foo.ts")).toBeDefined();
  });

  it("shows a plain-text editor for an unrecognized file extension without erroring", async () => {
    render(<FileEditorPane projectHash="abc" path="data/file.xyz" />);
    await waitFor(() => expect(screen.getByTestId("file-editor")).toBeDefined());
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("line one"));
    expect(screen.queryByTestId("file-editor-error")).toBeNull();
  });

  it("marks dirty on edit and saves via the Save button, clearing the dirty indicator", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" onSave={onSave} />);
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("line one"));

    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    expect(saveBtn).toHaveProperty("disabled", true);

    const content = document.querySelector(".cm-content") as HTMLElement;
    content.focus();
    await user.type(content, "x");

    await waitFor(() => expect(screen.getByRole("button", { name: /save \*/i })).toBeDefined());

    await user.click(screen.getByRole("button", { name: /save \*/i }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: /^save$/i })).toHaveProperty("disabled", true));
  });

  it("reports dirty state changes via onDirtyChange, so a caller can guard navigation away from unsaved edits", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" onDirtyChange={onDirtyChange} />);
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("line one"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    const content = document.querySelector(".cm-content") as HTMLElement;
    content.focus();
    await user.type(content, "x");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    await user.click(screen.getByRole("button", { name: /save \*/i }));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("does not remount the CodeMirror view on save (preserves cursor/undo/scroll state)", async () => {
    const user = userEvent.setup();
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("line one"));

    const contentBefore = document.querySelector(".ds-editor-body .cm-content") as HTMLElement;
    contentBefore.focus();
    await user.type(contentBefore, "x");
    await user.click(screen.getByRole("button", { name: /save \*/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /^save$/i })).toHaveProperty("disabled", true));

    const contentAfter = document.querySelector(".ds-editor-body .cm-content");
    expect(contentAfter).toBe(contentBefore);
  });

  it("offers autocomplete suggestions from the document and dismisses on Escape", async () => {
    const user = userEvent.setup();
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("line one"));

    const content = document.querySelector(".cm-content") as HTMLElement;
    content.focus();
    await user.type(content, "lin");

    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).not.toBeNull());

    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull());
  });

  it("renders an image preview (not the text editor) for a .gif path, with working zoom", async () => {
    const user = userEvent.setup();
    render(<FileEditorPane projectHash="abc" path="assets/demo.gif" />);
    await waitFor(() => expect(screen.getByTestId("file-editor-media")).toBeDefined());
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
    await waitFor(() => expect(screen.getByTestId("file-editor-media")).toBeDefined());
    expect(document.querySelector("video")).not.toBeNull();
  });

  // Reconciliation with changes Floo didn't make — an agent turn writing to
  // disk, a branch switch, another editor.
  describe("when the file changes on disk", () => {
    it("reloads silently if nothing of the user's would be lost", async () => {
      const { rerender } = render(
        <FileEditorPane projectHash="abc" path="src/foo.ts" externalChange={null} />
      );
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain("line one")
      );

      // What the agent left behind.
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "read_file_content") return Promise.resolve("rewritten by the agent\n");
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
        <FileEditorPane projectHash="abc" path="src/foo.ts" externalChange={null} />
      );
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain("line one")
      );

      const content = document.querySelector(".cm-content") as HTMLElement;
      content.focus();
      await user.type(content, "mine");
      await waitFor(() => expect(screen.getByRole("button", { name: /save \*/i })).toBeDefined());

      rerender(
        <FileEditorPane
          projectHash="abc"
          path="src/foo.ts"
          externalChange={{ path: "src/foo.ts", at: 1 }}
        />
      );

      await waitFor(() => expect(screen.getByTestId("file-conflict-banner")).toBeDefined());
      // The user's edit is still there — nothing was silently thrown away.
      expect(document.querySelector(".cm-content")?.textContent).toContain("mine");
    });

    it("ignores a change to a different file", async () => {
      const { rerender } = render(
        <FileEditorPane projectHash="abc" path="src/foo.ts" externalChange={null} />
      );
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain("line one")
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
        if (cmd === "read_file_content") return Promise.resolve("line one\nline two\n");
        if (cmd === "write_file_content") {
          saves += 1;
          return saves === 1
            ? Promise.reject(new Error("CONFLICT: src/foo.ts changed on disk since you opened it"))
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
        expect(document.querySelector(".cm-content")?.textContent).toContain("line one")
      );

      const content = document.querySelector(".cm-content") as HTMLElement;
      content.focus();
      await user.type(content, "x");
      await user.click(screen.getByRole("button", { name: /save \*/i }));

      await waitFor(() => expect(screen.getByTestId("file-conflict-banner")).toBeDefined());
      // A conflict is a choice to offer, not an error to report.
      expect(screen.queryByTestId("file-editor-error")).toBeNull();
    });

    it("overwrites on 'keep mine', dropping the staleness claim so the retry lands", async () => {
      const user = userEvent.setup();
      conflictOnFirstSave();
      const onSave = vi.fn();
      render(<FileEditorPane projectHash="abc" path="src/foo.ts" onSave={onSave} />);
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain("line one")
      );

      const content = document.querySelector(".cm-content") as HTMLElement;
      content.focus();
      await user.type(content, "x");
      await user.click(screen.getByRole("button", { name: /save \*/i }));
      await waitFor(() => expect(screen.getByTestId("file-conflict-banner")).toBeDefined());

      await user.click(screen.getByTestId("conflict-overwrite"));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      const retry = invokeMock.mock.calls.filter((c) => c[0] === "write_file_content").at(-1);
      expect(retry?.[1]).toMatchObject({ expectedPrevious: null });
      await waitFor(() => expect(screen.queryByTestId("file-conflict-banner")).toBeNull());
    });

    it("sends what it believes is on disk with an ordinary save", async () => {
      const user = userEvent.setup();
      render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
      await waitFor(() =>
        expect(document.querySelector(".cm-content")?.textContent).toContain("line one")
      );

      const content = document.querySelector(".cm-content") as HTMLElement;
      content.focus();
      await user.type(content, "x");
      await user.click(screen.getByRole("button", { name: /save \*/i }));

      await waitFor(() => {
        const write = invokeMock.mock.calls.find((c) => c[0] === "write_file_content");
        expect(write?.[1]).toMatchObject({ expectedPrevious: "line one\nline two\n" });
      });
    });
  });

  it("reports itself clean when unmounted, so a caller's discard guard can't fire for a file that isn't open", async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    const { unmount } = render(
      <FileEditorPane projectHash="abc" path="src/foo.ts" onDirtyChange={onDirtyChange} />
    );
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain("line one")
    );

    const content = document.querySelector(".cm-content") as HTMLElement;
    content.focus();
    await user.type(content, "x");
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });
});
