import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useResizable, type UseResizableOptions } from "../useResizable";

const KEY = "palisade:layout:test-hash:left";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("useResizable", () => {
  it("starts at defaultSize when nothing persisted", () => {
    const { result } = renderHook(() =>
      useResizable({ storageKey: KEY, defaultSize: 193, min: 160, max: 480, axis: "horizontal" }),
    );
    expect(result.current.size).toBe(193);
    expect(result.current.collapsed).toBe(false);
  });

  it("starts collapsed when defaultCollapsed is set and nothing persisted", () => {
    const { result } = renderHook(() =>
      useResizable({
        storageKey: KEY,
        defaultSize: 300,
        min: 260,
        max: 820,
        axis: "horizontal",
        defaultCollapsed: true,
      }),
    );
    expect(result.current.collapsed).toBe(true);
  });

  it("drags to a new size and persists only on pointer-up", () => {
    const { result } = renderHook(() =>
      useResizable({ storageKey: KEY, defaultSize: 193, min: 160, max: 480, axis: "horizontal" }),
    );

    act(() => {
      result.current.handleProps.onPointerDown({ clientX: 100, clientY: 0 } as PointerEvent);
    });
    act(() => {
      result.current.handleProps.onPointerMove({ clientX: 160, clientY: 0 } as PointerEvent);
    });
    expect(result.current.size).toBe(253);
    // not yet persisted mid-drag
    expect(localStorage.getItem(KEY)).toBeNull();

    act(() => {
      result.current.handleProps.onPointerUp();
    });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ size: 253, collapsed: false });
  });

  it("clamps to min/max", () => {
    const { result } = renderHook(() =>
      useResizable({ storageKey: KEY, defaultSize: 193, min: 160, max: 480, axis: "horizontal" }),
    );

    act(() => result.current.handleProps.onPointerDown({ clientX: 0, clientY: 0 } as PointerEvent));
    act(() => result.current.handleProps.onPointerMove({ clientX: -500, clientY: 0 } as PointerEvent));
    expect(result.current.size).toBe(160);

    act(() => result.current.handleProps.onPointerMove({ clientX: 5000, clientY: 0 } as PointerEvent));
    expect(result.current.size).toBe(480);
  });

  it("reverse axis shrinks size as pointer moves right", () => {
    const { result } = renderHook(() =>
      useResizable({ storageKey: KEY, defaultSize: 300, min: 200, max: 640, axis: "horizontal", reverse: true }),
    );
    act(() => result.current.handleProps.onPointerDown({ clientX: 500, clientY: 0 } as PointerEvent));
    act(() => result.current.handleProps.onPointerMove({ clientX: 560, clientY: 0 } as PointerEvent));
    expect(result.current.size).toBe(240);
  });

  it("collapse hides the panel and restore returns to the persisted size", () => {
    localStorage.setItem(KEY, JSON.stringify({ size: 320, collapsed: false }));
    const { result } = renderHook(() =>
      useResizable({ storageKey: KEY, defaultSize: 193, min: 160, max: 480, axis: "horizontal" }),
    );
    expect(result.current.size).toBe(320);

    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ size: 320, collapsed: true });

    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(false);
    expect(result.current.size).toBe(320);
  });

  it("setCollapsed forces an explicit open/closed state", () => {
    const { result } = renderHook(() =>
      useResizable({ storageKey: KEY, defaultSize: 300, min: 260, max: 820, axis: "horizontal", defaultCollapsed: true }),
    );
    expect(result.current.collapsed).toBe(true);

    act(() => result.current.setCollapsed(false));
    expect(result.current.collapsed).toBe(false);

    act(() => result.current.setCollapsed(false));
    expect(result.current.collapsed).toBe(false);
  });

  it("re-hydrates from localStorage when storageKey changes (project switch)", () => {
    localStorage.setItem("palisade:layout:proj-a:left", JSON.stringify({ size: 200, collapsed: false }));
    localStorage.setItem("palisade:layout:proj-b:left", JSON.stringify({ size: 350, collapsed: true }));

    const { result, rerender } = renderHook(
      (props: UseResizableOptions) => useResizable(props),
      {
        initialProps: {
          storageKey: "palisade:layout:proj-a:left",
          defaultSize: 193,
          min: 160,
          max: 480,
          axis: "horizontal",
        },
      },
    );
    expect(result.current.size).toBe(200);

    rerender({
      storageKey: "palisade:layout:proj-b:left",
      defaultSize: 193,
      min: 160,
      max: 480,
      axis: "horizontal",
    });
    expect(result.current.size).toBe(350);
    expect(result.current.collapsed).toBe(true);
  });

  it("rehydrates from localStorage on remount (persistence across mounts)", () => {
    const first = renderHook(() =>
      useResizable({ storageKey: KEY, defaultSize: 193, min: 160, max: 480, axis: "horizontal" }),
    );
    act(() => first.result.current.handleProps.onPointerDown({ clientX: 0, clientY: 0 } as PointerEvent));
    act(() => first.result.current.handleProps.onPointerMove({ clientX: 100, clientY: 0 } as PointerEvent));
    act(() => first.result.current.handleProps.onPointerUp());
    first.unmount();

    const second = renderHook(() =>
      useResizable({ storageKey: KEY, defaultSize: 193, min: 160, max: 480, axis: "horizontal" }),
    );
    expect(second.result.current.size).toBe(293);
  });
});
