import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import FleetBoard, { groupFleet, playbookSubtitle } from "../FleetBoard";
import { withInstalled } from "../SkillMenu";
import type { FleetBoardProps } from "../FleetBoard";
import type { FleetRow } from "../api";
import { ArchivingContext } from "../archiving";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listModels: vi.fn().mockResolvedValue({ configId: null, current: null, models: [] }),
    readAttachment: vi.fn().mockResolvedValue("data:image/png;base64,AA=="),
    listSkills: vi.fn().mockResolvedValue([
      { name: "grill-apply", path: "/Users/me/.claude/skills/grill-apply", description: "Implement with the decision log", owner: "claude" },
    ]),
    listAnyDirectory: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../api", () => apiMock);

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

it("does not offer the same installed skill twice when Codex advertises its dollar sigil", () => {
  expect(withInstalled(
    [{ name: "$grill-apply", description: "Agent version" }],
    [{ name: "grill-apply", path: "/skills/grill-apply", owner: "agents" }]
  )).toEqual([{ name: "$grill-apply", description: "Agent version" }]);
  expect(withInstalled([], [{ name: "grill-apply", path: "/skills/grill-apply", owner: "agents" }], "codex"))
    .toEqual([{ name: "$grill-apply", description: "" }]);
});

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
  worktreePath: "/wt/t1",
  diff: { added: 12, removed: 3, files: 2 },
  filesTouched: ["src/App.tsx"],
  overlap: [],
  verify: { state: "not_run" },
  merge: "clean",
  updatedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
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
  onArchiveRun: vi.fn(),
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
    archivable: true,
    ...over,
  });

describe("groupFleet", () => {
  it("splits rows into the four bands", () => {
    const groups = groupFleet([
      row({ threadId: "a", status: "attention", attention: "permission" }),
      row({ threadId: "b", status: "running" }),
      row({ threadId: "c", status: "idle" }),
      row({ threadId: "d", status: "unreviewed" }),
    ]);
    expect(groups.attention.map((r) => r.threadId)).toEqual(["a"]);
    expect(groups.running.map((r) => r.threadId)).toEqual(["b"]);
    expect(groups.unreviewed.map((r) => r.threadId)).toEqual(["d"]);
    expect(groups.idle.map((r) => r.threadId)).toEqual(["c"]);
  });

  it("sorts the unreviewed band newest first", () => {
    const groups = groupFleet([
      row({ threadId: "old", status: "unreviewed", updatedAt: "2026-01-01T00:00:00Z" }),
      row({ threadId: "new", status: "unreviewed", updatedAt: "2026-02-01T00:00:00Z" }),
    ]);
    expect(groups.unreviewed.map((r) => r.threadId)).toEqual(["new", "old"]);
  });

  // A new prompt on an unreviewed thread makes it running again; the stale
  // row must not pin it under "Unreviewed" until the poll catches up.
  it("lets a live session move an unreviewed thread back to Running", () => {
    const groups = groupFleet([row({ threadId: "t", status: "unreviewed" })], new Set(["t"]));
    expect(groups.running.map((r) => r.threadId)).toEqual(["t"]);
    expect(groups.unreviewed).toEqual([]);
  });

  it("sorts the attention band newest first", () => {
    const groups = groupFleet([
      row({ threadId: "old", status: "attention", updatedAt: "2026-01-01T00:00:00Z" }),
      row({ threadId: "new", status: "attention", updatedAt: "2026-02-01T00:00:00Z" }),
    ]);
    expect(groups.attention.map((r) => r.threadId)).toEqual(["new", "old"]);
  });

  it("returns empty bands for no rows", () => {
    expect(groupFleet([])).toEqual({ attention: [], running: [], unreviewed: [], idle: [] });
  });

  // The row's own status only catches up on the next executor event or the
  // slow poll (useFleet); a run just started from this board must not sit
  // under "Idle" until then, so `liveThreadIds` overrides a stale row.
  it("puts a just-started thread under Running even before its row catches up", () => {
    const groups = groupFleet(
      [row({ threadId: "t", status: "idle" })],
      new Set(["t"]),
    );
    expect(groups.running.map((r) => r.threadId)).toEqual(["t"]);
    expect(groups.idle).toEqual([]);
  });

  it("never lets a live session mask a row waiting on a permission prompt", () => {
    const groups = groupFleet(
      [row({ threadId: "t", status: "attention", attention: "permission" })],
      new Set(["t"]),
    );
    expect(groups.attention.map((r) => r.threadId)).toEqual(["t"]);
    expect(groups.running).toEqual([]);
  });

  it("leaves a playbook row alone — liveThreadIds keys by thread, not run", () => {
    const groups = groupFleet(
      [playbookRow({ threadId: "run-1", status: "idle" })],
      new Set(["run-1"]),
    );
    expect(groups.idle.map((r) => r.threadId)).toEqual(["run-1"]);
    expect(groups.running).toEqual([]);
  });
});

