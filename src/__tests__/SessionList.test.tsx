import type { ReactElement } from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import SessionList, {
  activityLabel,
  groupByFleet,
  relativeTime,
  filterThreads,
  threadState,
} from "../SessionList";
import type { FleetRow, ThreadMeta, WorktreeStatus } from "../api";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

// Amendment 3's session list. Grouping is by workspace and rendered from
// props, but the relative-timestamp formatter and the search filter both
// branch, so they get tests.

const thread = (over: Partial<ThreadMeta>): ThreadMeta => ({
  id: "t1",
  projectHash: "p",
  title: "Add a status-bar indicator",
  createdAt: "2026-08-14T09:00:00Z",
  updatedAt: "2026-08-14T09:00:00Z",
  currentMode: "go",
  openSpecChangeName: null,
  ...over,
});

describe("relativeTime", () => {
  const now = new Date("2026-08-14T12:00:00Z").getTime();

  it("reads just now under a minute", () => {
    expect(relativeTime("2026-08-14T11:59:30Z", now)).toBe("just now");
  });

  it("reads minutes under an hour", () => {
    expect(relativeTime("2026-08-14T11:58:00Z", now)).toBe("2m ago");
  });

  it("reads hours under a day", () => {
    expect(relativeTime("2026-08-14T10:00:00Z", now)).toBe("2h ago");
  });

  it("reads days beyond that", () => {
    expect(relativeTime("2026-08-12T12:00:00Z", now)).toBe("2d ago");
  });

  // A clock skew between machines must not render "-3m ago".
  it("clamps a future timestamp to just now rather than a negative age", () => {
    expect(relativeTime("2026-08-14T12:05:00Z", now)).toBe("just now");
  });

  it("renders an unparseable timestamp as empty rather than NaN", () => {
    expect(relativeTime("not-a-date", now)).toBe("");
  });
});

describe("activityLabel", () => {
  const now = new Date("2026-08-14T12:00:00Z").getTime();

  it("says both when the thread was created and when it last spoke", () => {
    expect(activityLabel("2026-08-12T12:00:00Z", "2026-08-14T10:00:00Z", now)).toBe(
      "Created 2d ago · Last active 2h ago",
    );
  });

  it("has a compact form for the narrow sidebar", () => {
    expect(activityLabel("2026-08-12T12:00:00Z", "2026-08-14T10:00:00Z", now, true)).toBe(
      "Created 2d · Active 2h",
    );
  });

  it("says a thread that never spoke has not run", () => {
    expect(activityLabel("2026-08-14T09:00:00Z", undefined, now)).toBe("Created 3h ago · Not run yet");
  });
});

