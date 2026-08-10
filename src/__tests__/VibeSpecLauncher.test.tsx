import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import VibeSpecLauncher from "../VibeSpecLauncher";

const change = (
  over: Partial<{
    name: string;
    completedTasks: number;
    totalTasks: number;
    status: string | null;
    lastModified: string | null;
  }> = {}
) => ({
  name: "vibe-spec-tabs",
  completedTasks: 3,
  totalTasks: 10,
  lastModified: "2026-08-09T00:00:00Z",
  status: "in-progress",
  ...over,
});

const renderLauncher = (
  props: Partial<React.ComponentProps<typeof VibeSpecLauncher>> = {}
) =>
  render(
    <MantineProvider>
      <VibeSpecLauncher projectHash="proj-1" onOpenSpec={vi.fn()} {...props} />
    </MantineProvider>
  );

describe("VibeSpecLauncher", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockClear();
  });

  it("lists spec changes with name and progress", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_spec_changes") return Promise.resolve([change()]);
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      return Promise.resolve([]);
    });

    renderLauncher();

    await waitFor(() => {
      expect(screen.getByText("vibe-spec-tabs")).toBeInTheDocument();
    });
    expect(screen.getByText("3/10")).toBeInTheDocument();
  });

  it("calls onOpenSpec when a row is clicked", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_spec_changes") return Promise.resolve([change()]);
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      return Promise.resolve([]);
    });

    const onOpenSpec = vi.fn();
    renderLauncher({ onOpenSpec });

    await waitFor(() => {
      expect(screen.getByTestId("vibe-spec-row")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("vibe-spec-row"));
    expect(onOpenSpec).toHaveBeenCalledWith("vibe-spec-tabs");
  });

  it("shows the validates badge when valid", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_spec_changes") return Promise.resolve([change()]);
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      return Promise.resolve([]);
    });

    renderLauncher();

    await waitFor(() => {
      expect(screen.getByText("validates")).toBeInTheDocument();
    });
  });

  it("shows empty state when there are no changes", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_spec_changes") return Promise.resolve([]);
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      return Promise.resolve([]);
    });

    renderLauncher();

    await waitFor(() => {
      expect(screen.getByText("No OpenSpec changes.")).toBeInTheDocument();
    });
  });

  it("marks the linked change with data-linked", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_spec_changes")
        return Promise.resolve([change({ name: "a" }), change({ name: "b" })]);
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      return Promise.resolve([]);
    });

    renderLauncher({ linkedChange: "b" });

    await waitFor(() => {
      const rows = screen.getAllByTestId("vibe-spec-row");
      const rowB = rows.find((r) => r.getAttribute("data-spec-name") === "b");
      expect(rowB?.getAttribute("data-linked")).toBe("true");
      const rowA = rows.find((r) => r.getAttribute("data-spec-name") === "a");
      expect(rowA?.getAttribute("data-linked")).toBeNull();
    });
  });
});
