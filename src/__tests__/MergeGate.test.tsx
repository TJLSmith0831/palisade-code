import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import MergeGate, { verifyAtHead } from "../MergeGate";
import type { VerificationRun, WorktreeStatus } from "../api";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../api", async () => ({
  ...(await vi.importActual<typeof import("../api")>("../api")),
  gitStatus: vi.fn().mockResolvedValue([{ path: "a.rs", code: " M" }]),
  gitStageFile: vi.fn().mockResolvedValue(undefined),
  gitCommit: vi.fn().mockResolvedValue(undefined),
  draftCommitMessage: vi.fn().mockResolvedValue("drafted"),
  mergeThreadWorktree: vi.fn(),
  openThreadPr: vi.fn().mockResolvedValue("https://example.test/pr/1"),
}));

import * as api from "../api";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

const worktree = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  threadId: "t1",
  branch: "palisade/abcd1234",
  added: 0,
  removed: 0,
  baseBranch: "main",
  ahead: 2,
  clean: true,
  mergeable: true,
  state: "ahead",
  head: "cafe1234",
  ...over,
});

const run = (over: Partial<VerificationRun> = {}): VerificationRun =>
  ({
    id: "v1",
    projectHash: "p",
    threadId: "t1",
    sessionId: null,
    name: "test",
    command: "cargo test",
    exitCode: 0,
    outputTail: "",
    gitHead: "cafe1234",
    at: "2026-09-06T00:00:00Z",
    tests: null,
    ...over,
  }) as VerificationRun;

const mount = (w: WorktreeStatus, runs: VerificationRun[] = []) =>
  render(
    <MergeGate
      projectHash="p"
      threadId="t1"
      worktree={w}
      verifications={runs}
      onChanged={vi.fn()}
      onError={vi.fn()}
    />,
  );

beforeEach(() => vi.clearAllMocks());

describe("verifyAtHead", () => {
  // The whole point of the record: a run is evidence about the commit it ran
  // at, and nothing else. A run at an older commit must not read as a pass.
  it("ignores a run from a different commit", () => {
    expect(verifyAtHead([run({ gitHead: "older" })], "t1", "cafe1234")).toBeNull();
  });

  it("ignores a run from a different thread", () => {
    expect(verifyAtHead([run({ threadId: "t2" })], "t1", "cafe1234")).toBeNull();
  });

  it("takes the newest run at this commit", () => {
    const runs = [run({ id: "old", exitCode: 1 }), run({ id: "new" })];
    expect(verifyAtHead(runs, "t1", "cafe1234")?.id).toBe("new");
  });
});

describe("MergeGate", () => {
  it("merges only when the tree is clean, the merge is clean, and there is something to land", async () => {
    mount(worktree());
    fireEvent.click(screen.getByTestId("merge-gate-toggle"));
    expect(screen.getByTestId("merge-thread")).not.toBeDisabled();

    // Uncommitted work would land less than the user reviewed.
    mount(worktree({ clean: false, added: 4, removed: 1 }));
    expect(screen.getAllByTestId("merge-thread")[1]).toBeDisabled();
  });

  it("blocks the merge when the branch conflicts with its base", () => {
    mount(worktree({ mergeable: false, state: "conflict" }));
    fireEvent.click(screen.getByTestId("merge-gate-toggle"));
    expect(screen.getByTestId("merge-thread")).toBeDisabled();
  });

  // A failed or missing verify run is reported, never used as a gate: it says
  // something about the code, not about whether the branch merges cleanly.
  it("reports a missing verify run without blocking the merge", () => {
    mount(worktree(), []);
    fireEvent.click(screen.getByTestId("merge-gate-toggle"));
    expect(screen.getByTestId("gate-check-verify")).toHaveTextContent("not run at this commit");
    expect(screen.getByTestId("merge-thread")).not.toBeDisabled();
  });

  it("offers the commit row only while the tree is dirty, and stages before committing", async () => {
    mount(worktree({ clean: true }));
    fireEvent.click(screen.getByTestId("merge-gate-toggle"));
    expect(screen.queryByTestId("gate-commit-row")).toBeNull();

    mount(worktree({ clean: false, added: 3, removed: 0 }));
    const message = screen.getByTestId("gate-commit-message");
    fireEvent.change(message, { target: { value: "thread work" } });
    fireEvent.click(screen.getByTestId("gate-commit"));

    await waitFor(() => expect(api.gitCommit).toHaveBeenCalledWith("p", "thread work", "t1"));
    expect(api.gitStageFile).toHaveBeenCalledWith("p", "a.rs", "t1");
  });

  it("opens the PR url the backend hands back", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    mount(worktree());
    fireEvent.click(screen.getByTestId("merge-gate-toggle"));
    fireEvent.click(screen.getByTestId("open-thread-pr"));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.test/pr/1"));
  });

  it("names the worktree a conflicted merge was parked in", async () => {
    const onError = vi.fn();
    vi.mocked(api.mergeThreadWorktree).mockResolvedValue({
      merged: false,
      conflictPath: "/repo/.git/palisade-worktrees/merge-abcd1234",
      conflictBranch: "palisade/merge-abcd1234",
      detail: "CONFLICT",
    });
    render(
      <MergeGate
        projectHash="p"
        threadId="t1"
        worktree={worktree()}
        verifications={[]}
        onError={onError}
      />,
    );
    fireEvent.click(screen.getByTestId("merge-gate-toggle"));
    fireEvent.click(screen.getByTestId("merge-thread"));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining("/repo/.git/palisade-worktrees/merge-abcd1234"),
      ),
    );
  });
});
