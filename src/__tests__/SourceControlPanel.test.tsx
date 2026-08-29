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
import SourceControlPanel, { isStaged, statusChip, splitPath } from "../SourceControlPanel";
import * as api from "../api";

vi.mock("../api", () => ({
  gitAheadBehind: vi.fn(),
  gitStatus: vi.fn(),
  gitLog: vi.fn(),
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
    fireEvent.click(await screen.findByLabelText("More actions"));
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
    fireEvent.click(await screen.findByLabelText("More actions"));
    expect(await screen.findByTestId("sc-no-upstream")).toHaveTextContent(
      /no upstream/i
    );
  });

  it("leaves the counts off when the branch is level", async () => {
    render(<SourceControlPanel {...props} />);
    fireEvent.click(await screen.findByLabelText("More actions"));
    expect(await screen.findByTestId("sc-pull")).toHaveTextContent("Pull");
    expect(screen.getByTestId("sc-pull").textContent).not.toMatch(/\d/);
  });

  it("collapses the commit graph too", async () => {
    render(<SourceControlPanel {...props} />);
    await screen.findByTestId("sc-graph");
    fireEvent.click(screen.getByTestId("sc-toggle-graph"));
    expect(screen.queryByTestId("sc-graph")).toBeNull();
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
