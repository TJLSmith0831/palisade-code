import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTIFY_TURN_DONE_KEY,
  loadNotifyTurnDone,
  notifyTurnDone,
  saveNotifyTurnDone,
  turnNotification,
} from "../turnNotifications";

beforeEach(() => {
  localStorage.clear();
});

describe("turnNotification", () => {
  it("names the thread and says what happened", () => {
    expect(turnNotification("Fix the merge gate", "done")).toEqual({
      title: "Fix the merge gate",
      body: "Turn finished — ready to review.",
    });
    expect(turnNotification("Fix the merge gate", "crashed")).toEqual({
      title: "Fix the merge gate",
      body: "The agent crashed. Open the thread to retry.",
    });
  });

  it("falls back to a generic title for an untitled thread", () => {
    expect(turnNotification("", "done").title).toBe("A thread finished");
  });
});

describe("notifyTurnDone", () => {
  const deps = () => ({
    isPermissionGranted: vi.fn().mockResolvedValue(true),
    requestPermission: vi.fn().mockResolvedValue("granted" as const),
    send: vi.fn(),
  });

  it("sends when the window is not focused and the setting is on", async () => {
    const d = deps();
    const sent = await notifyTurnDone({ threadTitle: "t", kind: "done", focused: false }, d);
    expect(sent).toBe(true);
    expect(d.send).toHaveBeenCalledWith({ title: "t", body: "Turn finished — ready to review." });
  });

  it("stays silent while the user is looking at the app", async () => {
    const d = deps();
    expect(await notifyTurnDone({ threadTitle: "t", kind: "done", focused: true }, d)).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
    expect(d.isPermissionGranted).not.toHaveBeenCalled();
  });

  it("stays silent when the setting is off", async () => {
    saveNotifyTurnDone(false);
    const d = deps();
    expect(await notifyTurnDone({ threadTitle: "t", kind: "done", focused: false }, d)).toBe(false);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("asks for permission once and respects a refusal", async () => {
    const d = deps();
    d.isPermissionGranted.mockResolvedValue(false);
    d.requestPermission.mockResolvedValue("denied");
    expect(await notifyTurnDone({ threadTitle: "t", kind: "done", focused: false }, d)).toBe(false);
    expect(d.requestPermission).toHaveBeenCalledTimes(1);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("never throws into the event handler when the platform refuses", async () => {
    const d = deps();
    d.send.mockImplementation(() => {
      throw new Error("no notification center");
    });
    await expect(
      notifyTurnDone({ threadTitle: "t", kind: "done", focused: false }, d)
    ).resolves.toBe(false);
  });
});

describe("the setting", () => {
  it("is on by default and persists a change", () => {
    expect(loadNotifyTurnDone()).toBe(true);
    saveNotifyTurnDone(false);
    expect(localStorage.getItem(NOTIFY_TURN_DONE_KEY)).toBe("0");
    expect(loadNotifyTurnDone()).toBe(false);
    saveNotifyTurnDone(true);
    expect(loadNotifyTurnDone()).toBe(true);
  });
});
