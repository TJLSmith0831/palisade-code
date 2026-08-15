import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const { termInstances } = vi.hoisted(() => ({ termInstances: [] as { open: ReturnType<typeof import("vitest")["vi"]["fn"]> }[] }));

vi.mock("@xterm/xterm", () => {
  class FakeTerminal {
    open = vi.fn();
    loadAddon = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    writeln = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    constructor() {
      termInstances.push(this as unknown as { open: ReturnType<typeof import("vitest")["vi"]["fn"]> });
    }
  }
  return { Terminal: FakeTerminal };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import TerminalPane from "../TerminalPane";

describe("TerminalPane", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "terminal_spawn") return Promise.resolve();
      if (cmd === "terminal_input") return Promise.resolve();
      if (cmd === "terminal_resize") return Promise.resolve();
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
    termInstances.length = 0;
  });

  it("spawns a terminal for the project on mount", async () => {
    render(<TerminalPane projectHash="proj-1" />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("terminal_spawn", { projectHash: "proj-1" }),
    );
  });

  it("re-attaches (calls spawn again) rather than creating a second xterm instance in one mount when reopened", async () => {
    const { unmount } = render(
      <TerminalPane projectHash="proj-1" />,
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("terminal_spawn", { projectHash: "proj-1" }));
    expect(termInstances).toHaveLength(1);
    unmount();

    render(<TerminalPane projectHash="proj-1" />);
    await waitFor(() => {
      const calls = invokeMock.mock.calls.filter(
        ([cmd, args]) => cmd === "terminal_spawn" && (args as { projectHash: string }).projectHash === "proj-1",
      );
      expect(calls).toHaveLength(2);
    });
    // A closed-and-reopened panel is a fresh xterm view (scrollback isn't
    // preserved client-side), but it must still be exactly one live
    // instance at a time, not an accumulating stack.
    expect(termInstances).toHaveLength(2);
  });

  it("has no header of its own — the panel that hosts it is the header", () => {
    // Two rows both saying "Terminal", stacked, was duplicate chrome.
    render(<TerminalPane projectHash="proj-1" />);
    expect(screen.queryByTestId("terminal-placement-toggle")).toBeNull();
    expect(screen.queryByText("Terminal")).toBeNull();
  });
});