describe("FleetBoard", () => {
  it("renders each non-empty group", () => {
    render(
      <FleetBoard
        {...props({
          rows: [
            row({ threadId: "a", status: "attention", attention: "verify_failed" }),
            row({ threadId: "b", status: "running" }),
            row({ threadId: "c", status: "unreviewed" }),
          ],
        })}
      />
    );
    expect(screen.getByTestId("fleet-group-attention")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-group-running")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-group-unreviewed")).toBeInTheDocument();
    expect(screen.queryByTestId("fleet-group-idle")).toBeNull();
    expect(screen.getByTestId("fleet-attention")).toHaveTextContent("Verify failed");
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
      attachments: [],
      skills: [],
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
          rows: [playbookRow({ status: "running", archivable: false })],
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

  it("offers Stop on a just-started thread before its row confirms running", async () => {
    const onStop = vi.fn();
    render(
      <FleetBoard
        {...props({
          rows: [row({ threadId: "t", status: "idle" })],
          liveThreadIds: new Set(["t"]),
          onStop,
        })}
      />
    );
    fireEvent.click(screen.getByTestId("fleet-actions"));
    fireEvent.click(await screen.findByText("Stop"));
    expect(onStop).toHaveBeenCalledWith("t");
  });

  it("offers Archive for a finished playbook run", async () => {
    const onArchiveRun = vi.fn();
    render(<FleetBoard {...props({ rows: [playbookRow()], onArchiveRun })} />);
    fireEvent.click(screen.getByTestId("fleet-actions"));
    expect(await screen.findByText("Open")).toBeInTheDocument();
    expect(screen.queryByText("Merge")).toBeNull();
    expect(screen.queryByTestId("fleet-merge-disabled")).toBeNull();
    expect(screen.queryByText("Open PR")).toBeNull();
    expect(screen.getByText("Archive")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Archive"));
    expect(onArchiveRun).toHaveBeenCalledWith("p1", "run-1");
  });

  it("heads the board with the project and its four status counts", () => {
    render(
      <FleetBoard
        {...props({
          projectName: "palisade",
          rows: [
            row({ threadId: "t1", status: "attention", attention: "crashed" }),
            row({ threadId: "t2", status: "running" }),
            row({ threadId: "t3", status: "idle" }),
            row({ threadId: "t4", status: "idle" }),
            row({ threadId: "t5", status: "unreviewed" }),
          ],
        })}
      />
    );
    expect(screen.getByText("palisade")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-count-attention")).toHaveTextContent("1Needs attention");
    expect(screen.getByTestId("fleet-count-running")).toHaveTextContent("1Running");
    expect(screen.getByTestId("fleet-count-unreviewed")).toHaveTextContent("1Unreviewed");
    expect(screen.getByTestId("fleet-count-idle")).toHaveTextContent("2Idle");
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

  /** A branch with no worktree is a thread whose worktree is gone. Whatever
   *  the backend measured there is not this thread's work. */
  it("shows no diff for a thread whose worktree is gone", () => {
    render(<FleetBoard {...props({ rows: [row({ worktreePath: undefined })] })} />);
    expect(screen.queryByTestId("fleet-diff")).toBeNull();
  });

  it("names the merge target only when it is not the current branch", () => {
    const withTarget = render(<FleetBoard {...props({ rows: [row({ mergeTarget: "main" })] })} />);
    expect(screen.getByText("palisade \u00b7 pal/t1 \u2192 main")).toBeInTheDocument();
    withTarget.unmount();

    render(<FleetBoard {...props()} />);
    expect(screen.getByText("palisade \u00b7 pal/t1")).toBeInTheDocument();
  });

  /** The row is ordered by last touched, which includes opening the thread.
   *  What it shows is when the thread was made and when it last spoke. */
  it("shows created and last-active times, not the touch time", () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    render(
      <FleetBoard
        {...props({
          rows: [
            row({
              updatedAt: ago(1000),
              createdAt: ago(11 * 86_400_000),
              lastActivityAt: ago(2 * 86_400_000),
            }),
          ],
        })}
      />
    );
    expect(screen.getByTestId("fleet-times")).toHaveTextContent("Created 11d ago · Last active 2d ago");
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
      attachments: [],
      skills: [],
    });
  });

  it("preselects the model the probe says a session would run — the agent's default", async () => {
    apiMock.listModels.mockResolvedValueOnce({
      configId: "model",
      current: "default",
      models: [
        { id: "default", name: "Default (recommended)" },
        { id: "claude-fable-5-1", name: "Fable 5.1" },
      ],
    });
    const onNewRun = vi.fn();
    render(<FleetBoard {...props({ onNewRun })} />);
    await waitFor(() => expect(screen.getByTestId("fleet-model-select")).toHaveValue("Default (recommended)"));
  });

  it("falls back to the agent's current model when it offers no default option", async () => {
    apiMock.listModels.mockResolvedValueOnce({
      configId: "model",
      current: "m2",
      models: [
        { id: "m1", name: "Model One" },
        { id: "m2", name: "Model Two" },
      ],
    });
    render(<FleetBoard {...props()} />);
    await waitFor(() => expect(screen.getByTestId("fleet-model-select")).toHaveValue("Model Two"));
  });

  it("shows skeleton rows only after a short delay on the first load, never over real rows", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<FleetBoard {...props({ rows: [], loading: true })} />);
      expect(screen.queryByTestId("fleet-skeleton")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByTestId("fleet-skeleton")).toBeInTheDocument();
      expect(screen.queryByTestId("fleet-empty")).toBeNull();
      expect(screen.getByTestId("fleet-board")).toHaveAttribute("aria-busy", "true");
      rerender(<FleetBoard {...props({ rows: [], loading: false })} />);
      expect(screen.queryByTestId("fleet-skeleton")).toBeNull();
      expect(screen.getByTestId("fleet-empty")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("toggles isolation with the thread-style badge, and the choice reaches the start-run payload", () => {
    const onNewRun = vi.fn();
    render(<FleetBoard {...props({ onNewRun })} />);
    const badge = screen.getByTestId("fleet-isolated");
    expect(badge).toHaveTextContent("Isolated");
    expect(badge).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(badge);
    expect(badge).toHaveTextContent("Project root");
    expect(badge).toHaveAttribute("aria-pressed", "false");
    fireEvent.change(screen.getByTestId("fleet-prompt"), { target: { value: "ship it" } });
    fireEvent.click(screen.getByTestId("fleet-start"));
    expect(onNewRun).toHaveBeenCalledWith(expect.objectContaining({ isolated: false }));
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

describe("FleetBoard — archive in flight", () => {
  const withArchiving = (ids: string[], rows: FleetRow[]) =>
    render(
      <ArchivingContext.Provider value={new Set(ids)}>
        <FleetBoard {...props({ rows })} />
      </ArchivingContext.Provider>,
    );

  it("swaps a thread row's actions button for a spinner and disables it", () => {
    withArchiving(["t1"], [row()]);
    expect(screen.getByLabelText("Archiving")).toBeInTheDocument();
    expect(screen.getByTestId("fleet-actions")).toBeDisabled();
    expect(screen.getByTestId("fleet-row")).toHaveAttribute("data-busy", "true");
  });

  it("keys a playbook run by its run id, the id it is archived by", () => {
    withArchiving(["run-1"], [playbookRow({ threadId: "thread-of-run", runId: "run-1" })]);
    expect(screen.getByLabelText("Archiving")).toBeInTheDocument();
  });

  it("leaves other rows alone", () => {
    withArchiving(["t1"], [row(), row({ threadId: "t2" })]);
    expect(screen.getAllByLabelText("Archiving")).toHaveLength(1);
  });
});

describe("FleetBoard attachments", () => {
  it("starts a run with dropped images and files, even with no prompt", () => {
    const onNewRun = vi.fn();
    render(
      <FleetBoard
        {...props({ onNewRun })}
        attachments={["/home/.palisade-code/projects/p/attachments/a.png"]}
        files={["/Users/me/notes.pdf", "/Users/me/spec.md"]}
      />
    );
    expect(screen.getAllByTestId("attachment-thumb")).toHaveLength(1);
    expect(screen.getAllByTestId("file-chip")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("fleet-start"));
    expect(onNewRun).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "@/Users/me/notes.pdf @/Users/me/spec.md",
        attachments: ["/home/.palisade-code/projects/p/attachments/a.png"],
      })
    );
  });
});

describe("FleetBoard skills", () => {
  it("grows the prompt to reveal text beyond its initial three rows", () => {
    render(<FleetBoard {...props()} />);
    const input = screen.getByTestId("fleet-prompt") as HTMLTextAreaElement;
    Object.defineProperties(input, {
      offsetHeight: { configurable: true, value: 76 },
      clientHeight: { configurable: true, value: 74 },
      scrollHeight: { configurable: true, value: 140 },
    });
    fireEvent.change(input, { target: { value: "one\ntwo\nthree\nfour" } });
    expect(input.style.height).toBe("142px");
  });

  const typeAt = (value: string) => {
    const input = screen.getByTestId("fleet-prompt");
    fireEvent.change(input, { target: { value } });
    fireEvent.select(input, { target: { selectionStart: value.length } });
    return input;
  };

  it("picks an advertised skill mid-sentence and sends it beside the run's prompt", async () => {
    const onNewRun = vi.fn();
    render(
      <FleetBoard
        {...props({ onNewRun })}
        skillCommands={[{ name: "tdd", description: "Test-driven development loop" }]}
      />
    );
    const input = typeAt("ship the login fix, /td");
    expect(await screen.findByTestId("command-menu")).toHaveTextContent("/tdd");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("composer-chip")).toHaveTextContent("/tdd"));
    expect(screen.getByTestId("fleet-prompt")).toHaveValue("ship the login fix, ");
    fireEvent.click(screen.getByTestId("fleet-start"));
    expect(onNewRun).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "ship the login fix,", skills: ["tdd"] })
    );
  });

  it("offers installed skills even before any session has advertised one", async () => {
    render(<FleetBoard {...props({ agents: [{ id: "claude", name: "Claude Agent", installed: true }] })} />);
    typeAt("/gri");
    expect(await screen.findByTestId("command-menu")).toHaveTextContent("/grill-apply");
  });

  it("browses a sibling directory from the project and inserts an absolute path", async () => {
    apiMock.listAnyDirectory.mockResolvedValueOnce([
      { name: "palisade-website", is_dir: true, path: "/projects/palisade-website" },
    ]);
    render(<FleetBoard {...props({ projectHash: "project-1" })} />);
    const input = typeAt("See @../palisade-web");
    expect(await screen.findByTestId("mention-menu")).toHaveTextContent("palisade-website");
    expect(apiMock.listAnyDirectory).toHaveBeenCalledWith("../", false, "project-1");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).toHaveValue("See @/projects/palisade-website/"));
  });
});
