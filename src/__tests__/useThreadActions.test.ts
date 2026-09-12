import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const api = vi.hoisted(() => ({
  renameThread: vi.fn(),
  listThreads: vi.fn(),
  deleteThread: vi.fn(),
  pruneThreadWorktree: vi.fn(),
}));
vi.mock("../api", () => api);

import { useThreadActions } from "../hooks/useThreadActions";

const thread = (over: Partial<Record<string, unknown>> = {}) =>
  ({ id: "t1", title: "A thread", archived: false, ...over }) as never;

const setup = (over: Record<string, unknown> = {}) => {
  const bars: unknown[] = [];
  const deps = {
    projectHash: "h",
    activeThread: thread(),
    setThread: vi.fn(),
    setThreads: vi.fn(),
    setBar: vi.fn((b: unknown) => bars.push(b)),
    fail: vi.fn(),
    worktrees: new Map(),
    loadWorktrees: vi.fn(),
    setThreadArchived: vi.fn().mockResolvedValue(undefined),
    selectThread: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  const { result } = renderHook(() => useThreadActions(deps as never));
  return { result, deps, bars };
};

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.listThreads.mockResolvedValue([]);
});

describe("useThreadActions", () => {
  it("does nothing at all without a project", () => {
    const { result, deps } = setup({ projectHash: null });
    act(() => result.current.onDeleteThread(thread()));
    expect(deps.setBar).not.toHaveBeenCalled();
  });

  it("renames through the command bar, not a window.prompt", async () => {
    // window.prompt returns null without showing anything in Tauri's
    // WKWebView, which is why the app has a bar of its own.
    const { result, deps, bars } = setup();
    api.renameThread.mockResolvedValue(thread({ title: "Renamed" }));
    act(() => result.current.onRenameThread(thread()));

    const bar = bars[0] as { kind: string; value: string; submit: (v: string) => Promise<void> };
    expect(bar.kind).toBe("input");
    expect(bar.value).toBe("A thread");
    await act(async () => { await bar.submit("Renamed"); });

    expect(api.renameThread).toHaveBeenCalledWith("h", "t1", "Renamed");
    // It was the open thread, so what is on screen follows the rename.
    expect(deps.setThread).toHaveBeenCalled();
  });

  it("leaves the open thread alone when renaming a different one", async () => {
    const { result, deps, bars } = setup({ activeThread: thread({ id: "other" }) });
    api.renameThread.mockResolvedValue(thread({ title: "Renamed" }));
    act(() => result.current.onRenameThread(thread()));
    await act(async () => { await (bars[0] as never as { submit: (v: string) => Promise<void> }).submit("Renamed"); });
    expect(deps.setThread).not.toHaveBeenCalled();
  });

  // Archiving is reversible and must stay that way: it never discards work on
  // its own. Unmerged work is the one case the user has to answer for.
  it("archives silently when the worktree has nothing the base branch lacks", async () => {
    const worktrees = new Map([["t1", { clean: true, ahead: 0, baseBranch: "main" }]]);
    const { result, deps } = setup({ worktrees });
    await act(async () => { result.current.onArchiveThread(thread()); });
    expect(deps.setThreadArchived).toHaveBeenCalledWith("h", "t1", true);
    expect(deps.setBar).not.toHaveBeenCalled();
  });

  it("asks before destroying unmerged work", async () => {
    const worktrees = new Map([["t1", { clean: false, ahead: 2, baseBranch: "main" }]]);
    const { result, deps, bars } = setup({ worktrees });
    await act(async () => { result.current.onArchiveThread(thread()); });

    const bar = bars[0] as { kind: string; label: string; onConfirm: () => Promise<void> };
    expect(bar.kind).toBe("confirm");
    expect(bar.label).toContain("main");
    // Nothing is pruned until the user says so.
    expect(api.pruneThreadWorktree).not.toHaveBeenCalled();
    await act(async () => { await bar.onConfirm(); });
    expect(api.pruneThreadWorktree).toHaveBeenCalledWith("h", "t1", true);
    expect(deps.loadWorktrees).toHaveBeenCalled();
  });

  it("never asks about unmerged work when un-archiving", async () => {
    const worktrees = new Map([["t1", { clean: false, ahead: 5, baseBranch: "main" }]]);
    const { result, deps } = setup({ worktrees });
    await act(async () => { result.current.onArchiveThread(thread({ archived: true })); });
    expect(deps.setThreadArchived).toHaveBeenCalledWith("h", "t1", false);
    expect(deps.setBar).not.toHaveBeenCalled();
  });

  // D22: reselect only if the deleted thread was the open one.
  it("opens the next thread when the deleted one was on screen", async () => {
    const { result, deps, bars } = setup();
    api.listThreads.mockResolvedValue([thread({ id: "t2" })]);
    act(() => result.current.onDeleteThread(thread()));
    await act(async () => { await (bars[0] as never as { onConfirm: () => Promise<void> }).onConfirm(); });

    expect(api.deleteThread).toHaveBeenCalledWith("h", "t1");
    expect(deps.selectThread).toHaveBeenCalledWith("h", expect.objectContaining({ id: "t2" }));
  });

  it("stays where it is when the deleted thread was not the open one", async () => {
    const { result, deps, bars } = setup({ activeThread: thread({ id: "other" }) });
    act(() => result.current.onDeleteThread(thread()));
    await act(async () => { await (bars[0] as never as { onConfirm: () => Promise<void> }).onConfirm(); });
    expect(deps.selectThread).not.toHaveBeenCalled();
  });

  it("reports a failed delete instead of swallowing it", async () => {
    const { result, deps, bars } = setup();
    api.deleteThread.mockRejectedValue({ kind: "unknown", message: "busy" });
    act(() => result.current.onDeleteThread(thread()));
    await act(async () => { await (bars[0] as never as { onConfirm: () => Promise<void> }).onConfirm(); });
    expect(deps.fail).toHaveBeenCalled();
  });
});
