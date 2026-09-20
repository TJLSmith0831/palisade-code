import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import FleetBoard, { groupFleet, playbookSubtitle } from "../FleetBoard";
import type { FleetBoardProps } from "../FleetBoard";
import type { FleetRow } from "../api";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listModels: vi.fn().mockResolvedValue({ configId: null, current: null, models: [] }),
  },
}));
vi.mock("../api", () => apiMock);

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

const row = (over: Partial<FleetRow> = {}): FleetRow => ({
  kind: "thread",
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
  onOpenRun: vi.fn(),
  onCancelRun: vi.fn(),
  onNewRun: vi.fn(),
  ...over,
});

/** One run of a playbook: a run id for identity, no branch and no diff. */
const playbookRow = (over: Partial<FleetRow> = {}): FleetRow =>
  row({
    kind: "playbook",
    threadId: "run-1",
    runId: "run-1",
    playbookName: "draft then review",
    title: "draft then review",
    branch: undefined,
    diff: { added: 0, removed: 0, files: 0 },
    filesTouched: [],
    merge: "no_worktree",
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
    expect(onMerge).toHaveBeenCalledWith("p1", "t1");
  });

  it("keeps the row project on cross-project actions", async () => {
    const onOpenPr = vi.fn();
    const onArchive = vi.fn();
    render(
      <FleetBoard
        {...props({
          rows: [row({ projectId: "other-project" })],
          onOpenPr,
          onArchive,
        })}
      />
    );
    fireEvent.click(screen.getByTestId("fleet-actions"));
    fireEvent.click(await screen.findByText("Open PR"));
    expect(onOpenPr).toHaveBeenCalledWith("other-project", "t1");

    fireEvent.click(screen.getByTestId("fleet-actions"));
    fireEvent.click(await screen.findByText("Archive"));
    expect(onArchive).toHaveBeenCalledWith("other-project", "t1");
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

  it("names a playbook row as one, with its playbook and its glyph", () => {
    render(<FleetBoard {...props({ rows: [playbookRow()] })} />);
    // The title names the playbook; the subtitle names what this run of it
    // was actually asked to do.
    expect(screen.getByTestId("fleet-row")).toHaveTextContent("draft then review");
    expect(screen.getByTestId("fleet-row")).toHaveTextContent("Playbook run");
    expect(screen.getByLabelText("Playbook")).toBeInTheDocument();
    // A run writes in its thread's tree and has no commit of its own, so
    // neither a diff nor a verify verdict would say anything true here.
    expect(screen.queryByTestId("fleet-diff")).toBeNull();
    expect(screen.queryByTestId("fleet-verify")).toBeNull();
  });

  it("calls the run to a stop at a gate 'Needs approval'", () => {
    render(
      <FleetBoard
        {...props({ rows: [playbookRow({ status: "attention", attention: "gate" })] })}
      />
    );
    expect(screen.getByTestId("fleet-attention")).toHaveTextContent("Needs approval");
  });

  it("opens and stops a playbook row by run id, never by thread", async () => {
    const onOpen = vi.fn();
    const onStop = vi.fn();
    const onOpenRun = vi.fn();
    const onCancelRun = vi.fn();
    render(
      <FleetBoard
        {...props({
          rows: [playbookRow({ status: "running" })],
          onOpen,
          onStop,
          onOpenRun,
          onCancelRun,
        })}
      />
    );
    fireEvent.click(screen.getByTestId("fleet-row"));
    fireEvent.click(screen.getByTestId("fleet-actions"));
    fireEvent.click(await screen.findByText("Stop"));
    expect(onOpenRun).toHaveBeenCalledWith("run-1");
    expect(onCancelRun).toHaveBeenCalledWith("run-1");
    expect(onOpen).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("hides Merge, Open PR and Archive on a playbook row", async () => {
    render(<FleetBoard {...props({ rows: [playbookRow()] })} />);
    fireEvent.click(screen.getByTestId("fleet-actions"));
    expect(await screen.findByText("Open")).toBeInTheDocument();
    expect(screen.queryByText("Merge")).toBeNull();
    expect(screen.queryByTestId("fleet-merge-disabled")).toBeNull();
    expect(screen.queryByText("Open PR")).toBeNull();
    expect(screen.queryByText("Archive")).toBeNull();
  });

  it("heads the board with the project and what the fleet is doing", () => {
    render(
      <FleetBoard
        {...props({
          projectName: "palisade",
          rows: [
            row({ threadId: "t1", status: "attention", attention: "turn_done" }),
            row({ threadId: "t2", status: "running" }),
            row({ threadId: "t3", status: "idle" }),
            row({ threadId: "t4", status: "idle" }),
          ],
        })}
      />
    );
    expect(screen.getByText("palisade")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-counts")).toHaveTextContent(
      "1 need attention \u00b7 1 running \u00b7 2 idle"
    );
  });

  /** New files carry no line counts, so the stat says them rather than
   *  folding them into a number that cannot hold them. */
  it("appends the new-file count only when there are untracked files", () => {
    const withNew = render(
      <FleetBoard
        {...props({ rows: [row({ diff: { added: 12, removed: 3, files: 2, untracked: 4 } })] })}
      />
    );
    expect(screen.getByTestId("fleet-diff")).toHaveTextContent("+12 \u22123 \u00b7 2 files \u00b7 4 new");
    withNew.unmount();

    render(<FleetBoard {...props()} />);
    expect(screen.getByTestId("fleet-diff")).not.toHaveTextContent("new");
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

  it("offers the selected agent's advertised models, and the pick reaches the start-run payload", async () => {
    apiMock.listModels.mockResolvedValueOnce({
      configId: "model",
      current: null,
      models: [{ id: "m1", name: "Model One" }],
    });
    const onNewRun = vi.fn();
    render(<FleetBoard {...props({ onNewRun })} />);

    const select = screen.getByTestId("fleet-model-select");
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(apiMock.listModels).toHaveBeenCalledWith(null, "a1");

    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: "Model One", hidden: true }));

    fireEvent.change(screen.getByTestId("fleet-prompt"), {
      target: { value: "ship it" },
    });
    fireEvent.click(screen.getByTestId("fleet-start"));

    expect(onNewRun).toHaveBeenCalledWith({
      prompt: "ship it",
      agentId: "a1",
      model: "m1",
      mode: "spec",
      isolated: true,
    });
  });

  it("disables the model select with a clear placeholder while loading, and when the agent offers none", async () => {
    let resolveModels: (state: { configId: null; current: null; models: never[] }) => void =
      () => {};
    apiMock.listModels.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveModels = resolve;
        })
    );
    render(<FleetBoard {...props()} />);

    const select = screen.getByTestId("fleet-model-select");
    expect(select).toBeDisabled();
    expect(select).toHaveAttribute("placeholder", "Loading models…");

    resolveModels({ configId: null, current: null, models: [] });
    await waitFor(() =>
      expect(select).toHaveAttribute("placeholder", "No models offered")
    );
    expect(select).toBeDisabled();
  });

  it("renders no effort control — no ACP channel advertises one", () => {
    render(<FleetBoard {...props()} />);
    expect(screen.queryByLabelText(/effort/i)).toBeNull();
    expect(document.querySelector('[data-testid*="effort"]')).toBeNull();
  });

  it("colors the Spec/Go control like the main composer's, active segment filled", () => {
    render(<FleetBoard {...props()} />);
    const specActive = document.querySelector(".mode-selector-control[data-active]");
    expect(specActive).toHaveTextContent("Spec");

    fireEvent.click(screen.getByText("Go"));
    const goActive = document.querySelector(".mode-selector-control[data-active]");
    expect(goActive).toHaveTextContent("Go");
  });
});

describe("playbookSubtitle", () => {
  it("says what the run was seeded with, truncated", () => {
    expect(playbookSubtitle(playbookRow({ seed: "ship the release notes" }))).toBe(
      "Playbook \u00b7 ship the release notes"
    );
    const long = "x".repeat(80);
    const line = playbookSubtitle(playbookRow({ seed: long }));
    expect(line).toBe(`Playbook \u00b7 ${"x".repeat(60)}\u2026`);
  });

  /** A run with nothing to say says nothing, rather than an empty "Playbook \u00b7 ". */
  it("falls back when the run records no seed", () => {
    expect(playbookSubtitle(playbookRow())).toBe("Playbook run");
    expect(playbookSubtitle(playbookRow({ seed: "   " }))).toBe("Playbook run");
  });
});
