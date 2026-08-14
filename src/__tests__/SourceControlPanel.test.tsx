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
  gitStatus: vi.fn(),
  gitLog: vi.fn(),
  gitStageFile: vi.fn(),
  gitUnstageFile: vi.fn(),
  gitCommit: vi.fn(),
  gitFetch: vi.fn(),
  gitPull: vi.fn(),
  gitPush: vi.fn(),
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

  it("stages one file", async () => {
    render(<SourceControlPanel {...props} />);
    fireEvent.click(await screen.findByTestId("sc-stage-src/b.ts"));
    await waitFor(() =>
      expect(mocked.gitStageFile).toHaveBeenCalledWith("p1", "src/b.ts")
    );
  });

  it("unstages one file", async () => {
    render(<SourceControlPanel {...props} />);
    fireEvent.click(await screen.findByTestId("sc-unstage-src/a.ts"));
    await waitFor(() =>
      expect(mocked.gitUnstageFile).toHaveBeenCalledWith("p1", "src/a.ts")
    );
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
