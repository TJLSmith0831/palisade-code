import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import SpecPane from "../SpecPane";

const renderPane = (props?: {
  threadId?: string | null;
  linkedChange?: string | null;
  onOpenSpec?: (name: string) => void;
}) =>
  render(
    <MantineProvider>
      <SpecPane projectHash="proj-1" {...props} />
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
    // openspec's own status is attributed, never presented as Palisade's verdict.
    expect(screen.getByText(/openspec: in-progress/)).toBeDefined();
    expect(screen.queryByText(/^complete$/i)).toBeNull();
  });

  it("forwards the active thread's id so a proposal in its isolated worktree is visible (OPE-01)", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_spec_changes") {
        expect(args?.threadId).toBe("thread-1");
        return Promise.resolve([
          {
            name: "add-shout-flag",
            completedTasks: 0,
            totalTasks: 4,
            lastModified: "2026-08-27T00:00:00Z",
            status: "in-progress",
          },
        ]);
      }
      if (cmd === "validate_spec_changes") {
        expect(args?.threadId).toBe("thread-1");
        return Promise.resolve(true);
      }
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    renderPane({ threadId: "thread-1" });

    await waitFor(() =>
      expect(screen.getByText("add-shout-flag")).toBeDefined()
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "list_spec_changes",
      expect.objectContaining({ projectHash: "proj-1", threadId: "thread-1" })
    );
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
    expect(screen.getByText(/No changes/)).toBeDefined();
  });

  it("writes nothing — every command it issues is a read", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_spec_changes") return Promise.resolve([]);
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    renderPane();
    await waitFor(() => expect(screen.getByText("valid")).toBeDefined());

    const issued = invokeMock.mock.calls.map(([cmd]) => cmd);
    expect(new Set(issued)).toEqual(
      new Set(["list_spec_changes", "validate_spec_changes"])
    );
  });

  it("marks the change the active thread is linked to", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_spec_changes") {
        return Promise.resolve([
          {
            name: "linked",
            completedTasks: 0,
            totalTasks: 0,
            lastModified: null,
            status: null,
          },
          {
            name: "other",
            completedTasks: 0,
            totalTasks: 0,
            lastModified: null,
            status: null,
          },
        ]);
      }
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    renderPane({ linkedChange: "linked" });

    await waitFor(() => expect(screen.getByText("linked")).toBeDefined());
    const marked = screen
      .getAllByTestId("spec-change")
      .filter((node) => node.dataset.linked === "true");
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent("linked");
  });

  it("calls onOpenSpec when a change name is clicked", async () => {
    const onOpenSpec = vi.fn();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_spec_changes") {
        return Promise.resolve([
          {
            name: "agent-session-architecture",
            completedTasks: 0,
            totalTasks: 0,
            lastModified: null,
            status: null,
          },
        ]);
      }
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    renderPane({ onOpenSpec });

    await waitFor(() =>
      expect(screen.getByText("agent-session-architecture")).toBeDefined()
    );
    fireEvent.click(screen.getByText("agent-session-architecture"));
    expect(onOpenSpec).toHaveBeenCalledWith("agent-session-architecture");
  });

  it("archives a change and refreshes the list when the archive button is clicked", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_spec_changes") {
          return Promise.resolve([
            {
              name: "agent-session-architecture",
              completedTasks: 0,
              totalTasks: 0,
              lastModified: null,
              status: null,
            },
          ]);
        }
        if (cmd === "validate_spec_changes") return Promise.resolve(true);
        if (cmd === "archive_spec_change") {
          expect(args?.projectHash).toBe("proj-1");
          expect(args?.name).toBe("agent-session-architecture");
          return Promise.resolve("");
        }
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      }
    );

    renderPane();

    await waitFor(() =>
      expect(screen.getByText("agent-session-architecture")).toBeDefined()
    );
    fireEvent.click(screen.getAllByTestId("spec-archive")[0]);

    // The blue dots loader replaces the archive button while archiving.
    await waitFor(() =>
      expect(screen.getAllByTestId("archive-loader").length).toBeGreaterThan(0)
    );

    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter(([cmd]) => cmd === "archive_spec_change")
      ).toHaveLength(1)
    );
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "list_spec_changes")
    ).toHaveLength(2);
  });
});
