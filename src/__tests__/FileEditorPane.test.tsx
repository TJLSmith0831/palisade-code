import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "read_file_content") return Promise.resolve("line one\nline two\n");
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

  it("renders file content in a textarea with line numbers once loaded", async () => {
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
    await waitFor(() => expect(screen.getByTestId("file-editor")).toBeDefined());

    const textarea = screen.getByTestId("file-editor-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("line one\nline two\n");

    // line numbers rendered in the gutter
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
  });
});
