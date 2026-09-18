import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import FleetBoard, { groupFleet } from "../FleetBoard";
import type { FleetBoardProps } from "../FleetBoard";
import type { FleetRow } from "../api";

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

const row = (over: Partial<FleetRow> = {}): FleetRow => ({
  threadId: "t1",
  title: "Fix the merge gate",
  projectId: "p1",
  projectName: "palisade",
  agentId: "a1",
  agentName: "Agent One",
  mode: "go",
  status: "idle",
  branch: "pal/t1",
  diff: { added: 12, removed: 3, files: 2 },
  filesTouched: ["src/App.tsx"],
  overlap: [],
  verify: { state: "not_run" },
  merge: "clean",
  updatedAt: new Date().toISOString(),
  ...over,
});

const props = (over: Partial<FleetBoardProps> = {}): FleetBoardProps => ({
  rows: [row()],
  loading: false,
  agents: [{ id: "a1", name: "Agent One", installed: true }],
  onOpen: vi.fn(),
  onReview: vi.fn(),
  onStop: vi.fn(),
  onMerge: vi.fn(),
  onOpenPr: vi.fn(),
  onArchive: vi.fn(),
  onNewRun: vi.fn(),
  ...over,
});

describe("groupFleet", () => {
  it("splits rows into the three bands", () => {
    const groups = groupFleet([
      row({ threadId: "a", status: "attention", attention: "permission" }),
      row({ threadId: "b", status: "running" }),
      row({ threadId: "c", status: "idle" }),
    ]);
    expect(groups.attention.map((r) => r.threadId)).toEqual(["a"]);
    expect(groups.running.map((r) => r.threadId)).toEqual(["b"]);
    expect(groups.idle.map((r) => r.threadId)).toEqual(["c"]);
  });

  it("sorts the attention band newest first", () => {
    const groups = groupFleet([
      row({ threadId: "old", status: "attention", updatedAt: "2026-01-01T00:00:00Z" }),
      row({ threadId: "new", status: "attention", updatedAt: "2026-02-01T00:00:00Z" }),
    ]);
    expect(groups.attention.map((r) => r.threadId)).toEqual(["new", "old"]);
  });

  it("returns empty bands for no rows", () => {
    expect(groupFleet([])).toEqual({ attention: [], running: [], idle: [] });
  });
});

describe("FleetBoard", () => {
  it("renders each non-empty group", () => {
    render(
      <FleetBoard
        {...props({
          rows: [
            row({ threadId: "a", status: "attention", attention: "turn_done" }),
            row({ threadId: "b", status: "running" }),
          ],
        })}
      />
    );
    expect(screen.getByTestId("fleet-group-attention")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-group-running")).toBeInTheDocument();
    expect(screen.queryByTestId("fleet-group-idle")).toBeNull();
    expect(screen.getByTestId("fleet-attention")).toHaveTextContent("Turn finished");
  });

  it("shows the empty state with no rows", () => {
    render(<FleetBoard {...props({ rows: [] })} />);
    expect(screen.getByTestId("fleet-empty")).toHaveTextContent(
      "No runs yet. Start one above."
    );
  });

  it("labels an unverified row honestly and disables Merge", async () => {
    render(<FleetBoard {...props()} />);
    expect(screen.getByTestId("fleet-verify")).toHaveTextContent("Not verified");
    fireEvent.click(screen.getByTestId("fleet-actions"));
    expect(await screen.findByTestId("fleet-merge-disabled")).toBeInTheDocument();
  });

  it("enables Merge only with a clean merge and a passing verify", async () => {
    const onMerge = vi.fn();
    render(
      <FleetBoard
        {...props({
          rows: [row({ verify: { state: "pass", commit: "abcdef1234" }, merge: "clean" })],
          onMerge,
        })}
      />
    );
    expect(screen.getByTestId("fleet-verify")).toHaveTextContent("Verified at abcdef1");
    fireEvent.click(screen.getByTestId("fleet-actions"));
    fireEvent.click(await screen.findByText("Merge"));
    expect(onMerge).toHaveBeenCalledWith("t1");
  });

  it("names the overlapping threads", () => {
    render(
      <FleetBoard
        {...props({ rows: [row({ overlap: [{ threadId: "t2", files: ["src/api.ts"] }] })] })}
      />
    );
    expect(screen.getByTestId("fleet-overlap")).toHaveTextContent("Overlaps 1 thread");
  });

  it("opens on Enter and reviews on r", () => {
    const onOpen = vi.fn();
    const onReview = vi.fn();
    render(<FleetBoard {...props({ onOpen, onReview })} />);
    const item = screen.getByTestId("fleet-row");
    fireEvent.keyDown(item, { key: "Enter" });
    fireEvent.keyDown(item, { key: "r" });
    expect(onOpen).toHaveBeenCalledWith("t1");
    expect(onReview).toHaveBeenCalledWith("t1");
  });

  it("disables Start run until there is a prompt", () => {
    const onNewRun = vi.fn();
    render(<FleetBoard {...props({ onNewRun })} />);
    expect(screen.getByTestId("fleet-start")).toBeDisabled();
    fireEvent.change(screen.getByTestId("fleet-prompt"), {
      target: { value: "  ship it  " },
    });
    fireEvent.click(screen.getByTestId("fleet-start"));
    expect(onNewRun).toHaveBeenCalledWith({
      prompt: "ship it",
      agentId: "a1",
      mode: "spec",
      isolated: true,
    });
  });

  it("keeps Start run disabled when no agent is installed", () => {
    render(
      <FleetBoard
        {...props({ agents: [{ id: "a1", name: "Agent One", installed: false }] })}
      />
    );
    fireEvent.change(screen.getByTestId("fleet-prompt"), {
      target: { value: "ship it" },
    });
    expect(screen.getByTestId("fleet-start")).toBeDisabled();
  });
});
