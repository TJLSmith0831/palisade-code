import { beforeEach, describe, expect, it, vi } from "vitest";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";

const render = (ui: React.ReactNode) => rtlRender(ui, { wrapper: MantineProvider });

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

const { termInstances } = vi.hoisted(() => ({
  termInstances: [] as { write: ReturnType<typeof vi.fn>; writeln: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[],
}));

vi.mock("@xterm/xterm", () => {
  class FakeTerminal {
    open = vi.fn();
    loadAddon = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    writeln = vi.fn();
    focus = vi.fn();
    options: Record<string, unknown> = {};
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    constructor() {
      termInstances.push(this as never);
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
import TerminalTabs from "../TerminalTabs";

const emit = (name: string, payload: unknown) =>
  (listeners[name] ?? []).forEach((cb) => cb({ payload }));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "terminal_spawn") return Promise.resolve(true);
    if (cmd === "terminal_list") return Promise.resolve([]);
    return Promise.resolve();
  });
  termInstances.length = 0;
  for (const key of Object.keys(listeners)) delete listeners[key];
});

describe("TerminalPane", () => {
  it("spawns the PTY for its own tab id", async () => {
    render(<TerminalPane projectHash="proj-1" terminalId="proj-1:1" />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("terminal_spawn", {
        projectHash: "proj-1",
        terminalId: "proj-1:1",
      }),
    );
  });

  it("renders only the output addressed to its own tab", async () => {
    render(
      <>
        <TerminalPane projectHash="p" terminalId="tab-a" />
        <TerminalPane projectHash="p" terminalId="tab-b" />
      </>,
    );
    await waitFor(() => expect(termInstances).toHaveLength(2));
    await waitFor(() => expect(listeners["terminal-output"]?.length).toBe(2));

    emit("terminal-output", { terminalId: "tab-a", data: btoa("hello-a") });
    expect(termInstances[0].write).toHaveBeenCalledTimes(1);
    expect(termInstances[1].write).not.toHaveBeenCalled();

    emit("terminal-output", { terminalId: "tab-b", data: btoa("hello-b") });
    expect(termInstances[0].write).toHaveBeenCalledTimes(1);
    expect(termInstances[1].write).toHaveBeenCalledTimes(1);
  });

  it("sends input tagged with its tab id", async () => {
    render(<TerminalPane projectHash="p" terminalId="tab-x" />);
    await waitFor(() => expect(termInstances).toHaveLength(1));
    const onData = (
      termInstances[0] as never as { onData: { mock: { calls: [(d: string) => void][] } } }
    ).onData.mock.calls[0][0];
    onData("ls\n");
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("terminal_input", {
        terminalId: "tab-x",
        data: "ls\n",
      }),
    );
  });

  it("reports a spawn failure into the terminal rather than throwing", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "terminal_spawn"
        ? Promise.reject(new Error("start terminal: no pty available"))
        : Promise.resolve(),
    );
    render(<TerminalPane projectHash="p" terminalId="tab-x" />);
    await waitFor(() =>
      expect(termInstances[0].writeln).toHaveBeenCalledWith(
        expect.stringContaining("no pty available"),
      ),
    );
  });

  it("has no header of its own — the tab strip is the header", () => {
    render(<TerminalPane projectHash="p" terminalId="t" />);
    expect(screen.queryByTestId("terminal-placement-toggle")).toBeNull();
  });
});

