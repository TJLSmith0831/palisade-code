import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const { createThread, setThreadWorktreeEnabled } = vi.hoisted(() => ({
  createThread: vi.fn(),
  setThreadWorktreeEnabled: vi.fn(),
}));
vi.mock("../api", () => ({ createThread, setThreadWorktreeEnabled }));

import { resolvePrefs, setThreadPrefs, useThreadPrefs } from "../hooks/useThreadPrefs";

describe("useThreadPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
    createThread.mockReset();
    setThreadWorktreeEnabled.mockReset();
  });

  // D6: no global default that one thread's toggle could silently promote for
  // every other thread.
  it("starts every never-configured thread in Accept mode", () => {
    expect(resolvePrefs("h", "t1")).toEqual({ bypass: false });
  });

  it("remembers a thread's mode separately from its neighbours", () => {
    setThreadPrefs("h", "t1", { bypass: true });
    expect(resolvePrefs("h", "t1")).toEqual({ bypass: true });
    expect(resolvePrefs("h", "t2")).toEqual({ bypass: false });
    expect(resolvePrefs("other", "t1")).toEqual({ bypass: false });
  });

  it("falls back to Accept on stored junk rather than throwing", () => {
    localStorage.setItem("palisade:thread-prefs:h:t1", "{not json");
    expect(resolvePrefs("h", "t1")).toEqual({ bypass: false });
    localStorage.setItem("palisade:thread-prefs:h:t1", '{"bypass":"yes"}');
    expect(resolvePrefs("h", "t1")).toEqual({ bypass: false });
  });

  it("toggles and stores in one step", () => {
    const { result } = renderHook(() => useThreadPrefs());
    expect(result.current.threadPrefs.bypass).toBe(false);
    act(() => result.current.toggleBypass("h", "t1"));
    expect(result.current.threadPrefs.bypass).toBe(true);
    expect(resolvePrefs("h", "t1")).toEqual({ bypass: true });
  });

  it("adopts whatever the thread being switched to had stored", () => {
    setThreadPrefs("h", "t2", { bypass: true });
    const { result } = renderHook(() => useThreadPrefs());
    act(() => result.current.loadFor("h", "t2"));
    expect(result.current.threadPrefs.bypass).toBe(true);
    act(() => result.current.loadFor("h", "t3"));
    expect(result.current.threadPrefs.bypass).toBe(false);
  });

  // The composer can offer the worktree choice before a thread exists, so the
  // choice has to survive until one does.
  it("applies a worktree choice made before the thread existed", async () => {
    createThread.mockResolvedValue({ id: "t1" });
    setThreadWorktreeEnabled.mockResolvedValue({ id: "t1", worktreeEnabled: false });
    const { result } = renderHook(() => useThreadPrefs());

    act(() => result.current.setPendingWorktreeEnabled(false));
    await act(async () => { await result.current.createThreadWithPrefs("h"); });

    expect(setThreadWorktreeEnabled).toHaveBeenCalledWith("h", "t1", false);
  });

  it("leaves isolation alone when it was never turned off", async () => {
    createThread.mockResolvedValue({ id: "t1" });
    const { result } = renderHook(() => useThreadPrefs());
    await act(async () => { await result.current.createThreadWithPrefs("h"); });
    expect(setThreadWorktreeEnabled).not.toHaveBeenCalled();
  });

  it("still returns the thread when a non-git project has no isolation to turn off", async () => {
    createThread.mockResolvedValue({ id: "t1" });
    setThreadWorktreeEnabled.mockRejectedValue(new Error("not a git repository"));
    const { result } = renderHook(() => useThreadPrefs());

    act(() => result.current.setPendingWorktreeEnabled(false));
    let created: unknown;
    await act(async () => { created = await result.current.createThreadWithPrefs("h"); });

    expect(created).toEqual({ id: "t1" });
  });
});
