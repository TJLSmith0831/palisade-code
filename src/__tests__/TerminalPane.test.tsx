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

const { lines, linkProviders } = vi.hoisted(() => ({
  /** Terminal buffer rows by index, for the link provider to read. */
  lines: [] as string[],
  linkProviders: [] as {
    provideLinks: (
      line: number,
      done: (links?: { text: string; range: unknown; activate: (e: MouseEvent) => void }[]) => void
    ) => void;
  }[],
}));

const { termInstances } = vi.hoisted(() => ({
  termInstances: [] as {
    write: ReturnType<typeof vi.fn>;
    writeln: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock("@xterm/xterm", () => {
  class FakeTerminal {
    open = vi.fn();
    loadAddon = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    writeln = vi.fn();
    reset = vi.fn();
    registerLinkProvider = vi.fn((provider: unknown) => {
      linkProviders.push(provider as never);
      return { dispose: vi.fn() };
    });
    buffer = {
      active: { getLine: (y: number) => ({ translateToString: () => lines[y] ?? "" }) },
    };
    cols = 100;
    rows = 30;
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

/** A pane is attached once its spawn has resolved and it has reset its view. */
const attached = (index = 0) => waitFor(() => expect(termInstances[index]?.reset).toHaveBeenCalled());

const typedInto = (index: number) =>
  (termInstances[index] as never as { onData: { mock: { calls: [(d: string) => void][] } } }).onData
    .mock.calls[0][0];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "terminal_spawn") return Promise.resolve({ spawned: true, backlog: "", end: 0 });
    if (cmd === "terminal_list") return Promise.resolve([]);
    return Promise.resolve();
  });
  termInstances.length = 0;
  linkProviders.length = 0;
  lines.length = 0;
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
    await attached(0);
    await attached(1);

    emit("terminal-output", { terminalId: "tab-a", data: btoa("hello-a"), offset: 0 });
    expect(termInstances[0].write).toHaveBeenCalledTimes(1);
    expect(termInstances[1].write).not.toHaveBeenCalled();

    emit("terminal-output", { terminalId: "tab-b", data: btoa("hello-b"), offset: 0 });
    expect(termInstances[0].write).toHaveBeenCalledTimes(1);
    expect(termInstances[1].write).toHaveBeenCalledTimes(1);
  });

  it("sends input tagged with its tab id", async () => {
    render(<TerminalPane projectHash="p" terminalId="tab-x" />);
    await attached();
    typedInto(0)("ls\n");
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

  it("listens before it spawns, so the shell's first output is not lost", async () => {
    render(<TerminalPane projectHash="p" terminalId="tab-x" />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("terminal_spawn", expect.anything()));
    expect(listeners["terminal-output"]?.length, "output listener must exist by spawn time").toBe(1);
  });

  it("replays the backlog and drops live chunks the backlog already holds", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "terminal_spawn"
        ? Promise.resolve({ spawned: false, backlog: btoa("earlier "), end: 8 })
        : Promise.resolve(),
    );
    render(<TerminalPane projectHash="p" terminalId="tab-x" />);
    await waitFor(() => expect(listeners["terminal-output"]?.length).toBe(1));
    // Arrives while the spawn call is still in flight: one chunk the backlog
    // contains (offset 0..8) and one it does not.
    emit("terminal-output", { terminalId: "tab-x", data: btoa("earlier "), offset: 0 });
    emit("terminal-output", { terminalId: "tab-x", data: btoa("later"), offset: 8 });
    await attached();

    const written = termInstances[0].write.mock.calls.map(
      ([bytes]) => new TextDecoder().decode(bytes as Uint8Array),
    );
    expect(written, "backlog once, then only the chunk past it").toEqual(["earlier ", "later"]);
  });

  it("tells the shell its real size once attached", async () => {
    render(<TerminalPane projectHash="p" terminalId="tab-x" />);
    await attached();
    expect(invokeMock).toHaveBeenCalledWith("terminal_resize", { terminalId: "tab-x", cols: 100, rows: 30 });
  });

  it("says so when the shell exits, and restarts it on the next key", async () => {
    render(<TerminalPane projectHash="p" terminalId="tab-x" />);
    await attached();

    emit("terminal-exit", { terminalId: "tab-x" });
    expect(termInstances[0].writeln).toHaveBeenCalledWith(expect.stringContaining("process exited"));

    invokeMock.mockClear();
    typedInto(0)("x");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("terminal_spawn", { projectHash: "p", terminalId: "tab-x" }));
    expect(invokeMock).not.toHaveBeenCalledWith("terminal_input", expect.anything());
  });

  it("ignores another tab's exit", async () => {
    render(<TerminalPane projectHash="p" terminalId="tab-x" />);
    await attached();
    emit("terminal-exit", { terminalId: "someone-else" });
    expect(termInstances[0].writeln).not.toHaveBeenCalled();
  });

  it("makes a local URL in the output a link that opens only on ⌘-click", async () => {
    const opened: string[] = [];
    render(<TerminalPane projectHash="p" terminalId="tab-x" onOpenUrl={(url) => opened.push(url)} />);
    await attached();
    lines[0] = "  Local:   http://localhost:5173/  (press h to show help)";

    let links: { text: string; range: unknown; activate: (e: MouseEvent) => void }[] | undefined;
    linkProviders[0].provideLinks(1, (found) => (links = found));
    expect(links?.map((l) => l.text)).toEqual(["http://localhost:5173/"]);

    links![0].activate({ metaKey: false, ctrlKey: false } as MouseEvent);
    expect(opened, "a plain click is how you start selecting text").toEqual([]);
    links![0].activate({ metaKey: true, ctrlKey: false } as MouseEvent);
    expect(opened).toEqual(["http://localhost:5173/"]);
  });

  it("offers no link on a line without a local URL", async () => {
    render(<TerminalPane projectHash="p" terminalId="tab-x" />);
    await attached();
    lines[0] = "built in 412ms — see https://example.com";
    let links: unknown = "unset";
    linkProviders[0].provideLinks(1, (found) => (links = found));
    expect(links).toBeUndefined();
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

    const spawns = invokeMock.mock.calls
      .filter(([cmd]) => cmd === "terminal_spawn")
      .map(([, args]) => args as { projectHash: string; terminalId: string });
    for (const { projectHash, terminalId } of spawns) {
      expect(terminalId.startsWith(`${projectHash}:`), "a tab id must be spawned under its own project").toBe(true);
    }
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
