import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useNewThreadFlow } from "../hooks/useNewThreadFlow";

describe("useNewThreadFlow", () => {
  it("starts with nothing pending", () => {
    const { result } = renderHook(() => useNewThreadFlow());
    expect(result.current.newThreadPicker).toBe(false);
    expect(result.current.pendingMode).toBeNull();
    expect(result.current.specTypePicker).toBe(false);
    expect(result.current.transitioning).toBe(false);
  });

  // D19/D20: picking a mode does not create a thread, so the choices made
  // between picking and creating have to survive somewhere.
  it("holds the framing choices made before a thread exists", () => {
    const { result } = renderHook(() => useNewThreadFlow());
    act(() => {
      result.current.setPendingMode("spec");
      result.current.setFramingExecutor("claude");
      result.current.setFramingModel("opus");
    });
    expect(result.current.pendingMode).toBe("spec");
    expect(result.current.framingExecutor).toBe("claude");
    expect(result.current.framingModel).toBe("opus");
  });

  /**
   * The bug this guards, from App.tsx's own comment: each of these outranks
   * the picker in the chat's render condition, so leaving a single one set
   * made every "New thread" button silently do nothing — pick Go, don't send,
   * and there was no way back to the picker. Clearing them one by one at each
   * call site is what let one be missed.
   */
  it("puts every part of the flow back to rest in one call", () => {
    const { result } = renderHook(() => useNewThreadFlow());
    act(() => {
      result.current.setNewThreadPicker(true);
      result.current.setPendingMode("go");
      result.current.setSpecTypePicker(true);
      result.current.setComposerSpecTypePicker(true);
      result.current.setFramingExecutor("claude");
      result.current.setFramingModel("opus");
      result.current.setTransitioning(true);
    });

    act(() => result.current.reset());

    expect(result.current).toMatchObject({
      newThreadPicker: false,
      pendingMode: null,
      specTypePicker: false,
      composerSpecTypePicker: false,
      framingExecutor: null,
      framingModel: null,
      transitioning: false,
    });
  });

  it("keeps the two spec-type pickers apart", () => {
    // One is for a thread that does not exist yet, the other for a thread
    // being toggled into spec mode. Conflating them would fire the wrong
    // handler on commit.
    const { result } = renderHook(() => useNewThreadFlow());
    act(() => result.current.setComposerSpecTypePicker(true));
    expect(result.current.specTypePicker).toBe(false);
    expect(result.current.composerSpecTypePicker).toBe(true);
  });
});
