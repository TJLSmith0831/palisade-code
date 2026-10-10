import { profileStorage } from "./profileStorage";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

// A turn that ends while the user is elsewhere is the one event worth a
// system notification: the dock badge says "something", this says which
// thread and what happened. Nothing fires while the window has focus — the
// thread is on screen and the Fleet board already moved it.

export const NOTIFY_TURN_DONE_KEY = "palisade:notifyTurnDone";

/** On unless the user turned it off in Settings. */
export function loadNotifyTurnDone(): boolean {
  try {
    return profileStorage.getItem(NOTIFY_TURN_DONE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveNotifyTurnDone(on: boolean): void {
  try {
    profileStorage.setItem(NOTIFY_TURN_DONE_KEY, on ? "1" : "0");
  } catch {
    // A blocked storage just means the default (on) next launch.
  }
}

export type TurnKind = "done" | "crashed";

/** The words on the notification. Kept pure so the copy is testable. */
export function turnNotification(threadTitle: string, kind: TurnKind): { title: string; body: string } {
  const title = threadTitle.trim() || "A thread finished";
  const body =
    kind === "done"
      ? "Turn finished — ready to review."
      : "The agent crashed. Open the thread to retry.";
  return { title, body };
}

type Deps = {
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<string>;
  send: (options: { title: string; body: string }) => void;
};

const platform: Deps = { isPermissionGranted, requestPermission, send: sendNotification };

/**
 * Notify about a finished turn if the window is unfocused and the setting is
 * on. Asks for permission the first time; a refusal is remembered by the OS,
 * so this never nags. Never throws — it runs inside the event relay.
 */
export async function notifyTurnDone(
  input: { threadTitle: string; kind: TurnKind; focused: boolean },
  deps: Deps = platform
): Promise<boolean> {
  if (input.focused || !loadNotifyTurnDone()) return false;
  try {
    const granted = (await deps.isPermissionGranted()) || (await deps.requestPermission()) === "granted";
    if (!granted) return false;
    deps.send(turnNotification(input.threadTitle, input.kind));
    return true;
  } catch {
    return false;
  }
}
