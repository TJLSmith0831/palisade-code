import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "read_file_content") return Promise.resolve("line one\nline two\n");
    if (cmd === "read_file_base64") return Promise.resolve("Zm9v");
    if (cmd === "write_file_content") return Promise.resolve();
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  }),
}));

import FileEditorPane from "../FileEditorPane";

describe("FileEditorPane", () => {
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
});
