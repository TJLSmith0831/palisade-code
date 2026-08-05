import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string) => {
    if (cmd === "read_file_content") return Promise.resolve("line one\nline two\n");
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  }),
}));

import FileEditorPane from "../FileEditorPane";

describe("FileEditorPane", () => {
  it("prompts for a file when none is selected", () => {
    render(<FileEditorPane projectHash="abc" path={null} />);
    expect(screen.getByText(/select a file/i)).toBeDefined();
  });

  it("renders file content with line numbers once loaded", async () => {
    render(<FileEditorPane projectHash="abc" path="src/foo.ts" />);
    await waitFor(() => expect(screen.getByTestId("file-editor")).toBeDefined());
    expect(screen.getByText("line one")).toBeDefined();
    expect(screen.getByText("line two")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText("2")).toBeDefined();
  });
});
