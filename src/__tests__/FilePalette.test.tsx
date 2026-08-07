import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import FilePalette from "../FilePalette";

const files = ["src/App.tsx", "src/api.ts", "src-tauri/src/lib.rs", "README.md"];

describe("FilePalette", () => {
  it("opens focused and lists all files with no query", () => {
    render(<FilePalette files={files} onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId("file-palette-input")).toHaveFocus();
    expect(screen.getAllByTestId("file-palette-result")).toHaveLength(files.length);
  });

  it("ranks fuzzy matches and opens the selected file", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<FilePalette files={files} onSelect={onSelect} onClose={onClose} />);

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
    render(<FilePalette files={files} onSelect={onSelect} onClose={onClose} />);

    fireEvent.keyDown(screen.getByTestId("file-palette-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows an empty state when nothing matches", () => {
    render(<FilePalette files={files} onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("file-palette-input"), { target: { value: "zzzznomatch" } });
    expect(screen.getByText("No matching files")).toBeDefined();
    expect(screen.queryByTestId("file-palette-result")).toBeNull();
  });
});
