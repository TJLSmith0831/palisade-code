import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import MergeGate, { hasWorkToLand } from "../MergeGate";
import type { WorktreeStatus } from "../api";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../api", async () => ({
  ...(await vi.importActual<typeof import("../api")>("../api")),
  gitStatus: vi.fn().mockResolvedValue([{ path: "a.rs", code: " M" }]),
  gitStageFile: vi.fn().mockResolvedValue(undefined),
  gitCommit: vi.fn().mockResolvedValue(undefined),
  suggestCommitMessage: vi.fn().mockResolvedValue("Add retry helper"),
  draftCommitMessage: vi.fn().mockResolvedValue("feat: a much better message"),
  mergeThreadWorktree: vi.fn().mockResolvedValue({
    merged: true,
    conflictPath: null,
    conflictBranch: null,
    detail: "",
  }),
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
  baseState: "clean",
  baseChangeCount: null,
  ahead: 2,
  clean: true,
  mergeable: true,
  state: "ahead",
  head: "cafe1234",
  ...over,
});

const dirty = worktree({ clean: false, ahead: 0, added: 23, removed: 0 });

const mount = (w: WorktreeStatus, props: Record<string, unknown> = {}) =>
  render(
    <MergeGate
      projectHash="p"
      threadId="t1"
      worktree={w}
      verify={{ state: "pass", commit: w.head ?? undefined }}
      onChanged={vi.fn()}
      onError={vi.fn()}
      {...props}
    />,
  );

const expand = () => fireEvent.click(screen.getByTestId("merge-gate-toggle"));

beforeEach(() => vi.clearAllMocks());

describe("hasWorkToLand", () => {
  it("counts commits the base lacks", () => {
    expect(hasWorkToLand(worktree({ ahead: 1, clean: true }))).toBe(true);
  });

  // The case that used to dead-end: an agent's edits are work to land even
  // though nothing is committed yet.
  it("counts uncommitted agent edits", () => {
    expect(hasWorkToLand(dirty)).toBe(true);
  });

  it("is false for a thread that changed nothing", () => {
    expect(hasWorkToLand(worktree({ ahead: 0, clean: true }))).toBe(false);
  });
});

describe("MergeGate", () => {
  it("shows the mergeability check", () => {
    mount(worktree());
    expand();
    expect(screen.getByTestId("gate-check-mergeable")).toHaveTextContent(
      "Merges cleanly into main",
    );
    expect(screen.queryByTestId("gate-check-verify")).toBeNull();
  });

  it("blocks merging without current verification", () => {
    mount(worktree(), { verify: { state: "not_run" } });
    expand();
    expect(screen.getByTestId("merge-thread")).toBeDisabled();
  });

  it("requires an explicit commit for uncommitted agent work", () => {
    mount(dirty);
    expand();
    expect(screen.getByTestId("commit-thread-changes")).toBeDisabled();
    expect(screen.getByTestId("merge-thread")).toBeDisabled();
    expect(screen.getByTestId("open-thread-pr")).toBeDisabled();
  });

  it("blocks the merge on a conflict, a dirty base, or an empty thread", () => {
    mount(worktree({ mergeable: false, state: "conflict" }));
    expand();
    expect(screen.getByTestId("merge-thread")).toBeDisabled();

    mount(worktree({ ahead: 0, clean: true }));
    expect(screen.getAllByTestId("merge-thread")[1]).toBeDisabled();

    mount(worktree({ baseState: "dirty", baseChangeCount: 14 }));
    fireEvent.click(screen.getAllByTestId("merge-gate-toggle")[2]);
    expect(screen.getAllByTestId("gate-check-mergeable")[2]).toHaveTextContent(
      "main has 14 uncommitted changes"
    );
    expect(screen.getAllByTestId("merge-thread")[2]).toBeDisabled();
    expect(screen.getAllByTestId("open-thread-pr")[2]).not.toBeDisabled();
  });

  it("blocks only the local merge when the target safety check is unavailable", () => {
    mount(worktree({ baseState: "unavailable", baseChangeCount: null }));
    expand();

    expect(screen.getByTestId("gate-check-mergeable")).toHaveTextContent(
      "Cannot check whether main is safe to update",
    );
    expect(screen.getByTestId("merge-thread")).toBeDisabled();
    expect(screen.getByTestId("open-thread-pr")).not.toBeDisabled();
  });

  it("pre-fills the commit message from the local model", async () => {
    mount(dirty);
    expand();
    await waitFor(() =>
      expect(screen.getByTestId("gate-commit-message")).toHaveValue("Add retry helper"),
    );
    expect(api.suggestCommitMessage).toHaveBeenCalledWith("p", "t1");
  });

  it("leaves the box empty when no local model answers", async () => {
    vi.mocked(api.suggestCommitMessage).mockResolvedValueOnce("");
    mount(dirty);
    expand();
    await waitFor(() => expect(api.suggestCommitMessage).toHaveBeenCalled());
    expect(screen.getByTestId("gate-commit-message")).toHaveValue("");
  });

  it("upgrades the message on demand via the thread's agent", async () => {
    mount(dirty);
    expand();
    fireEvent.click(screen.getByTestId("gate-generate-message"));
    await waitFor(() =>
      expect(screen.getByTestId("gate-commit-message")).toHaveValue(
        "feat: a much better message",
      ),
    );
  });

  it("commits explicitly, refreshes, and never makes Merge commit again", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    mount(dirty, { onChanged });
    expand();
    await waitFor(() =>
      expect(screen.getByTestId("gate-commit-message")).toHaveValue("Add retry helper"),
    );
    fireEvent.click(screen.getByTestId("commit-thread-changes"));
    await waitFor(() =>
      expect(api.gitCommit).toHaveBeenCalledWith("p", "Add retry helper", "t1"),
    );
    expect(api.gitStageFile).toHaveBeenCalledWith("p", "a.rs", "t1");
    expect(api.mergeThreadWorktree).not.toHaveBeenCalled();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("offers to archive the thread once the work has landed", async () => {
    const onArchive = vi.fn();
    mount(worktree(), { onArchive });
    expand();
    fireEvent.click(screen.getByTestId("merge-thread"));
    const archive = await screen.findByTestId("merge-gate-archive");
    fireEvent.click(archive);
    expect(onArchive).toHaveBeenCalled();
  });

  it("names the worktree a conflicted merge was parked in", async () => {
    const onError = vi.fn();
    vi.mocked(api.mergeThreadWorktree).mockResolvedValueOnce({
      merged: false,
      conflictPath: "/repo/.git/palisade-worktrees/merge-abcd1234",
      conflictBranch: "palisade/merge-abcd1234",
      detail: "CONFLICT",
    });
    mount(worktree(), { onError });
    expand();
    fireEvent.click(screen.getByTestId("merge-thread"));
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining("/repo/.git/palisade-worktrees/merge-abcd1234"),
      ),
    );
  });

  it("opens a PR without trying to commit a clean thread again", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    mount(worktree());
    expand();
    fireEvent.click(screen.getByTestId("open-thread-pr"));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.test/pr/1"));
    expect(api.gitCommit).not.toHaveBeenCalled();
  });
});
