import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

const { listenMock, listeners } = vi.hoisted(() => {
  const listeners: Record<string, ((e: { payload: unknown }) => void)[]> = {};
  return {
    listeners,
    listenMock: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
      (listeners[name] ??= []).push(cb);
      return Promise.resolve(() => {
        listeners[name] = (listeners[name] ?? []).filter((c) => c !== cb);
      });
    }),
  };
});
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import DebugPanel from "../DebugPanel";
import type { DebugStatus, StackFrame, StoppedState, Watch } from "../api";

const render = (ui: React.ReactNode) => rtlRender(ui, { wrapper: MantineProvider });
const emit = (name: string, payload: unknown) =>
  (listeners[name] ?? []).forEach((cb) => cb({ payload }));

/** `listen()` resolves on a microtask, so an event fired on the render tick
 *  would land before the panel is subscribed. */
const subscribed = () => waitFor(() => expect(listeners["debug-stopped"]?.length).toBe(1));

const frame = (over: Partial<StackFrame> = {}): StackFrame => ({
  id: 1000,
  name: "compute",
  path: "src/lib.rs",
  line: 12,
  column: 5,
  isLibrary: false,
  ...over,
});

const stopped = (over: Partial<StoppedState> = {}): StoppedState => ({
  threadId: 1,
  reason: "breakpoint",
  description: null,
  frames: [frame(), frame({ id: 1001, name: "core::iter::next", path: "/rustup/iter.rs", isLibrary: true })],
  ...over,
});

const status = (over: Partial<DebugStatus> = {}): DebugStatus => ({
  sessionId: null,
  language: null,
  stopped: null,
  breakpoints: {},
  ...over,
});

const backend = (over: Record<string, unknown> = {}) =>
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd in over) return Promise.resolve(over[cmd]);
    if (cmd === "debug_status") return Promise.resolve(status());
    if (cmd === "debug_adapter")
      return Promise.resolve({ language: "rust", command: "lldb-dap", args: [], installed: true });
    if (cmd === "debug_evaluate") return Promise.resolve([]);
    if (cmd === "debug_scopes") return Promise.resolve([]);
    if (cmd === "debug_start") return Promise.resolve(status({ sessionId: "s1", language: "rust" }));
    return Promise.resolve(undefined);
  });

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockClear();
  for (const key of Object.keys(listeners)) delete listeners[key];
});