describe("TerminalTabs", () => {
  it("opens one tab on mount", async () => {
    render(<TerminalTabs projectHash="p" />);
    await waitFor(() => expect(screen.getAllByTestId(/^terminal-tab-\d/)).toHaveLength(1));
    expect(termInstances).toHaveLength(1);
  });

  it("keeps every tab's PTY mounted so background processes keep running", async () => {
    const user = userEvent.setup();
    render(<TerminalTabs projectHash="p" />);
    await waitFor(() => expect(termInstances).toHaveLength(1));

    await user.click(screen.getByTestId("terminal-tab-new"));
    await waitFor(() => expect(termInstances).toHaveLength(2));
    expect(screen.getAllByTestId("terminal-pane")).toHaveLength(2);
    expect(termInstances[0].dispose).not.toHaveBeenCalled();

    await user.click(screen.getAllByTestId(/^terminal-tab-\d/)[0]);
    expect(screen.getAllByTestId("terminal-pane")).toHaveLength(2);
    expect(termInstances[1].dispose).not.toHaveBeenCalled();
  });

  it("closes one tab without touching the others", async () => {
    const user = userEvent.setup();
    render(<TerminalTabs projectHash="p" />);
    await user.click(screen.getByTestId("terminal-tab-new"));
    await waitFor(() => expect(termInstances).toHaveLength(2));

    await user.click(screen.getAllByTestId(/^terminal-close-/)[0]);
    await waitFor(() => expect(screen.getAllByTestId(/^terminal-tab-\d/)).toHaveLength(1));
    expect(invokeMock).toHaveBeenCalledWith("terminal_kill", { terminalId: expect.any(String) });
    expect(screen.getAllByTestId("terminal-pane")).toHaveLength(1);
  });

  it("survives a rapid open/close cycle without leaking tabs", async () => {
    const user = userEvent.setup();
    render(<TerminalTabs projectHash="p" />);
    for (let i = 0; i < 5; i++) await user.click(screen.getByTestId("terminal-tab-new"));
    await waitFor(() => expect(screen.getAllByTestId(/^terminal-tab-\d/)).toHaveLength(6));
    for (const close of screen.getAllByTestId(/^terminal-close-/).slice(0, 5)) {
      await user.click(close);
    }
    await waitFor(() => expect(screen.getAllByTestId(/^terminal-tab-\d/)).toHaveLength(1));
  });

  it("refuses to open more than the backend's tab limit", async () => {
    const user = userEvent.setup();
    render(<TerminalTabs projectHash="p" />);
    for (let i = 0; i < 12; i++) {
      const add = screen.getByTestId("terminal-tab-new");
      if ((add as HTMLButtonElement).disabled) break;
      await user.click(add);
    }
    expect(screen.getAllByTestId(/^terminal-tab-\d/).length).toBe(8);
    expect(screen.getByTestId("terminal-tab-new")).toBeDisabled();
  });

  it("never closes the last tab — there is always one shell", async () => {
    render(<TerminalTabs projectHash="p" />);
    await waitFor(() => expect(screen.getAllByTestId(/^terminal-tab-\d/)).toHaveLength(1));
    expect(screen.queryAllByTestId(/^terminal-close-/)).toHaveLength(0);
  });

  it("starts a fresh strip and closes the old project's shells on project switch", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TerminalTabs projectHash="p" />);
    await user.click(screen.getByTestId("terminal-tab-new"));
    await waitFor(() => expect(screen.getAllByTestId(/^terminal-tab-\d/)).toHaveLength(2));

    rerender(<TerminalTabs projectHash="q" />);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("terminal_kill_project", { projectHash: "p" }),
    );
    await waitFor(() => expect(screen.getAllByTestId(/^terminal-tab-\d/)).toHaveLength(1));
  });

  it("reports which tab is focused so Run has somewhere to type", async () => {
    const user = userEvent.setup();
    const onActive = vi.fn();
    render(<TerminalTabs projectHash="p" onActiveTerminalChange={onActive} />);
    await waitFor(() => expect(onActive).toHaveBeenCalledWith("p:1"));

    await user.click(screen.getByTestId("terminal-tab-new"));
    await waitFor(() => expect(onActive).toHaveBeenCalledWith("p:2"));

    await user.click(screen.getByTestId("terminal-tab-1"));
    await waitFor(() => expect(onActive).toHaveBeenLastCalledWith("p:1"));
  });

  it("hands focus to a surviving tab when the focused one is closed", async () => {
    const user = userEvent.setup();
    const onActive = vi.fn();
    render(<TerminalTabs projectHash="p" onActiveTerminalChange={onActive} />);
    await user.click(screen.getByTestId("terminal-tab-new"));
    await waitFor(() => expect(onActive).toHaveBeenLastCalledWith("p:2"));

    await user.click(screen.getByTestId("terminal-close-2"));
    await waitFor(() => expect(onActive).toHaveBeenLastCalledWith("p:1"));
  });

  it("numbers new tabs consecutively under StrictMode", async () => {
    // Regression (dogfood): the tab index was bumped inside a `setTabs`
    // updater. React double-invokes updaters in development, so every click
    // consumed two numbers and the strip read "Terminal 1, 2, 4" — and the
    // skipped id was the one the backend had no PTY under, so writing to
    // "tab 3" failed with "no terminal running". State updaters must be pure.
    const user = userEvent.setup();
    render(
      <StrictMode>
        <TerminalTabs projectHash="p" />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getAllByTestId(/^terminal-tab-\d/)).toHaveLength(1));

    await user.click(screen.getByTestId("terminal-tab-new"));
    await user.click(screen.getByTestId("terminal-tab-new"));

    await waitFor(() => expect(screen.getAllByTestId(/^terminal-tab-\d/)).toHaveLength(3));
    expect(
      screen.getAllByTestId(/^terminal-tab-\d/).map((el) => el.textContent),
    ).toEqual(["Terminal 1", "Terminal 2", "Terminal 3"]);

    // And every tab shown has a PTY spawned under exactly its own id.
    const spawned = invokeMock.mock.calls
      .filter(([cmd]) => cmd === "terminal_spawn")
      .map(([, args]) => (args as { terminalId: string }).terminalId);
    for (const id of ["p:1", "p:2", "p:3"]) expect(spawned).toContain(id);
  });
});
