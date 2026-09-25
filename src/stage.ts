/**
 * Spec-mode stage derivation (amended D19).
 *
 * The staged flow: explore → propose → apply, all in spec-mode.
 * The stage is derived from the thread's mode, whether it has an open
 * change, and whether that change's planning artifacts are complete.
 */

import type { Message } from "./api";
import { isProposeCommand } from "./skillLabel";

export type SpecStage =
  | "exploring" // spec-mode, no change and no Propose sent — grill-explore auto-fired
  | "proposing" // spec-mode, change exists, artifacts not complete
  | "ready_to_apply" // spec-mode, change exists, artifacts complete
  | "implementing" // go-mode — direct implementation, no skill
  | "chat"; // any other mode or no thread

/**
 * Derive the spec-mode stage from the thread's state.
 *
 * @param mode - The thread's current mode ("spec" | "go")
 * @param hasChange - Whether the thread has an open spec change
 * @param changeComplete - Whether `openspec status` reports isComplete: true.
 *   `null` means the status is unknown (not yet fetched or openspec missing).
 * @param proposeSent - Whether a Propose turn has been sent on this thread;
 *   the stage starts then, not when the agent first writes the change.
 */
export function deriveStage(
  mode: string,
  hasChange: boolean,
  changeComplete: boolean | null,
  proposeSent = false
): SpecStage {
  if (mode === "go") return "implementing";
  if (mode !== "spec") return "chat";
  if (!hasChange) return proposeSent ? "proposing" : "exploring";
  if (changeComplete === true) return "ready_to_apply";
  return "proposing";
}

/** Whether Propose was sent since the thread last started exploring. An
 * older Propose belongs to an earlier idea: after that change is unlinked, a
 * fresh Explore must read as exploring again. */
export function proposeSentSinceExplore(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (isProposeCommand(m.content)) return true;
    if (m.explores != null) return false;
  }
  return false;
}
