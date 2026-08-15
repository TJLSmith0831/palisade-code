import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import FilePalette from "../FilePalette";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

const files = ["src/App.tsx", "src/api.ts", "src-tauri/src/lib.rs", "README.md"];

const noopHandlers = {
  onCreate: vi.fn().mockResolvedValue(undefined),
  onRename: vi.fn().mockResolvedValue(undefined),
  onDelete: vi.fn().mockResolvedValue(undefined),
};

describe("FilePalette", () => {
  // Mantine's focus trap focuses [data-autofocus] from a setTimeout, so the
  // focus lands a tick after render rather than synchronously.
  it("opens focused and lists all files with no query", async () => {
    render(<FilePalette files={files} onSelect={vi.fn()} onClose={vi.fn()} {...noopHandlers} />);
    await waitFor(() => expect(screen.getByTestId("file-palette-input")).toHaveFocus());
    expect(screen.getAllByTestId("file-palette-result")).toHaveLength(files.length);
  });

  it("labels the search input, not just its placeholder", () => {
    render(<FilePalette files={files} onSelect={vi.fn()} onClose={vi.fn()} {...noopHandlers} />);
    expect(screen.getByLabelText(/search files/i)).toBe(screen.getByTestId("file-palette-input"));
  });

  it("ranks fuzzy matches and opens the selected file", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<FilePalette files={files} onSelect={onSelect} onClose={onClose} {...noopHandlers} />);

    fireEvent.change(screen.getByTestId("file-palette-input"), { target: { value: "apptsx" } });
    const results = screen.getAllByTestId("file-palette-result");
    expect(results[0]).toHaveTextContent("src/App.tsx");

    fireEvent.click(results[0]);
    expect(onSelect).toHaveBeenCalledWith("src/App.tsx");
    expect(onClose).toHaveBeenCalled();
  });

  it("dismisses on Escape without selecting a file", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<FilePalette files={files} onSelect={onSelect} onClose={onClose} {...noopHandlers} />);

    fireEvent.keyDown(screen.getByTestId("file-palette-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows an empty state only when there's nothing to match and nothing to create", () => {
    render(<FilePalette files={[]} onSelect={vi.fn()} onClose={vi.fn()} {...noopHandlers} />);
    expect(screen.getByText("No matching files")).toBeDefined();
  });

  it("offers to create a new file when the query matches nothing", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <FilePalette files={files} onSelect={onSelect} onClose={onClose} {...noopHandlers} onCreate={onCreate} />,
    );

    fireEvent.change(screen.getByTestId("file-palette-input"), { target: { value: "new/thing.ts" } });
    expect(screen.queryByText("No matching files")).toBeNull();
    const createRow = screen.getByTestId("file-palette-create");
    expect(createRow).toHaveTextContent("new/thing.ts");

    fireEvent.click(createRow);
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("new/thing.ts"));
    expect(onSelect).toHaveBeenCalledWith("new/thing.ts");
    expect(onClose).toHaveBeenCalled();
  });

  it("does not offer to create a file that already exists", () => {
    render(<FilePalette files={files} onSelect={vi.fn()} onClose={vi.fn()} {...noopHandlers} />);
    fireEvent.change(screen.getByTestId("file-palette-input"), { target: { value: "src/api.ts" } });
    expect(screen.queryByTestId("file-palette-create")).toBeNull();
  });

  it("renames (or moves) a file via the inline row action", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(<FilePalette files={files} onSelect={vi.fn()} onClose={vi.fn()} {...noopHandlers} onRename={onRename} />);

    fireEvent.click(screen.getAllByTestId("file-palette-rename")[0]);
    const input = screen.getByTestId("file-palette-rename-input");
    fireEvent.change(input, { target: { value: "src/renamed/App.tsx" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onRename).toHaveBeenCalledWith("src/App.tsx", "src/renamed/App.tsx"));
  });

  it("cancels a rename on Escape without calling onRename", () => {
    const onRename = vi.fn();
    render(<FilePalette files={files} onSelect={vi.fn()} onClose={vi.fn()} {...noopHandlers} onRename={onRename} />);

    fireEvent.click(screen.getAllByTestId("file-palette-rename")[0]);
    fireEvent.keyDown(screen.getByTestId("file-palette-rename-input"), { key: "Escape" });

    expect(screen.queryByTestId("file-palette-rename-input")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("deletes a file only after confirming", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<FilePalette files={files} onSelect={vi.fn()} onClose={vi.fn()} {...noopHandlers} onDelete={onDelete} />);

    fireEvent.click(screen.getAllByTestId("file-palette-delete")[0]);
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-palette-confirm-delete-yes")).toBeDefined();

    fireEvent.click(screen.getByTestId("file-palette-confirm-delete-yes"));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("src/App.tsx"));
  });

  it("cancelling a delete confirmation leaves the file alone", () => {
    const onDelete = vi.fn();
    render(<FilePalette files={files} onSelect={vi.fn()} onClose={vi.fn()} {...noopHandlers} onDelete={onDelete} />);

    fireEvent.click(screen.getAllByTestId("file-palette-delete")[0]);
    fireEvent.click(screen.getByTestId("file-palette-confirm-delete-no"));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByTestId("file-palette-confirm-delete-yes")).toBeNull();
  });

  it("hovering a row highlights it without opening the file", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<FilePalette files={files} onSelect={onSelect} onClose={onClose} {...noopHandlers} />);

    fireEvent.mouseEnter(screen.getAllByTestId("file-palette-result")[1]);

    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
