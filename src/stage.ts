/**
 * Spec-mode stage derivation (amended D19).
 *
 * The staged flow: explore → propose → apply, all in spec-mode.
 * The stage is derived from the thread's mode, whether it has an open
 * change, and whether that change's planning artifacts are complete.
 */

export type SpecStage =
  | "exploring" // spec-mode, no change yet — grill-explore auto-fired
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
 */
export function deriveStage(
  mode: string,
  hasChange: boolean,
  changeComplete: boolean | null
): SpecStage {
  if (mode === "go") return "implementing";
  if (mode !== "spec") return "chat";
  if (!hasChange) return "exploring";
  if (changeComplete === true) return "ready_to_apply";
  return "proposing";
}
