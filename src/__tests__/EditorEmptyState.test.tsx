import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import EditorEmptyState from "../EditorEmptyState";
import type { Command } from "../commands";

const cmd = (over: Partial<Command>): Command => ({
  id: "x",
  label: "X",
  group: "G",
  run: () => {},
  ...over,
});

describe("EditorEmptyState", () => {
  it("lists the entry-point commands with their chords and runs one on click", () => {
    const open = vi.fn();
    render(
      <MantineProvider>
        <EditorEmptyState
          commands={[
            cmd({ id: "file.open", label: "Go to file…", chord: "Mod+P", run: open }),
            cmd({ id: "view.terminal", label: "Toggle terminal", chord: "Ctrl+Backtick" }),
            cmd({ id: "file.new", label: "New file…", enabled: false }),
            cmd({ id: "app.quit", label: "Quit" }),
          ]}
        />
      </MantineProvider>
    );
    expect(screen.getByText("⌘P")).toBeTruthy();
    expect(screen.getByText("Toggle terminal")).toBeTruthy();
    // Disabled commands and ones not on the list stay out.
    expect(screen.queryByText("New file…")).toBeNull();
    expect(screen.queryByText("Quit")).toBeNull();
    fireEvent.click(screen.getByText("Go to file…"));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
