import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls: { cmd: string; args?: Record<string, unknown> }[] = [];

const invokeMock = vi.fn((cmd: string, args?: Record<string, unknown>) => {
  calls.push({ cmd, args });
  if (cmd === "list_directory") {
    if (args?.projectHash === "bad") return Promise.reject(new Error("no such file or directory"));
    const relativePath = String(args?.relativePath ?? "");
    if (relativePath === "src") {
      return Promise.resolve([{ name: "index.ts", is_dir: false, path: "src/index.ts" }]);
    }
    return Promise.resolve([
      { name: "src", is_dir: true, path: "src" },
      { name: "README.md", is_dir: false, path: "README.md" },
    ]);
  }
  if (cmd === "write_file_content") return Promise.resolve(null);
  if (cmd === "rename_path") return Promise.resolve();
  if (cmd === "delete_path") return Promise.resolve();
  if (cmd === "create_directory") return Promise.resolve();
  return Promise.reject(new Error(`unexpected command ${cmd}`));
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: [string, Record<string, unknown>?]) => invokeMock(...args),
}));

import FileTree from "../FileTree";

describe("FileTree", () => {
  beforeEach(() => {
    calls.length = 0;
    invokeMock.mockClear();
  });

  it("clears a stale error from the previous project when the project switches", async () => {
    const { rerender } = render(
      <FileTree projectHash="bad" projectName="broken-project" onSelectFile={vi.fn()} activePath={null} />,
    );
    await waitFor(() => expect(screen.getByText(/no such file or directory/i)).toBeDefined());

    rerender(<FileTree projectHash="good" projectName="good-project" onSelectFile={vi.fn()} activePath={null} />);

    await waitFor(() => expect(screen.getByText("README.md")).toBeDefined());
    expect(screen.queryByText(/no such file or directory/i)).toBeNull();
  });

  it("background right-click offers New File / New Folder / hidden-files toggle but no Rename or Delete", async () => {
    render(<FileTree projectHash="good" projectName="p" onSelectFile={vi.fn()} activePath={null} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeDefined());

    fireEvent.contextMenu(screen.getByTestId("file-tree").querySelector(".ds-tree-body")!);

    const items = screen.getAllByTestId("tree-context-menu-item").map((el) => el.textContent);
    expect(items).toEqual(["New File", "New Folder", "Show Gitignored/Hidden Files"]);
  });

  it("row right-click offers the full set: New File, New Folder, Rename, Delete", async () => {
    render(<FileTree projectHash="good" projectName="p" onSelectFile={vi.fn()} activePath={null} />);
    const row = await screen.findByText("README.md");

    fireEvent.contextMenu(row);

    const items = screen.getAllByTestId("tree-context-menu-item").map((el) => el.textContent);
    expect(items).toEqual(["New File", "New Folder", "Rename", "Delete"]);
  });

  it("creates a new file at the root via the context menu", async () => {
    const onSelectFile = vi.fn();
    render(<FileTree projectHash="good" projectName="p" onSelectFile={onSelectFile} activePath={null} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeDefined());

    fireEvent.contextMenu(screen.getByTestId("file-tree").querySelector(".ds-tree-body")!);
    fireEvent.click(screen.getByText("New File"));

    const input = screen.getByTestId("tree-create-input");
    fireEvent.change(input, { target: { value: "new-file.md" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "write_file_content" && c.args?.relativePath === "new-file.md")).toBe(true),
    );
    expect(onSelectFile).toHaveBeenCalledWith("new-file.md");
  });

  it("creates a new folder via the context menu and expands it", async () => {
    render(<FileTree projectHash="good" projectName="p" onSelectFile={vi.fn()} activePath={null} />);
    await waitFor(() => expect(screen.getByText("README.md")).toBeDefined());

    fireEvent.contextMenu(screen.getByTestId("file-tree").querySelector(".ds-tree-body")!);
    fireEvent.click(screen.getByText("New Folder"));

    const input = screen.getByTestId("tree-create-input");
    fireEvent.change(input, { target: { value: "docs" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "create_directory" && c.args?.relativePath === "docs")).toBe(true),
    );
  });

  it("renames a file via the context menu", async () => {
    const onPathRenamed = vi.fn();
    render(
      <FileTree
        projectHash="good"
        projectName="p"
        onSelectFile={vi.fn()}
        activePath={null}
        onPathRenamed={onPathRenamed}
      />,
    );
    const row = await screen.findByText("README.md");
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText("Rename"));

    const input = screen.getByTestId("tree-rename-input");
    fireEvent.change(input, { target: { value: "GUIDE.md" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onPathRenamed).toHaveBeenCalledWith("README.md", "GUIDE.md"));
  });

  it("deletes a file via the context menu, only after confirming", async () => {
    const onPathDeleted = vi.fn();
    render(
      <FileTree
        projectHash="good"
        projectName="p"
        onSelectFile={vi.fn()}
        activePath={null}
        onPathDeleted={onPathDeleted}
      />,
    );
    const row = await screen.findByText("README.md");
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByText("Delete"));

    expect(onPathDeleted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("tree-confirm-delete-yes"));

    await waitFor(() => expect(onPathDeleted).toHaveBeenCalledWith("README.md"));
  });

  it("moves a file into a folder via drag and drop", async () => {
    const onPathRenamed = vi.fn();
    render(
      <FileTree
        projectHash="good"
        projectName="p"
        onSelectFile={vi.fn()}
        activePath={null}
        onPathRenamed={onPathRenamed}
      />,
    );
    const fileRow = await screen.findByText("README.md");
    const folderRow = screen.getByText("src");

    const dataTransfer = { data: {} as Record<string, string>, setData(k: string, v: string) { this.data[k] = v; }, getData(k: string) { return this.data[k]; } };
    fireEvent.dragStart(fileRow, { dataTransfer });
    fireEvent.dragOver(folderRow.closest(".ds-tree-row")!, { dataTransfer });
    fireEvent.drop(folderRow.closest(".ds-tree-row")!, { dataTransfer });

    await waitFor(() => expect(onPathRenamed).toHaveBeenCalledWith("README.md", "src/README.md"));
  });

  it("refuses to move a folder into itself", async () => {
    render(<FileTree projectHash="good" projectName="p" onSelectFile={vi.fn()} activePath={null} />);
    const srcRow = await screen.findByText("src");

    const dataTransfer = { data: {} as Record<string, string>, setData(k: string, v: string) { this.data[k] = v; }, getData(k: string) { return this.data[k]; } };
    fireEvent.dragStart(srcRow, { dataTransfer });
    fireEvent.drop(srcRow.closest(".ds-tree-row")!, { dataTransfer });

    await waitFor(() => expect(screen.getByText(/can't move a folder into itself/i)).toBeDefined());
    expect(calls.some((c) => c.cmd === "rename_path")).toBe(false);
  });

  it("is keyboard-focusable and opens a file on Enter or Space", async () => {
    const onSelectFile = vi.fn();
    render(<FileTree projectHash="good" projectName="p" onSelectFile={onSelectFile} activePath={null} />);
    const row = (await screen.findByText("README.md")).closest(".ds-tree-row")!;

    expect(row).toHaveAttribute("tabIndex", "0");

    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelectFile).toHaveBeenCalledWith("README.md");

    onSelectFile.mockClear();
    fireEvent.keyDown(row, { key: " " });
    expect(onSelectFile).toHaveBeenCalledWith("README.md");
  });
});
