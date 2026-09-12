import { beforeEach, describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SourceControlPanel, { commitRowHeight, isStaged, layoutGraph, shortRef, statusChip, splitPath, subjectLines } from "../SourceControlPanel";
import * as api from "../api";

vi.mock("../api", () => ({
  gitAheadBehind: vi.fn(),
  gitStatus: vi.fn(),
  gitLog: vi.fn(),
  gitGraph: vi.fn(),
  gitStageFile: vi.fn(),
  gitUnstageFile: vi.fn(),
  gitCommit: vi.fn(),
  gitFetch: vi.fn(),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
  gitInit: vi.fn(),
  draftCommitMessage: vi.fn(),
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

const props = {
  projectHash: "p1",
  branch: "main",
  onOpenFile: vi.fn(),
  onReviewWorkingChanges: vi.fn(),
  onSelectCommit: vi.fn(),
  onSelectWorkingChanges: vi.fn(),
  onOpenBranchPicker: vi.fn(),
  onError: vi.fn(),
};

beforeEach(() => {
  for (const fn of Object.values(mocked)) fn.mockReset?.().mockResolvedValue(undefined);
  mocked.gitStatus.mockResolvedValue([
    { path: "src/a.ts", code: "M " },
    { path: "src/b.ts", code: " M" },
    { path: "new.ts", code: "??" },
  ]);
  mocked.gitAheadBehind.mockResolvedValue([0, 0]);
  mocked.gitLog.mockResolvedValue([
    { hash: "abc1234", subject: "first", author: "T", date: "2026-08-14" },
  ]);
  mocked.gitGraph.mockResolvedValue([
    { hash: "feature123", parents: ["abc1234"], subject: "document source control", author: "T", date: "2026-08-14", refs: ["feature/docs"] },
  ]);
});

describe("isStaged", () => {
  it("reads the index column, not the working-tree one", () => {
    // Porcelain's first char is the index: "M " is staged, " M" is not.
    expect(isStaged("M ")).toBe(true);
    expect(isStaged("A ")).toBe(true);
    expect(isStaged(" M")).toBe(false);
    expect(isStaged("??")).toBe(false);
    // Both columns set: staged content plus later edits.
    expect(isStaged("MM")).toBe(true);
  });
});

describe("SourceControlPanel staging", () => {
  it("shows repository branch refs in its Graph section, not in a separate workspace", async () => {
    render(<SourceControlPanel {...props} />);

    expect(await screen.findByText("feature/docs")).toBeDefined();
    expect(screen.getByText("document source control")).toBeDefined();
  });

  it("shows the branch as a chip in the header that opens the branch picker", async () => {
    render(<SourceControlPanel {...props} />);

    const chip = await screen.findByRole("button", { name: "Switch branch: main" });
    fireEvent.click(chip);
    expect(props.onOpenBranchPicker).toHaveBeenCalled();
  });

  it("explains branch vs. working tree from an info control in the header", async () => {
    render(<SourceControlPanel {...props} />);

    expect(
      await screen.findByLabelText("What's the difference between branch and working tree?")
    ).toBeDefined();
  });

  it("shows a compact relative age for each commit in the graph", async () => {
    mocked.gitGraph.mockResolvedValue([
      {
        hash: "recent123",
        parents: [],
        subject: "recent change",
        author: "T",
        date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        refs: [],
      },
    ]);
    render(<SourceControlPanel {...props} />);

    expect(await screen.findByText("2d ago")).toBeDefined();
  });

  it("lets the user focus a commit row while keeping its branch ref visible", async () => {
    render(<SourceControlPanel {...props} />);

    const commit = await screen.findByRole("button", {
      name: "View commit document source control",
    });
    expect(commit).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(commit);
    expect(commit).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("feature/docs")).toBeDefined();
  });

  it("opens the commit's diff on click, not just the row highlight", async () => {
    const onSelectCommit = vi.fn();
    render(<SourceControlPanel {...props} onSelectCommit={onSelectCommit} />);

    const commit = await screen.findByRole("button", {
      name: "View commit document source control",
    });
    fireEvent.click(commit);

    expect(onSelectCommit).toHaveBeenCalledWith(
      expect.objectContaining({ hash: "feature123", subject: "document source control" })
    );
  });

  it("draws branch lanes and filters repository history inside Source Control", async () => {
    mocked.gitGraph.mockResolvedValue([
      { hash: "merge", parents: ["main", "feature"], subject: "merge feature", author: "T", date: "2026-08-14", refs: ["main"] },
      { hash: "feature", parents: ["base"], subject: "branch work", author: "T", date: "2026-08-13", refs: ["feature/docs"] },
      { hash: "main", parents: ["base"], subject: "main work", author: "T", date: "2026-08-13", refs: [] },
    ]);
    render(<SourceControlPanel {...props} />);

    await screen.findByText("merge feature");
    const lane = screen.getAllByTestId("sc-graph-lane")[0];
    expect(lane.getAttribute("width")).toBe("26");
    // Bug #1: rows used to carry 1px of vertical padding around this SVG,
    // leaving a 2px seam between adjacent rows where the connecting lane line
    // broke. Locking the SVG's own height to the row's exact height is what
    // makes rows butt together with no gap. The height is no longer a flat 24
    // — a row is as tall as its subject and refs need — so the invariant is
    // the agreement between the two, not the constant it used to be.
    expect(lane.getAttribute("height")).toBe(
      String(parseInt(screen.getAllByTestId("sc-commit-row")[0].style.height, 10))
    );
    expect(lane.getAttribute("height")).toBe(String(commitRowHeight("merge feature", 1)));
    // The filter box sits above the scrollable commit list, not inside it —
    // scrolling a long history must not scroll the filter out of reach.
    expect(screen.getByTestId("sc-graph-body").contains(screen.getByLabelText("Filter commit graph"))).toBe(false);
    fireEvent.change(screen.getByLabelText("Filter commit graph"), {
      target: { value: "feature/docs" },
    });
    expect(screen.getByText("branch work")).toBeDefined();
    expect(screen.queryByText("main work")).toBeNull();
  });

  it("draws each row's own line the full row height, not just from the node down", async () => {
    // Bug #1's other half: a straight run's own outgoing line used to start
    // at the node's center (y=12), leaving y=0-12 undrawn every row — a
    // 12px void nothing else bridged, even with the row-height fix above.
    // A clean tree, so HEAD is genuinely the top row — no uncommitted node
    // feeding into it from above.
    mocked.gitStatus.mockResolvedValue([]);
    mocked.gitGraph.mockResolvedValue([
      { hash: "c3", parents: ["c2"], subject: "third", author: "T", date: "2026-08-15", refs: [] },
      { hash: "c2", parents: ["c1"], subject: "second", author: "T", date: "2026-08-14", refs: [] },
      { hash: "c1", parents: [], subject: "first", author: "T", date: "2026-08-13", refs: [] },
    ]);
    render(<SourceControlPanel {...props} />);
    await screen.findByText("third");

    const lanes = screen.getAllByTestId("sc-graph-lane");
    const pathsOf = (row: number) =>
      Array.from(lanes[row].querySelectorAll(".ds-sc-graph-line")).map((el) => el.getAttribute("d"));

    // The very top row has nothing above it to connect to — no stray stub.
    expect(pathsOf(0)).toEqual([expect.stringMatching(/^M \d+(\.\d+)? 12 C /)]);
    // A middle row bridges the incoming half (from the row above, y=0 to
    // its own node at y=12) and the outgoing curve (y=12 to y=24) as two
    // segments, so each can carry its own colour.
    expect(pathsOf(1)).toEqual([
      expect.stringMatching(/^M \d+(\.\d+)? 0 L \d+(\.\d+)? 12$/),
      expect.stringMatching(/^M \d+(\.\d+)? 12 C /),
    ]);
  });

  it("shows the focused thread's worktree and opens the same picker workflow as branch", async () => {
    const onOpenWorkingTreePicker = vi.fn();
    render(
      <SourceControlPanel
        {...props}
        workingTrees={[
          { id: null, label: "Project root", branch: "main" },
          { id: "t1", label: "Docs", branch: "palisade/docs" },
        ]}
        selectedTreeId="t1"
        onOpenWorkingTreePicker={onOpenWorkingTreePicker}
      />
    );

    const treeButton = await screen.findByRole("button", {
      name: "Switch working tree: Docs",
    });
    expect(treeButton).toHaveTextContent("Docs · palisade/docs");
    fireEvent.click(treeButton);
    expect(onOpenWorkingTreePicker).toHaveBeenCalled();
  });

  it("uses the selected tree for the visible branch, file diff, and review", async () => {
    const onOpenFile = vi.fn();
    const onReviewWorkingChanges = vi.fn();
    render(
      <SourceControlPanel
        {...props}
        branch="feature/source-control"
        workingTrees={[
          { id: null, label: "Project root", branch: "main" },
          { id: "t1", label: "Source control", branch: "feature/source-control" },
        ]}
        selectedTreeId="t1"
        onOpenFile={onOpenFile}
        onReviewWorkingChanges={onReviewWorkingChanges}
      />
    );

    expect(await screen.findByPlaceholderText(/feature\/source-control/)).toBeDefined();
    fireEvent.click((await screen.findAllByTestId("sc-file"))[0]);
    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts", "t1");
    fireEvent.click(screen.getByTestId("sc-review"));
    expect(onReviewWorkingChanges).toHaveBeenCalledWith("t1");
  });

  it("separates staged changes from unstaged ones", async () => {
    render(<SourceControlPanel {...props} />);
    const staged = await screen.findByTestId("sc-staged-section");
    expect(within(staged).getByText("a.ts")).toBeDefined();

    const changes = screen.getByTestId("sc-changes-section");
    expect(within(changes).getByText("b.ts")).toBeDefined();
    expect(within(changes).getByText("new.ts")).toBeDefined();
  });

  it("opens the file from anywhere on the row, not only the filename", async () => {
    const onOpenFile = vi.fn();
    render(<SourceControlPanel {...props} onOpenFile={onOpenFile} />);
    // The row has a pointer cursor and a hover state, so a click on the
    // padding beside the name looked live and did nothing.
    fireEvent.click((await screen.findAllByTestId("sc-file"))[0]);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it("stages without also opening the file", async () => {
    const onOpenFile = vi.fn();
    render(<SourceControlPanel {...props} onOpenFile={onOpenFile} />);
    fireEvent.click(await screen.findByTestId("sc-stage-src/b.ts"));
    await waitFor(() =>
      expect(mocked.gitStageFile).toHaveBeenCalledWith("p1", "src/b.ts", undefined)
    );
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("stages one file", async () => {
    render(<SourceControlPanel {...props} />);
    fireEvent.click(await screen.findByTestId("sc-stage-src/b.ts"));
    await waitFor(() =>
      expect(mocked.gitStageFile).toHaveBeenCalledWith("p1", "src/b.ts", undefined)
    );
  });

  it("unstages one file", async () => {
    render(<SourceControlPanel {...props} />);
    fireEvent.click(await screen.findByTestId("sc-unstage-src/a.ts"));
    await waitFor(() =>
      expect(mocked.gitUnstageFile).toHaveBeenCalledWith("p1", "src/a.ts", undefined)
    );
  });

  /** The panel used to read and write the project root no matter which
   *  thread was active, so an agent's worktree changes never appeared here
   *  and could not be committed from the UI at all. */
  it("reads and writes the active thread's worktree, not the project root", async () => {
    render(<SourceControlPanel {...props} threadId="t1" />);

    await waitFor(() =>
      expect(mocked.gitStatus).toHaveBeenCalledWith("p1", "t1")
    );
    expect(mocked.gitLog).toHaveBeenCalledWith("p1", 12, "t1");
    expect(mocked.gitAheadBehind).toHaveBeenCalledWith("p1", "t1");

    fireEvent.click(await screen.findByTestId("sc-stage-src/b.ts"));
    await waitFor(() =>
      expect(mocked.gitStageFile).toHaveBeenCalledWith("p1", "src/b.ts", "t1")
    );
  });

  /** The panel and the diff pane render the same working tree from separate
   *  state. Staging here left the pane still showing the file as unstaged. */
  it("tells the app the working tree changed after a write", async () => {
    const onChanged = vi.fn();
    render(<SourceControlPanel {...props} onChanged={onChanged} />);

    fireEvent.click(await screen.findByTestId("sc-stage-src/b.ts"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("stages many files one at a time — git's index takes an exclusive lock", async () => {
    const inFlight: string[] = [];
    let maxConcurrent = 0;
    mocked.gitStageFile.mockImplementation(async (_hash: string, path: string) => {
      inFlight.push(path);
      maxConcurrent = Math.max(maxConcurrent, inFlight.length);
      await new Promise((r) => setTimeout(r, 5));
      inFlight.splice(inFlight.indexOf(path), 1);
    });

    render(<SourceControlPanel {...props} />);
    fireEvent.click(await screen.findByTestId("sc-stage-all"));
    await waitFor(() => expect(mocked.gitStageFile).toHaveBeenCalledTimes(2));
    // Parallel `git add` fails with "Unable to create '.git/index.lock'".
    expect(maxConcurrent).toBe(1);
  });

  it("collapses and reopens a section, the way every other IDE does", async () => {
    render(<SourceControlPanel {...props} />);
    await screen.findByTestId("sc-changes-section");
    expect(screen.getAllByTestId("sc-file").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("sc-toggle-changes"));
    expect(
      within(screen.getByTestId("sc-changes-section")).queryAllByTestId("sc-file")
    ).toHaveLength(0);

    fireEvent.click(screen.getByTestId("sc-toggle-changes"));
    expect(
      within(screen.getByTestId("sc-changes-section")).queryAllByTestId("sc-file").length
    ).toBeGreaterThan(0);
  });

  it("says how far ahead and behind the branch is, on the actions that act on it", async () => {
    // This used to be visible on the diff pane's own Pull/Push buttons; it
    // is real information ("push what, exactly?") and it should not have
    // disappeared with them.
    mocked.gitAheadBehind.mockResolvedValue([2, 3]);
    render(<SourceControlPanel {...props} />);
    fireEvent.click(await screen.findByLabelText("Remote actions"));
    expect(await screen.findByTestId("sc-pull")).toHaveTextContent("Pull 3");
    expect(screen.getByTestId("sc-push")).toHaveTextContent("Push 2");
  });

  it("says when there is no upstream rather than showing bare verbs", async () => {
    // A reviewer read countless Pull/Push as "can't tell if there's
    // anything to sync". With no upstream there is nothing to count, and
    // saying so beats leaving them to guess. Push still works: it sets the
    // upstream on first push.
    mocked.gitAheadBehind.mockRejectedValue(new Error("no upstream"));
    render(<SourceControlPanel {...props} />);
    fireEvent.click(await screen.findByLabelText("Remote actions"));
    expect(await screen.findByTestId("sc-no-upstream")).toHaveTextContent(
      /no upstream/i
    );
  });

  it("leaves the counts off when the branch is level", async () => {
    render(<SourceControlPanel {...props} />);
    fireEvent.click(await screen.findByLabelText("Remote actions"));
    expect(await screen.findByTestId("sc-pull")).toHaveTextContent("Pull");
    expect(screen.getByTestId("sc-pull").textContent).not.toMatch(/\d/);
  });

  it("opens and collapses the commit graph independently of the other sections", async () => {
    render(<SourceControlPanel {...props} />);
    expect(await screen.findByTestId("sc-graph")).toBeDefined();

    fireEvent.click(screen.getByTestId("sc-toggle-graph"));
    expect(screen.queryByTestId("sc-graph")).toBeNull();

    fireEvent.click(screen.getByTestId("sc-toggle-graph"));
    expect(await screen.findByTestId("sc-graph")).toBeDefined();
  });

  it("closing the graph does not touch Staged or Changes — each has its own body", async () => {
    render(<SourceControlPanel {...props} />);
    await screen.findByTestId("sc-graph");
    expect(screen.getAllByTestId("sc-file").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("sc-toggle-graph"));
    expect(screen.queryByTestId("sc-graph")).toBeNull();
    expect(screen.getAllByTestId("sc-file").length).toBeGreaterThan(0);
  });

  it("shows an uncommitted-changes node above HEAD when the tree is dirty", async () => {
    // Every other IDE puts one here — VS Code's GitLens graph and GitKraken
    // both show a working-tree node above HEAD when there's something
    // uncommitted, so the graph reads as the true head of history instead
    // of stopping at the last commit.
    render(<SourceControlPanel {...props} />);
    const node = await screen.findByTestId("sc-uncommitted-row");
    expect(node).toHaveTextContent("Uncommitted changes");
    expect(node).toHaveTextContent("3 files changed");

    fireEvent.click(node);
    expect(props.onSelectWorkingChanges).toHaveBeenCalled();
  });

  it("hides the uncommitted-changes node on a clean tree", async () => {
    mocked.gitStatus.mockResolvedValue([]);
    render(<SourceControlPanel {...props} />);
    await screen.findByTestId("sc-graph");
    expect(screen.queryByTestId("sc-uncommitted-row")).toBeNull();
  });

  it("hides the uncommitted-changes node while filtering — it isn't a commit the filter can match", async () => {
    render(<SourceControlPanel {...props} />);
    await screen.findByTestId("sc-uncommitted-row");

    fireEvent.change(screen.getByLabelText("Filter commit graph"), {
      target: { value: "first" },
    });
    expect(screen.queryByTestId("sc-uncommitted-row")).toBeNull();
  });

  it("only offers Commit when something is staged", async () => {
    mocked.gitStatus.mockResolvedValue([{ path: "b.ts", code: " M" }]);
    render(<SourceControlPanel {...props} />);
    await screen.findByTestId("sc-changes-section");
    fireEvent.change(screen.getByTestId("sc-commit-message"), {
      target: { value: "some message" },
    });
    // A commit with nothing staged commits nothing — the button says so.
    expect(screen.getByTestId("sc-commit")).toBeDisabled();
  });

  // GIT-20/GIT-21: opening a non-git folder as a project made gitStatus and
  // gitLog both reject with the same "not a git repository" error on every
  // reload, and each rejection called onError separately — a burst of
  // identical toasts with no way to stop them. A non-repo project should
  // show one graceful init prompt instead, not a toast at all.
  it("shows a graceful init prompt instead of an error toast for a non-git folder", async () => {
    mocked.gitStatus.mockRejectedValue(
      new Error("git status --porcelain=v1 -uall failed: fatal: not a git repository (or any of the parent directories): .git")
    );
    mocked.gitLog.mockRejectedValue(new Error("fatal: not a git repository"));
    mocked.gitAheadBehind.mockRejectedValue(new Error("fatal: not a git repository"));

    render(<SourceControlPanel {...props} />);

    await screen.findByTestId("sc-not-a-repo");
    expect(props.onError).not.toHaveBeenCalled();
  });

  it("initializes the repo from the prompt and reloads status", async () => {
    mocked.gitStatus
      .mockRejectedValueOnce(new Error("fatal: not a git repository"))
      .mockResolvedValueOnce([]);
    mocked.gitLog.mockRejectedValue(new Error("fatal: not a git repository"));
    mocked.gitAheadBehind.mockRejectedValue(new Error("fatal: not a git repository"));
    mocked.gitInit = vi.fn().mockResolvedValue(undefined);

    render(<SourceControlPanel {...props} />);
    await screen.findByTestId("sc-not-a-repo");

    fireEvent.click(screen.getByTestId("sc-git-init"));

    await waitFor(() => expect(mocked.gitInit).toHaveBeenCalledWith("p1"));
    await waitFor(() =>
      expect(screen.queryByTestId("sc-not-a-repo")).toBeNull()
    );
  });
});



// Amendment 7: status chips are single letters colored from the existing
// semantic tokens, and always carry the letter — color is never the only
// signal. The porcelain-code mapping is a branch, so it gets a test.

describe("statusChip", () => {
  it("maps an untracked file to U on the success tone", () => {
    expect(statusChip("??")).toEqual({ letter: "U", tone: "success" });
  });

  it("maps an added file to A on the success tone", () => {
    expect(statusChip("A ")).toEqual({ letter: "A", tone: "success" });
  });

  it("maps a deleted file to D", () => {
    expect(statusChip(" D")).toEqual({ letter: "D", tone: "bad" });
  });

  it("maps a modified file to M on the warn tone", () => {
    expect(statusChip(" M")).toEqual({ letter: "M", tone: "warn" });
  });

  it("falls back to M for any other code rather than rendering a blank chip", () => {
    expect(statusChip("RM").letter).toBe("M");
  });
});

describe("splitPath", () => {
  it("splits a nested path into filename and directory", () => {
    expect(splitPath("src-tauri/src/lsp.rs")).toEqual({
      name: "lsp.rs",
      dir: "src-tauri/src",
    });
  });

  it("leaves a root-level file with an empty directory line", () => {
    expect(splitPath("README.md")).toEqual({ name: "README.md", dir: "" });
  });
});

describe("layoutGraph", () => {
  // These three cover the fixture the row-seam fix depends on: a straight
  // run, a branch opening a new lane, and a merge closing one — every shape
  // .ds-sc-commit's 24px row height has to render without a gap.
  it("keeps a straight run of commits in the same lane", () => {
    const rows = layoutGraph([
      { hash: "c3", parents: ["c2"], subject: "third", author: "T", date: "", refs: [] },
      { hash: "c2", parents: ["c1"], subject: "second", author: "T", date: "", refs: [] },
      { hash: "c1", parents: [], subject: "first", author: "T", date: "", refs: [] },
    ]);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows.map((row) => row.edges)).toEqual([
      [{ from: 0, to: 0, lane: 0, color: 0 }],
      [{ from: 0, to: 0, lane: 0, color: 0 }],
      [],
    ]);
  });

  it("opens a new lane for a second, unrelated branch tip", () => {
    // `git log --all --topo-order` interleaves independent histories —
    // "feature" here shares no ancestry with "main" and is not yet in any
    // lane when its row is reached, so it can't reuse main's (still-open)
    // lane.
    const rows = layoutGraph([
      { hash: "main", parents: ["main-parent"], subject: "main tip", author: "T", date: "", refs: [] },
      { hash: "feature", parents: ["feature-parent"], subject: "feature tip", author: "T", date: "", refs: ["feature/x"] },
    ]);
    expect(rows[0].lane).toBe(0);
    expect(rows[1].lane).toBe(1);
  });

  it("keeps a merge's parents in separate lanes", () => {
    const rows = layoutGraph([
      { hash: "merge", parents: ["main", "feature"], subject: "merge", author: "T", date: "", refs: [] },
    ]);
    expect(rows[0]).toMatchObject({
      lane: 0,
      beforeLanes: ["merge"],
      nextLanes: ["main", "feature"],
      edges: [
        { from: 0, to: 0, lane: 0, color: 0 },
        { from: 0, to: 1, lane: 0, color: 1 },
      ],
    });
  });
});

describe("a commit row shows the whole commit", () => {
  // Measured live before this changed: the graph rendered 103 overflowing
  // elements — 340 by the time the branch had a long name — with an 89-char
  // subject showing 91px of 469 and a branch badge showing 6px of 87. The
  // detail that made it a defect rather than a density choice is that the
  // ellipsis happened inside the content box, so the panel's own overflow-x
  // had nothing to scroll to. The text was unreachable, not merely clipped.
  const EIGHTY = "fix: make the source control graph show an entire commit subject at last";
  const LONG_REF = "origin/claude/impeccable-critique-agent-chain-0bf99b";

  beforeEach(() => {
    mocked.gitStatus.mockResolvedValue([]);
    mocked.gitGraph.mockResolvedValue([
      { hash: "c2", parents: ["c1"], subject: EIGHTY, author: "TJLSmith0831", date: "2026-09-11", refs: [LONG_REF, "origin/main"] },
      { hash: "c1", parents: [], subject: "short one", author: "TJLSmith0831", date: "2026-09-10", refs: [] },
    ]);
  });

  it("gives an 80-character subject enough lines to render whole", async () => {
    render(<SourceControlPanel {...props} />);
    await screen.findByText(EIGHTY);
    // Four lines at the measured 25 characters a line covers 100 characters.
    expect(subjectLines(EIGHTY)).toBe(3);
    expect(subjectLines(EIGHTY) * 25).toBeGreaterThanOrEqual(EIGHTY.length);
    // The row is tall enough to hold those lines plus its metadata and both
    // ref badges — and nothing is asked to share a line with the subject.
    expect(commitRowHeight(EIGHTY, 2)).toBe(15 * 3 + 14 + 16 * 2);
  });

  it("keeps the half of a branch name that tells two branches apart", () => {
    // origin/claude/…-0bf99b and origin/claude/…-0bf9aa differ only at the
    // end, which is precisely what an ordinary end-ellipsis would eat.
    const shortened = shortRef(LONG_REF);
    expect(shortened.startsWith("…")).toBe(true);
    expect(LONG_REF.endsWith(shortened.slice(1))).toBe(true);
    expect(shortRef("origin/main")).toBe("origin/main");
    expect(shortRef("origin/claude/foo")).not.toBe(shortRef("origin/claude/bar"));
  });

  it("renders one badge per ref rather than one badge holding them all", async () => {
    render(<SourceControlPanel {...props} />);
    await screen.findByText(EIGHTY);
    // Joined into a single nowrap string, four refs on one commit measured
    // 699px inside a 138px row and none of them was readable.
    expect(screen.getByText(shortRef(LONG_REF))).toBeDefined();
    expect(screen.getByText("origin/main")).toBeDefined();
  });

  it("sizes each lane SVG to its own row so the graph still joins up", async () => {
    render(<SourceControlPanel {...props} />);
    await screen.findByText(EIGHTY);
    const lanes = screen.getAllByTestId("sc-graph-lane");
    const rows = screen.getAllByTestId("sc-commit-row");
    // The lane SVG has to be exactly as tall as its row or adjacent rows'
    // paths meet with a seam — the reason row height is computed rather than
    // measured.
    rows.forEach((row, i) => {
      expect(lanes[i].getAttribute("height")).toBe(String(parseInt(row.style.height, 10)));
    });
    expect(parseInt(rows[0].style.height, 10)).toBe(commitRowHeight(EIGHTY, 2));
    expect(parseInt(rows[1].style.height, 10)).toBe(commitRowHeight("short one", 0));
  });
});

// The graph asked for a flat 80 commits and said nothing about it, so a
// repository with five thousand commits was indistinguishable from a shallow
// clone: the list just stopped.
describe("the graph says how much history it is showing", () => {
  const page = (n: number, offset = 0) =>
    Array.from({ length: n }, (_, i) => ({
      hash: `h${offset + i}`,
      parents: offset + i + 1 < offset + n ? [`h${offset + i + 1}`] : [],
      subject: `commit ${offset + i}`,
      author: "T",
      date: "2026-09-11",
      refs: [],
    }));

  it("offers more while the page came back full", async () => {
    mocked.gitStatus.mockResolvedValue([]);
    mocked.gitGraph.mockResolvedValue(page(80));
    render(<SourceControlPanel {...props} />);

    await screen.findByTestId("sc-graph-load-more");
    expect(screen.getByTestId("sc-graph-footer").textContent).toContain("80 commits");

    mocked.gitGraph.mockResolvedValue(page(120));
    fireEvent.click(screen.getByTestId("sc-graph-load-more"));

    await waitFor(() => expect(mocked.gitGraph).toHaveBeenCalledWith("p1", 160));
    await waitFor(() =>
      expect(screen.getByTestId("sc-graph-footer").textContent).toContain("120 commits")
    );
  });

  it("says so, and stops offering, once the whole history is in", async () => {
    mocked.gitStatus.mockResolvedValue([]);
    mocked.gitGraph.mockResolvedValue(page(12));
    render(<SourceControlPanel {...props} />);

    await waitFor(() =>
      expect(screen.getByTestId("sc-graph-footer").textContent).toContain("all of them")
    );
    expect(screen.queryByTestId("sc-graph-load-more")).toBeNull();
  });
});

it("does not label a graphic it also hides from the reader", async () => {
  mocked.gitStatus.mockResolvedValue([]);
  mocked.gitGraph.mockResolvedValue([
    { hash: "c1", parents: [], subject: "only", author: "T", date: "2026-09-11", refs: [] },
  ]);
  render(<SourceControlPanel {...props} />);
  await screen.findByText("only");
  // aria-hidden wins when both sit on the same element, so the aria-label was
  // dead. The lanes are decoration — the commit row beside them already
  // carries the commit's accessible name.
  const lane = screen.getAllByTestId("sc-graph-lane")[0];
  expect(lane.getAttribute("aria-hidden")).toBe("true");
  expect(lane.getAttribute("aria-label")).toBeNull();
  expect(screen.getAllByTestId("sc-commit-row")[0].getAttribute("aria-label")).toContain("only");
});