describe("DebugPanel", () => {
  it("says the debugger is idle before anything is launched", async () => {
    backend();
    render(<DebugPanel projectHash="p" language="rust" />);
    await waitFor(() => expect(screen.getByTestId("debug-idle")).toBeDefined());
    expect(screen.getByTestId("debug-start")).toBeDefined();
  });

  it("names the adapter to install when there isn't one", async () => {
    backend({
      debug_adapter: { language: "rust", command: "lldb-dap", args: [], installed: false },
    });
    render(<DebugPanel projectHash="p" language="rust" />);
    // "Debugging unavailable" with no reason is a dead end; the binary is
    // the actionable part.
    await waitFor(() => expect(screen.getByText(/lldb-dap/)).toBeDefined());
    expect(screen.getByTestId("debug-start")).toBeDisabled();
  });

  it("says so plainly for a language with no known adapter", async () => {
    backend({ debug_adapter: null });
    render(<DebugPanel projectHash="p" language="cobol" />);
    await waitFor(() => expect(screen.getByTestId("debug-no-adapter")).toBeDefined());
  });

  it("shows the call stack when the program stops, innermost frame first", async () => {
    backend();
    render(<DebugPanel projectHash="p" language="rust" />);
    await waitFor(() => expect(screen.getByTestId("debug-idle")).toBeDefined());

    emit("debug-stopped", stopped());
    await waitFor(() => expect(screen.getAllByTestId(/^debug-frame-/)).toHaveLength(2));
    const frames = screen.getAllByTestId(/^debug-frame-/);
    expect(frames[0].textContent).toContain("compute");
    expect(frames[0].textContent).toContain("src/lib.rs:12");
  });

  it("marks a frame that is not the user's code", async () => {
    backend();
    render(<DebugPanel projectHash="p" language="rust" />);
    await subscribed();
    emit("debug-stopped", stopped());
    await waitFor(() => expect(screen.getByTestId("debug-frame-1001")).toBeDefined());
    // Stepping into a dependency: shown (hiding frames makes a stack lie
    // about how you got here) but marked.
    expect(screen.getByTestId("debug-frame-1001")).toHaveAttribute("data-library", "true");
    expect(screen.getByTestId("debug-frame-1000")).toHaveAttribute("data-library", "false");
  });

  it("says why it stopped", async () => {
    backend();
    render(<DebugPanel projectHash="p" language="rust" />);
    await subscribed();
    emit("debug-stopped", stopped({ reason: "exception", description: "index out of bounds" }));
    await waitFor(() => expect(screen.getByText(/exception/)).toBeDefined());
    expect(screen.getByText(/index out of bounds/)).toBeDefined();
  });

  it("opens a frame's source when it is clicked", async () => {
    const onOpen = vi.fn();
    backend();
    render(<DebugPanel projectHash="p" language="rust" onOpen={onOpen} />);
    await subscribed();
    emit("debug-stopped", stopped());
    await waitFor(() => expect(screen.getByTestId("debug-frame-1000")).toBeDefined());

    fireEvent.click(screen.getByTestId("debug-frame-1000"));
    expect(onOpen).toHaveBeenCalledWith("src/lib.rs", 12);
  });

  it("steps only while stopped", async () => {
    backend();
    render(<DebugPanel projectHash="p" language="rust" />);
    await waitFor(() => expect(screen.getByTestId("debug-step-over")).toBeDefined());
    // Stepping a program that is running is meaningless; the buttons say so
    // rather than sending a request that errors.
    expect(screen.getByTestId("debug-step-over")).toBeDisabled();

    emit("debug-stopped", stopped());
    await waitFor(() => expect(screen.getByTestId("debug-step-over")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("debug-step-in"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("debug_step", {
        action: "stepIn",
        threadId: 1,
      }),
    );
  });

  it("offers continue, step over, step in and step out", async () => {
    backend();
    render(<DebugPanel projectHash="p" language="rust" />);
    await subscribed();
    emit("debug-stopped", stopped());
    await waitFor(() => expect(screen.getByTestId("debug-continue")).toBeDefined());
    for (const id of ["debug-continue", "debug-step-over", "debug-step-in", "debug-step-out"]) {
      expect(screen.getByTestId(id)).toBeDefined();
    }
  });

  it("clears the stack when the program continues", async () => {
    backend();
    render(<DebugPanel projectHash="p" language="rust" />);
    await subscribed();
    emit("debug-stopped", stopped());
    await waitFor(() => expect(screen.getAllByTestId(/^debug-frame-/)).toHaveLength(2));

    emit("debug-continued", {});
    // A stack from the last stop is not where the program is now; leaving it
    // on screen invites clicking a frame that no longer exists.
    await waitFor(() => expect(screen.queryAllByTestId(/^debug-frame-/)).toHaveLength(0));
  });

  it("returns to idle when the session ends", async () => {
    backend();
    render(<DebugPanel projectHash="p" language="rust" />);
    await subscribed();
    emit("debug-stopped", stopped());
    await waitFor(() => expect(screen.getAllByTestId(/^debug-frame-/)).toHaveLength(2));

    emit("debug-ended", { reason: "terminated" });
    await waitFor(() => expect(screen.getByTestId("debug-idle")).toBeDefined());
  });

  describe("watch expressions", () => {
    const watch = (over: Partial<Watch> = {}): Watch => ({
      expression: "count",
      value: "3",
      type: "i32",
      variablesReference: 0,
      expandable: false,
      error: null,
      ...over,
    });

    it("evaluates a watch in the selected frame when the program stops", async () => {
      backend({ debug_evaluate: [watch()] });
      render(<DebugPanel projectHash="p" language="rust" />);
      await waitFor(() => expect(screen.getByTestId("debug-watch-add")).toBeDefined());

      fireEvent.change(screen.getByTestId("debug-watch-input"), {
        target: { value: "count" },
      });
      fireEvent.click(screen.getByTestId("debug-watch-add"));
      emit("debug-stopped", stopped());

      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("debug_evaluate", {
          expressions: ["count"],
          // Without a frame id the adapter evaluates in global scope, where
          // every local reads as "not found".
          frameId: 1000,
        }),
      );
      await waitFor(() => expect(screen.getByTestId("debug-watch-count")).toBeDefined());
      expect(screen.getByTestId("debug-watch-count").textContent).toContain("3");
    });

    it("shows a failed watch's reason instead of a stale value", async () => {
      backend({
        debug_evaluate: [watch({ expression: "gone", value: null, error: "no symbol named 'gone'" })],
      });
      render(<DebugPanel projectHash="p" language="rust" />);
      await subscribed();
      fireEvent.change(screen.getByTestId("debug-watch-input"), { target: { value: "gone" } });
      fireEvent.click(screen.getByTestId("debug-watch-add"));
      emit("debug-stopped", stopped());

      await waitFor(() => expect(screen.getByText(/no symbol named/)).toBeDefined());
    });

    it("re-evaluates every watch on the next stop", async () => {
      backend({ debug_evaluate: [watch()] });
      render(<DebugPanel projectHash="p" language="rust" />);
      await subscribed();
      fireEvent.change(screen.getByTestId("debug-watch-input"), { target: { value: "count" } });
      fireEvent.click(screen.getByTestId("debug-watch-add"));

      emit("debug-stopped", stopped());
      await waitFor(() =>
        expect(invokeMock.mock.calls.filter(([c]) => c === "debug_evaluate")).toHaveLength(1),
      );
      emit("debug-continued", {});
      emit("debug-stopped", stopped({ frames: [frame({ id: 2000 })] }));
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("debug_evaluate", {
          expressions: ["count"],
          frameId: 2000,
        }),
      );
    });

    it("removes a watch and stops evaluating it", async () => {
      backend({ debug_evaluate: [watch()] });
      render(<DebugPanel projectHash="p" language="rust" />);
      await subscribed();
      fireEvent.change(screen.getByTestId("debug-watch-input"), { target: { value: "count" } });
      fireEvent.click(screen.getByTestId("debug-watch-add"));
      emit("debug-stopped", stopped());
      await waitFor(() => expect(screen.getByTestId("debug-watch-count")).toBeDefined());

      fireEvent.click(screen.getByTestId("debug-watch-remove-count"));
      await waitFor(() => expect(screen.queryByTestId("debug-watch-count")).toBeNull());
    });

    it("does not add a blank or duplicate watch", async () => {
      backend();
      render(<DebugPanel projectHash="p" language="rust" />);
      fireEvent.click(screen.getByTestId("debug-watch-add"));
      expect(screen.queryAllByTestId(/^debug-watch-row-/)).toHaveLength(0);

      fireEvent.change(screen.getByTestId("debug-watch-input"), { target: { value: "count" } });
      fireEvent.click(screen.getByTestId("debug-watch-add"));
      fireEvent.change(screen.getByTestId("debug-watch-input"), { target: { value: "count" } });
      fireEvent.click(screen.getByTestId("debug-watch-add"));
      await waitFor(() => expect(screen.getAllByTestId(/^debug-watch-row-/)).toHaveLength(1));
    });

    it("evaluates against the frame the user selected, not always the top one", async () => {
      backend({ debug_evaluate: [watch()] });
      render(<DebugPanel projectHash="p" language="rust" />);
      await subscribed();
      fireEvent.change(screen.getByTestId("debug-watch-input"), { target: { value: "count" } });
      fireEvent.click(screen.getByTestId("debug-watch-add"));
      emit("debug-stopped", stopped());
      await waitFor(() => expect(screen.getByTestId("debug-frame-1001")).toBeDefined());

      fireEvent.click(screen.getByTestId("debug-frame-1001"));
      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith("debug_evaluate", {
          expressions: ["count"],
          frameId: 1001,
        }),
      );
    });
  });

  it("reports a launch that failed rather than looking like it worked", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "debug_status") return Promise.resolve(status());
      if (cmd === "debug_adapter")
        return Promise.resolve({ language: "rust", command: "lldb-dap", args: [], installed: true });
      if (cmd === "debug_start")
        return Promise.reject(new Error("launch failed: no such program ./target/debug/x"));
      return Promise.resolve(undefined);
    });
    render(<DebugPanel projectHash="p" language="rust" />);
    await waitFor(() => expect(screen.getByTestId("debug-start")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("debug-start"));
    await waitFor(() => expect(screen.getByText(/no such program/)).toBeDefined());
    expect(screen.getByTestId("debug-idle")).toBeDefined();
  });
});
