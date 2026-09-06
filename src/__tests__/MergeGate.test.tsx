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
  // Only one question is asked, and it is about the merge — no test result
  // gates the button, and none is displayed as if it did.
  it("checks mergeability and nothing else", () => {
    mount(worktree());
    expand();
    expect(screen.getByTestId("gate-check-mergeable")).toHaveTextContent(
      "Merges cleanly into main",
    );
    expect(screen.queryByTestId("gate-check-verify")).toBeNull();
  });

  it("offers Merge on uncommitted agent work", () => {
    mount(dirty);
    expand();
    expect(screen.getByTestId("merge-thread")).not.toBeDisabled();
  });

  it("blocks the merge only on a conflict or an empty thread", () => {
    mount(worktree({ mergeable: false, state: "conflict" }));
    expand();
    expect(screen.getByTestId("merge-thread")).toBeDisabled();

    mount(worktree({ ahead: 0, clean: true }));
    expect(screen.getAllByTestId("merge-thread")[1]).toBeDisabled();
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

  it("commits what is uncommitted on the way through the merge", async () => {
    mount(dirty);
    expand();
    await waitFor(() =>
      expect(screen.getByTestId("gate-commit-message")).toHaveValue("Add retry helper"),
    );
    fireEvent.click(screen.getByTestId("merge-thread"));
    await waitFor(() =>
      expect(api.gitCommit).toHaveBeenCalledWith("p", "Add retry helper", "t1"),
    );
    expect(api.gitStageFile).toHaveBeenCalledWith("p", "a.rs", "t1");
    expect(api.mergeThreadWorktree).toHaveBeenCalledWith("p", "t1");
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

  it("commits before opening a PR, then opens the url", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    mount(dirty);
    expand();
    fireEvent.click(screen.getByTestId("open-thread-pr"));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://example.test/pr/1"));
    expect(api.gitCommit).toHaveBeenCalled();
  });
});
