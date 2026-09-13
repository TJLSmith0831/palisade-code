import { useCallback, useState } from "react";
import type * as api from "../api";

/**
 * The state of starting a thread, from picking a mode to the thread existing.
 *
 * Another coherent slice out of App.tsx's 50 useState calls. Everything here
 * belongs to one flow — D19/D20's deferred creation, where picking a mode no
 * longer creates a thread and the choices made in between have to live
 * somewhere until one exists.
 *
 * Keeping them together is what makes the flow legible: scattered through a
 * 4,500-line component, the fact that `pendingMode`, the two spec-type
 * pickers, the framing executor and model, and `transitioning` are all one
 * state machine was something you had to already know.
 */
export function useNewThreadFlow() {
  // Shows the inline Vibe/Spec picker in the chat surface in place of the
  // thread view — not part of `bar` since it isn't an overlay (spec:
  // new-thread-mode-picker requires it inline, not a modal dialog).
  const [newThreadPicker, setNewThreadPicker] = useState(false);

  // D19/D20: deferred thread creation — picking a mode from the Vibe/Spec
  // picker no longer creates a thread immediately. For "go", an empty composer
  // appears; the thread is created on first send. For "spec", the framing menu
  // appears (Group 7); the thread is created on spec-type commit (Group 8).
  const [pendingMode, setPendingMode] = useState<api.Mode | null>(null);

  // D21: executor/model selected in the framing menu — stored before the
  // thread exists, then persisted on the thread when it's created.
  const [framingExecutor, setFramingExecutor] = useState<string | null>(null);
  const [framingModel, setFramingModel] = useState<string | null>(null);

  // D1: spec-type framing menu — shown after picking "Spec" from the Vibe/Spec
  // picker. The user picks Feature/Bugfix/Other before the agent runs (D2/D3).
  const [specTypePicker, setSpecTypePicker] = useState(false);

  // D9: composer-toggle spec-type framing menu — shown when toggling an
  // existing thread to spec mode with no open change and no stored spec_type.
  // Separate from `specTypePicker` because the thread already exists — the
  // spec-type handler calls specMode(thread.id, specType) directly.
  const [composerSpecTypePicker, setComposerSpecTypePicker] = useState(false);

  // D19/D20: transitioning — true during the async gap between clearing
  // picker state and the thread being selected. Prevents the Vibe shell's
  // showEmptyModePicker from re-rendering the mode picker mid-transition.
  const [transitioning, setTransitioning] = useState(false);

  /**
   * Put the flow back to rest.
   *
   * Every exit from it — committing a spec type, sending a first message,
   * backing out, switching thread — has to clear the same six things, and
   * before this each of those paths cleared them one by one. Missing one is
   * how a picker ends up on screen for a thread that already exists.
   */
  const reset = useCallback(() => {
    setNewThreadPicker(false);
    setPendingMode(null);
    setSpecTypePicker(false);
    setComposerSpecTypePicker(false);
    setFramingExecutor(null);
    setFramingModel(null);
    setTransitioning(false);
  }, []);

  return {
    newThreadPicker,
    setNewThreadPicker,
    pendingMode,
    setPendingMode,
    framingExecutor,
    setFramingExecutor,
    framingModel,
    setFramingModel,
    specTypePicker,
    setSpecTypePicker,
    composerSpecTypePicker,
    setComposerSpecTypePicker,
    transitioning,
    setTransitioning,
    reset,
  };
}

export type NewThreadFlow = ReturnType<typeof useNewThreadFlow>;
