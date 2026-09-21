import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));

vi.mock("../api", () => ({ fleetOverview: vi.fn() }));

import * as api from "../api";
import { useFleet } from "../hooks/useFleet";

const mocked = api as unknown as { fleetOverview: ReturnType<typeof vi.fn> };

beforeEach(() => {
  handlers.clear();
  mocked.fleetOverview.mockReset().mockResolvedValue([]);
});

describe("useFleet", () => {
  it("loads the fleet on mount", async () => {
    const { result } = renderHook(() => useFleet({ active: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocked.fleetOverview).toHaveBeenCalledTimes(1);
  });

  it("reloads on refresh", async () => {
    const { result } = renderHook(() => useFleet({ active: true }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.refresh();
    });
    expect(mocked.fleetOverview).toHaveBeenCalledTimes(2);
  });

  it("reloads when an executor envelope arrives", async () => {
    renderHook(() => useFleet({ active: true }));
    await waitFor(() => expect(handlers.has("executor-event")).toBe(true));
    await act(async () => {
      handlers.get("executor-event")?.({ payload: {} });
    });
    await waitFor(() => expect(mocked.fleetOverview).toHaveBeenCalledTimes(2));
  });

  it("stays loading, and does not fetch, until a project is open", async () => {
    const { result, rerender } = renderHook(({ active }) => useFleet({ active }), {
      initialProps: { active: false },
    });
    expect(result.current.loading).toBe(true);
    expect(mocked.fleetOverview).not.toHaveBeenCalled();
    rerender({ active: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocked.fleetOverview).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed load as an error", async () => {
    mocked.fleetOverview.mockRejectedValue(new Error("no backend"));
    const { result } = renderHook(() => useFleet({ active: true }));
    await waitFor(() => expect(result.current.error).toContain("no backend"));
  });
});
