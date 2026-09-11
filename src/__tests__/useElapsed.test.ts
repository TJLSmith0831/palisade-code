import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useElapsed } from "../useElapsed";

describe("useElapsed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is zero without a start time", () => {
    const { result } = renderHook(() => useElapsed(undefined));
    expect(result.current).toBe(0);
  });

  it("keeps counting while a run is live, with no event to re-render it", () => {
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    const { result } = renderHook(() => useElapsed("2026-09-10T00:00:00Z"));
    expect(result.current).toBe(0);

    act(() => void vi.advanceTimersByTime(240_000));

    expect(result.current).toBe(240);
  });

  it("freezes at the run's own duration once it has ended", () => {
    vi.setSystemTime(new Date("2026-09-10T00:10:00Z"));
    const { result } = renderHook(() =>
      useElapsed("2026-09-10T00:00:00Z", "2026-09-10T00:00:30Z")
    );
    expect(result.current).toBe(30);

    act(() => void vi.advanceTimersByTime(60_000));

    expect(result.current).toBe(30);
  });

  it("never reports negative seconds for a clock skewed into the future", () => {
    vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
    const { result } = renderHook(() => useElapsed("2026-09-10T00:05:00Z"));
    expect(result.current).toBe(0);
  });
});