describe("groupByFleet ordering", () => {
  it("puts the most recently touched thread first within a band", () => {
    const old = thread({ id: "old", updatedAt: "2026-08-01T00:00:00Z" });
    const fresh = thread({ id: "fresh", updatedAt: "2026-08-02T00:00:00Z" });
    const bands = groupByFleet([old, fresh], new Map());
    expect(bands[0].list.map((t) => t.id)).toEqual(["fresh", "old"]);
  });

  it("orders by the fleet row's touch time when there is one", () => {
    const a = thread({ id: "a", updatedAt: "2026-08-01T00:00:00Z" });
    const b = thread({ id: "b", updatedAt: "2026-08-02T00:00:00Z" });
    const rows = new Map([["a", { status: "idle", updatedAt: "2026-08-09T00:00:00Z" } as FleetRow]]);
    expect(groupByFleet([b, a], rows)[0].list.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("filterThreads", () => {
  const threads = [
    thread({ id: "a", title: "Add LSP status bar" }),
    thread({ id: "b", title: "Fix chat auto-scroll" }),
  ];

  it("returns everything for an empty query", () => {
    expect(filterThreads(threads, "")).toHaveLength(2);
  });

  it("matches case-insensitively on the title", () => {
    expect(filterThreads(threads, "lsp").map((t) => t.id)).toEqual(["a"]);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(filterThreads(threads, "  chat  ").map((t) => t.id)).toEqual(["b"]);
  });

  it("returns nothing when the query matches no title", () => {
    expect(filterThreads(threads, "zzz")).toEqual([]);
  });
});

describe("SessionList row actions", () => {
  // The Vibe sidebar lost rename/archive when it replaced the old thread
  // list; the Editor preset's History panel kept them. Same thread, same
  // two verbs, whichever sidebar you are looking at.
  const renderList = (
    over: Partial<ThreadMeta> = {},
    worktrees = new Map<string, WorktreeStatus>(),
    liveThreadIds = new Set<string>(),
  ) => {
    const onRename = vi.fn();
    const onArchive = vi.fn();
    const onSelect = vi.fn();
    render(
      <SessionList
        threads={[thread(over)]}
        activeThread={undefined}
        liveThreadIds={liveThreadIds}
        worktrees={worktrees}
        onNewThread={vi.fn()}
        onSelect={onSelect}
        onRename={onRename}
        onArchive={onArchive}
      />,
    );
    return { onRename, onArchive, onSelect };
  };

  it("renames a thread without also selecting it", () => {
    const { onRename, onSelect } = renderList();
    fireEvent.click(screen.getByTestId("session-rename"));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("archives a thread without also selecting it", () => {
    const { onArchive, onSelect } = renderList();
    fireEvent.click(screen.getByTestId("session-archive"));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("leaves archived threads out — History is where they are found again", () => {
    renderList({ archived: true });
    expect(screen.queryByTestId("session-item")).toBeNull();
  });
});

describe("threadState", () => {
  const t = thread({});
  const wt = (added: number, removed: number): WorktreeStatus => ({
    threadId: "t1",
    branch: "palisade/ABCD1234",
    added,
    removed,
  });

  it("reads running while a session is live, whatever the worktree holds", () => {
    expect(threadState(t, new Set(["t1"]), wt(4, 1))).toBe("running");
    expect(threadState(t, new Set(["t1"]), undefined)).toBe("running");
  });

  it("reads changed once the agent stops and left edits behind", () => {
    expect(threadState(t, new Set(), wt(4, 1))).toBe("changed");
    expect(threadState(t, new Set(), wt(0, 3))).toBe("changed");
  });

  it("reads idle with no session and nothing changed", () => {
    expect(threadState(t, new Set(), wt(0, 0))).toBe("idle");
    expect(threadState(t, new Set(), undefined)).toBe("idle");
  });

  it("reads needs-attention over running when a permission prompt is pending", () => {
    expect(threadState(t, new Set(["t1"]), wt(4, 1), new Set(["t1"]))).toBe(
      "needs-attention"
    );
  });

  it("reads needs-attention even with no worktree changes yet", () => {
    expect(threadState(t, new Set(["t1"]), undefined, new Set(["t1"]))).toBe(
      "needs-attention"
    );
  });
});

describe("SessionList needs-attention rendering", () => {
  const renderWithAttention = (attentionThreadIds: Set<string>) =>
    render(
      <SessionList
        threads={[thread({})]}
        activeThread={undefined}
        liveThreadIds={new Set(["t1"])}
        attentionThreadIds={attentionThreadIds}
        worktrees={new Map()}
        onNewThread={vi.fn()}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
      />
    );

  it("marks a blocked thread's dot as needs-attention, not running", () => {
    renderWithAttention(new Set(["t1"]));
    expect(screen.getByTestId("session-dot").getAttribute("data-state")).toBe(
      "needs-attention"
    );
  });

  it("shows the aggregate count of threads waiting on the user", () => {
    renderWithAttention(new Set(["t1"]));
    expect(screen.getByTestId("session-attention-count").textContent).toBe("1");
  });

  it("hides the aggregate count when nothing needs attention", () => {
    renderWithAttention(new Set());
    expect(screen.queryByTestId("session-attention-count")).toBeNull();
  });
});

describe("SessionList worktree isolation", () => {
  const worktree = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
    threadId: "t1",
    branch: "palisade/ABCD1234",
    added: 12,
    removed: 3,
    ...over,
  });

  const renderWith = (
    worktrees: Map<string, WorktreeStatus>,
    over: Partial<ThreadMeta> = {},
    live = new Set<string>(),
  ) =>
    render(
      <SessionList
        threads={[thread(over)]}
        activeThread={undefined}
        liveThreadIds={live}
        worktrees={worktrees}
        onNewThread={vi.fn()}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

  it("shows the thread's branch and diff stat", () => {
    renderWith(new Map([["t1", worktree()]]));
    expect(screen.getByText("palisade/ABCD1234")).toBeTruthy();
    expect(screen.getByText("+12")).toBeTruthy();
    expect(screen.getByText("−3")).toBeTruthy();
  });

  /// A non-git project, and a thread that has never run, have no worktree —
  /// the row must degrade to what it always was, not render empty chrome.
  it("shows no branch or diff stat for a thread with no worktree", () => {
    renderWith(new Map());
    expect(screen.queryByTestId("session-diff")).toBeNull();
    expect(screen.queryByText(/palisade\//)).toBeNull();
    expect(screen.getByTestId("session-item")).toBeTruthy();
  });

  it("hides the diff stat when the worktree is clean", () => {
    renderWith(new Map([["t1", worktree({ added: 0, removed: 0 })]]));
    expect(screen.queryByTestId("session-diff")).toBeNull();
    expect(screen.getByText("palisade/ABCD1234")).toBeTruthy();
  });

  it("marks an auto-named thread and leaves a hand-named one unmarked", () => {
    renderWith(new Map(), { titleSource: "auto" });
    expect(screen.getByLabelText("Auto-named")).toBeTruthy();
  });

  it("does not mark a thread the user named themselves", () => {
    renderWith(new Map(), { titleSource: "manual" });
    expect(screen.queryByLabelText("Auto-named")).toBeNull();
  });

  it("keeps rename and archive reachable on a row that now has a worktree", () => {
    renderWith(new Map([["t1", worktree()]]));
    expect(screen.getByTestId("session-rename")).toBeTruthy();
    expect(screen.getByTestId("session-archive")).toBeTruthy();
  });
});

// The sidebar carries the same signals as the Fleet board, from the same
// rows — a thread must not read one way on the board and another here.
describe("SessionList fleet rows", () => {
  const fleetRow = (over: Partial<FleetRow> = {}): FleetRow => ({
    kind: "thread",
    threadId: "t1",
    title: "Add a status-bar indicator",
    projectId: "p",
    projectName: "palisade",
    mode: "go",
    status: "idle",
    diff: { added: 0, removed: 0, files: 0 },
    filesTouched: [],
    overlap: [],
    verify: { state: "not_run" },
    merge: "no_worktree",
    updatedAt: "2026-08-14T09:00:00Z",
    ...over,
  });

  const renderRows = (threads: ThreadMeta[], fleetRows: FleetRow[]) =>
    render(
      <SessionList
        threads={threads}
        activeThread={undefined}
        liveThreadIds={new Set()}
        worktrees={new Map()}
        fleetRows={fleetRows}
        onNewThread={vi.fn()}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
      />,
    );

  it("colours the dot from the fleet status, not the local worktree", () => {
    renderRows([thread({})], [fleetRow({ status: "attention", attention: "permission" })]);
    expect(screen.getByTestId("session-dot").getAttribute("data-state")).toBe(
      "needs-attention",
    );
    renderRows([thread({})], [fleetRow({ status: "running" })]);
    expect(screen.getAllByTestId("session-dot")[1].getAttribute("data-state")).toBe(
      "running",
    );
  });

  // The board's diff is measured in the thread's tree by the backend; a
  // sidebar that disagreed with it would be a second, quieter truth.
  it("shows the fleet row's diff stat", () => {
    renderRows([thread({})], [fleetRow({ diff: { added: 9, removed: 4, files: 2 } })]);
    expect(screen.getByText("+9")).toBeTruthy();
    expect(screen.getByText("−4")).toBeTruthy();
  });

  it("uses the board's own wording for the attention pill", () => {
    renderRows([thread({})], [fleetRow({ status: "attention", attention: "verify_failed" })]);
    expect(screen.getByTestId("fleet-attention").textContent).toBe("Verify failed");
  });

  it("names the count and the overlapping files in the overlap icon's tooltip", async () => {
    renderRows(
      [thread({})],
      [fleetRow({ overlap: [{ threadId: "t2", files: ["src/App.tsx"] }] })],
    );
    const icon = screen.getByTestId("fleet-overlap-icon");
    expect(screen.queryByTestId("fleet-overlap")).toBeNull();
    await userEvent.hover(icon);
    expect(
      await screen.findByRole("tooltip", { name: "Overlaps 1 thread: src/App.tsx" }),
    ).toBeTruthy();
  });

  // Three lines is the row's whole budget. Attention gets the pill; overlap
  // gets the glyph on the meta line, and never a pill of its own.
  it("shows at most one pill on a row, even when it also overlaps", () => {
    renderRows(
      [thread({})],
      [
        fleetRow({
          status: "attention",
          attention: "permission",
          overlap: [{ threadId: "t2", files: ["src/App.tsx"] }],
        }),
      ],
    );
    expect(screen.getAllByTestId("fleet-attention")).toHaveLength(1);
    expect(screen.queryByTestId("fleet-overlap")).toBeNull();
    expect(screen.getByTestId("fleet-overlap-icon")).toBeTruthy();
  });

  it("groups attention over running over idle, and heads only what exists", () => {
    renderRows(
      [
        thread({ id: "t1", title: "idle one" }),
        thread({ id: "t2", title: "running one" }),
        thread({ id: "t3", title: "blocked one" }),
      ],
      [
        fleetRow({ threadId: "t2", status: "running" }),
        fleetRow({ threadId: "t3", status: "attention", attention: "permission" }),
      ],
    );
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["Needs attention", "Running", "Idle"]);
    expect(screen.queryByTestId("session-group-attention")).toBeTruthy();
    // A thread with no fleet row of its own is idle, not missing.
    expect(
      screen.getByTestId("session-group-idle").textContent,
    ).toContain("idle one");
  });

  it("heads no group the fleet left empty", () => {
    renderRows([thread({})], [fleetRow({ status: "running" })]);
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["Running"]);
  });

  // A playbook run is not a thread and has no row in this list to decorate.
  it("ignores playbook rows", () => {
    renderRows([thread({})], [fleetRow({ kind: "playbook", threadId: "t1", status: "attention", attention: "gate" })]);
    expect(screen.queryByTestId("fleet-attention")).toBeNull();
  });
});
