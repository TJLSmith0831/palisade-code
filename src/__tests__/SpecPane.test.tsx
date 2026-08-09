import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import SpecPane from "../SpecPane";

const renderPane = (linkedChange?: string | null) =>
  render(
    <MantineProvider>
      <SpecPane projectHash="proj-1" linkedChange={linkedChange} />
    </MantineProvider>
  );

describe("SpecPane", () => {
  // Block body, not a concise arrow: `mockReset()` returns the mock, and a
  // `beforeEach` that returns a function has that function called as a
  // cleanup hook — invoking `invoke()` with no command after every test.
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("lists changes from the openspec CLI and labels task counts as agent-reported", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_spec_changes") {
        return Promise.resolve([
          {
            name: "agent-session-architecture",
            completedTasks: 48,
            totalTasks: 71,
            lastModified: "2026-08-09T00:00:00Z",
            status: "in-progress",
          },
        ]);
      }
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    renderPane();

    await waitFor(() =>
      expect(screen.getByText("agent-session-architecture")).toBeDefined()
    );
    // The count is a self-report, and the UI has to say so — nothing here may
    // read as a claim that the change is done.
    expect(screen.getByText(/48\/71 tasks ticked/)).toHaveTextContent(
      /agent-reported/
    );
    // openspec's own status is attributed, never presented as Floo's verdict.
    expect(screen.getByText(/openspec: in-progress/)).toBeDefined();
    expect(screen.queryByText(/^complete$/i)).toBeNull();
  });

  it("distinguishes 'openspec is not installed' from 'validation failed'", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_spec_changes") return Promise.resolve([]);
      // `null` means the CLI is missing, so validity is unknown.
      if (cmd === "validate_spec_changes") return Promise.resolve(null);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    renderPane();

    await waitFor(() => expect(screen.getByText("unknown")).toBeDefined());
    expect(screen.queryByText("validation failed")).toBeNull();
    expect(screen.getByText(/No OpenSpec changes/)).toBeDefined();
  });

  it("writes nothing — every command it issues is a read", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_spec_changes") return Promise.resolve([]);
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    renderPane();
    await waitFor(() => expect(screen.getByText("validates")).toBeDefined());

    const issued = invokeMock.mock.calls.map(([cmd]) => cmd);
    expect(new Set(issued)).toEqual(
      new Set(["list_spec_changes", "validate_spec_changes"])
    );
  });

  it("marks the change the active thread is linked to", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_spec_changes") {
        return Promise.resolve([
          { name: "linked", completedTasks: 0, totalTasks: 0, lastModified: null, status: null },
          { name: "other", completedTasks: 0, totalTasks: 0, lastModified: null, status: null },
        ]);
      }
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    renderPane("linked");

    await waitFor(() => expect(screen.getByText("linked")).toBeDefined());
    const marked = screen
      .getAllByTestId("spec-change")
      .filter((node) => node.dataset.linked === "true");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent("linked");
  });
});
