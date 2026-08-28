import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { open } from "@tauri-apps/plugin-dialog";
import "../App.css";

// App now reads Mantine's color-scheme context (theme-toggle wiring), so every
// render needs a MantineProvider ancestor — kept minimal here since these tests
// exercise behavior, not the app's real theme/token bridge (that lives in main.tsx).
const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

// The app now boots to the onboarding screen with nothing open — opening a
// project is the user's explicit act, the way every other IDE behaves. Most
// tests below exercise the shell, so they open the first recent project
// first. Tests that are *about* the onboarding screen use `render` alone.
//
// No rail panel defaults open either (D: "no default open on load") — most
// of these tests exercise the file tree/side panel, so this helper opens
// Explorer too. Tests about the closed-by-default state itself render
// without this helper's Explorer click.
const openProject = async () => {
  const rows = await screen.findAllByTestId("recent-project");
  fireEvent.click(rows[0]);
  await screen.findByTestId("shell-toggle");
  fireEvent.click(screen.getByTestId("rail-explorer"));
};

// No panel opens by default on project open (removed 2026-08-19) — tests that
// need the file tree visible open Explorer explicitly, the way a user would.
// Idempotent so repeated calls in one test don't toggle the panel back shut.
const openExplorerPanel = () => {
  if (!screen.queryByTestId("file-tree")) {
    fireEvent.click(screen.getByTestId("rail-explorer"));
  }
};

// The workspace picker moved out of the right rail and behind the Workspace
// icon on the shared left rail (Amendment 3 — the right rail is chat +
// threads only now). Idempotent so repeated calls in one test don't toggle
// the panel back shut.
const openWorkspacePanel = () => {
  if (!screen.queryByTestId("project-picker")) {
    fireEvent.click(screen.getByTestId("rail-workspace"));
  }
  return screen.getByTestId("project-picker");
};

// Mock Tauri APIs before importing App. Handlers are recorded so a test can
// deliver a backend event (`emit` below) rather than only assert on IPC calls.
const { listeners } = vi.hoisted(() => ({
  listeners: new Map<string, ((event: { payload: unknown }) => void)[]>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    return Promise.resolve(() => {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((h) => h !== handler)
      );
    });
  }),
}));

/** Deliver a backend event to whatever the app registered for it. */
const emit = (name: string, payload: unknown) => {
  for (const handler of listeners.get(name) ?? []) handler({ payload });
};

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: vi.fn(() => ({
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
  })),
}));

const { getCurrentWindowMock, mockWindow } = vi.hoisted(() => {
  const mockWindow = { startDragging: vi.fn(), toggleMaximize: vi.fn() };
  return { getCurrentWindowMock: vi.fn(() => mockWindow), mockWindow };
});

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: getCurrentWindowMock,
}));

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

// Mock the markdown editor (heavy dependency)
const { mdEditorMock, mdMarkdownMock } = vi.hoisted(() => {
  const mdMarkdownMock = ({ source }: { source: string }) => (
    <div>{source}</div>
  );
  const mdEditorMock = ({ value }: { value: string }) => (
    <div data-testid="md-editor">{value}</div>
  );
  // The real default export has `MDEditor.Markdown` as a property.
  (mdEditorMock as unknown as { Markdown: typeof mdMarkdownMock }).Markdown =
    mdMarkdownMock;
  return { mdEditorMock, mdMarkdownMock };
});
vi.mock("@uiw/react-md-editor", () => ({
  default: mdEditorMock,
  MDEditor: { Markdown: mdMarkdownMock },
}));

vi.mock("../GraphPane", () => ({
  default: () => <div data-testid="graph-pane" />,
}));

import App from "../App";
import { clearDiagnostics, publishDiagnostics } from "../lspClients";

// The baseline IPC responses every test starts from. Tests that need one
// command to answer differently override just that command and delegate the
// rest here — a bare `Promise.resolve([])` fallback breaks the shell, since
// `preflight` and `switch_project` must return objects for App to render.
const defaultInvoke = (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          agents: [
            {
              id: "claude",
              label: "Claude Code",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
            {
              id: "codex",
              label: "Codex",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
          ],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "load_graphify") {
        return Promise.resolve({
          outDir: "",
          report: "",
          graph: null,
          summary: "",
        });
      }
      if (cmd === "list_directory") {
        const relativePath = String(args?.relativePath ?? "");
        if (relativePath === "") {
          return Promise.resolve([
            { name: "src", is_dir: true, path: "src" },
            { name: "AGENTS.md", is_dir: false, path: "AGENTS.md" },
          ]);
        }
        return Promise.resolve([]);
      }
      if (cmd === "read_file_content") return Promise.resolve("agent rules\n");
      if (cmd === "write_file_content") return Promise.resolve();
      if (cmd === "read_thread") return Promise.resolve([]);
      return Promise.resolve([]);
};

beforeEach(() => {
  listeners.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(defaultInvoke);
});

afterEach(() => {
  // The diagnostics store is module-level, so one test's problems would
  // otherwise show up in the next test's Problems tab.
  clearDiagnostics();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("Window shell (merged-design v2)", () => {
  it("renders the backdrop div in index.html", () => {
    // The backdrop is in index.html, outside React root.
    // We test that the body has the backdrop element.
    const backdrop = document.getElementById("backdrop");
    expect(backdrop).toBeDefined();
  });

  it("renders the .ds-window shell", async () => {
    render(<App />);
    await openProject();
    expect(screen.getByTestId("window-shell")).toBeDefined();
  });

  it("has 12px border-radius on the window shell", async () => {
    render(<App />);
    await openProject();
    const shell = screen.getByTestId("window-shell");
    const style = getComputedStyle(shell);
    expect(style.borderRadius).toBe("12px");
  });
});

describe("Top chrome (merged-design v2)", () => {
  it("renders at 36px height", async () => {
    render(<App />);
    await openProject();
    const chrome = screen.getByTestId("top-chrome");
    expect(getComputedStyle(chrome).height).toBe("36px");
  });

  it("has Spec/Go mode toggle in the chat composer", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_threads")
          return Promise.resolve([
            {
              id: "t1",
              projectHash: "proj-1",
              title: "Test Thread",
              createdAt: "2026-08-06T00:00:00Z",
              updatedAt: "2026-08-06T00:00:00Z",
              currentMode: "spec",
              openSpecChangeName: null,
              executorSessionId: null,
            },
          ]);
        return defaultInvoke(cmd, args);
      }
    );
    const { unmount } = render(<App />);
    await openProject();
    // The single thread auto-selects on load, so chat (and its composer) is
    // already visible in the Editor shell's right rail — no interaction needed.
    const modeSelector = await screen.findByTestId("mode-selector");
    expect(
      within(modeSelector).getByRole("radio", { name: /Spec/ })
    ).toBeDefined();
    expect(
      within(modeSelector).getByRole("radio", { name: /Go/ })
    ).toBeDefined();
    unmount();
  });

  it("does not show an executor badge in the utility cluster", async () => {
    render(<App />);
    await openProject();
    expect(screen.queryByTestId("preflight-status")).toBeNull();
  });

  it("starts dragging on a single mousedown, and toggles maximize on double-click, on the top chrome", async () => {
    mockWindow.startDragging.mockClear();
    mockWindow.toggleMaximize.mockClear();
    render(<App />);
    await openProject();
    const chrome = screen.getByTestId("top-chrome");

    fireEvent.mouseDown(chrome, { button: 0, detail: 1 });
    expect(mockWindow.startDragging).toHaveBeenCalledTimes(1);
    expect(mockWindow.toggleMaximize).not.toHaveBeenCalled();

    fireEvent.mouseDown(chrome, { button: 0, detail: 2 });
    expect(mockWindow.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("does not drag/maximize when mousedown originates on an excluded chrome button", async () => {
    mockWindow.startDragging.mockClear();
    render(<App />);
    await openProject();
    fireEvent.mouseDown(screen.getByTestId("toggle-terminal"), {
      button: 0,
      detail: 1,
    });
    expect(mockWindow.startDragging).not.toHaveBeenCalled();
  });

  it("shows a hover tooltip on top-chrome icon buttons instead of a native title attribute", async () => {
    render(<App />);
    await openProject();
    const button = screen.getByTestId("toggle-terminal");
    expect(button).not.toHaveAttribute("title");

    await userEvent.hover(button);
    expect(
      await screen.findByRole("tooltip", { name: /toggle terminal panel/i })
    ).toBeInTheDocument();
  });
});

describe("Run split button (shell-redesign Amendment 1)", () => {
  const withRun = (commands: [string, string][]) =>
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "run_commands") return Promise.resolve(commands);
        if (cmd === "detect_run_commands") return Promise.resolve([]);
        if (cmd === "terminal_input") return Promise.resolve();
        return defaultInvoke(cmd, args);
      }
    );

  it("runs the first configured command from the title bar, in the bottom panel's terminal", async () => {
    withRun([
      ["dev", "pnpm start"],
      ["test", "cargo test"],
    ]);
    render(<App />);
    await openProject();

    const button = await screen.findByTestId("run-primary");
    expect(button.textContent).toContain("dev");
    fireEvent.click(button);

    // The command reaches the shell, and the panel it prints into is open.
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("terminal_input", {
        // Tagged with a tab now that several shells can be open at once.
        terminalId: expect.any(String),
        data: "pnpm start\n",
      })
    );
    expect(screen.getByTestId("bottom-panel")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("bp-tab-terminal")).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("spawns the terminal before writing, so the first run is not swallowed", async () => {
    const order: string[] = [];
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "run_commands")
          return Promise.resolve([["dev", "pnpm start"]]);
        if (cmd === "detect_run_commands") return Promise.resolve([]);
        if (cmd === "terminal_spawn" || cmd === "terminal_input") {
          order.push(cmd);
          return Promise.resolve(null);
        }
        return defaultInvoke(cmd, args);
      }
    );
    render(<App />);
    await openProject();
    fireEvent.click(await screen.findByTestId("run-primary"));

    // Writing into a pty that hasn't been spawned yet errors with
    // "no terminal running" and the command is silently lost.
    await waitFor(() => expect(order).toContain("terminal_input"));
    expect(order.indexOf("terminal_spawn")).toBeLessThan(
      order.indexOf("terminal_input")
    );
  });

  it("remembers the command picked from the dropdown as the next primary action", async () => {
    withRun([
      ["dev", "pnpm start"],
      ["test", "cargo test"],
    ]);
    render(<App />);
    await openProject();

    fireEvent.click(await screen.findByTestId("run-menu"));
    fireEvent.click(await screen.findByTestId("run-opt-test"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("terminal_input", {
        terminalId: expect.any(String),
        data: "cargo test\n",
      })
    );
    await waitFor(() =>
      expect(screen.getByTestId("run-primary").textContent).toContain("test")
    );
  });

  it("is absent when the project has no run commands — nothing to run, no button", async () => {
    withRun([]);
    render(<App />);
    await openProject();
    await waitFor(() => expect(screen.queryByTestId("run-primary")).toBeNull());
  });

  it("shows the split button as soon as the Run panel adds the first command", async () => {
    const saved: [string, string][][] = [];
    let configured: [string, string][] = [];
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "run_commands") return Promise.resolve(configured);
        if (cmd === "detect_run_commands")
          return Promise.resolve([["dev", "pnpm run dev"]]);
        if (cmd === "save_run_commands") {
          configured = args?.commands as [string, string][];
          saved.push(configured);
          return Promise.resolve();
        }
        return defaultInvoke(cmd, args);
      }
    );
    render(<App />);
    await openProject();
    expect(screen.queryByTestId("run-primary")).toBeNull();

    fireEvent.click(screen.getByTestId("rail-run"));
    fireEvent.click(await screen.findByTestId("run-accept-dev"));

    // The title bar reads the same config; adding one there must not need a
    // reload to show up here.
    expect(await screen.findByTestId("run-primary")).toBeDefined();
  });

  it("hosts the debugger alongside run and verify, not on a tenth rail icon", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "run_commands") return Promise.resolve([["dev", "pnpm start"]]);
      if (cmd === "detect_run_commands") return Promise.resolve([]);
      if (cmd === "debug_adapter")
        return Promise.resolve({
          language: "rust",
          command: "lldb-dap",
          args: [],
          installed: true,
        });
      if (cmd === "debug_status")
        return Promise.resolve({
          sessionId: null,
          language: null,
          stopped: null,
          breakpoints: {},
        });
      return defaultInvoke(cmd, args);
    });
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("rail-run"));
    expect(await screen.findByTestId("debug-start")).toBeDefined();
  });

  it("marks test results stale when an agent writes to disk, not just on a manual save", async () => {
    // Dogfood regression: staleness was driven only by the editor's own save
    // handler. In Palisade an agent turn writes the file directly — the most
    // common way code changes here — and the explorer went on presenting
    // results for code that no longer existed.
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "verify_commands") return Promise.resolve([["test", "pytest"]]);
      if (cmd === "list_verifications")
        return Promise.resolve([
          {
            id: "v1",
            projectHash: "p1",
            threadId: null,
            sessionId: null,
            name: "test",
            command: "pytest",
            exitCode: 1,
            outputTail: "",
            gitHead: null,
            // Long past, so any "now" beats it.
            at: "2020-01-01T00:00:00Z",
            tests: {
              framework: "pytest",
              parsed: true,
              unexplainedFailure: false,
              cases: [
                { name: "a", status: "failed", file: "app.py", line: 3, message: "boom" },
              ],
            },
          },
        ]);
      return defaultInvoke(cmd, args);
    });
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("toggle-terminal"));
    fireEvent.click(screen.getByTestId("bp-tab-tests"));
    expect(await screen.findByTestId("test-case-a")).toBeDefined();
    expect(screen.queryByTestId("test-stale")).toBeNull();

    act(() =>
      emit("fs-changed", { projectHash: "proj-1", paths: ["app.py"] })
    );

    expect(await screen.findByTestId("test-stale")).toBeDefined();
    // Still shown: hiding them loses the last thing actually known.
    expect(screen.getByTestId("test-case-a")).toBeDefined();
  });

  it("shows the adapter's breakpoint verdict in the editor gutter once a session binds it", async () => {
    // Dogfood gap: DebugPanel reported the verdicts and its own test proved
    // it, but the prop was never wired up in App — so the gutter went on
    // drawing a bound breakpoint as "not yet asked". A panel-level test
    // cannot catch a missing wire; this one can.
    const bp = (verified: boolean | null) => ({
      path: "app.py",
      line: 8,
      enabled: true,
      condition: null,
      verified,
      actualLine: null,
      message: null,
    });
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "run_commands") return Promise.resolve([["app", "python3 app.py"]]);
      if (cmd === "detect_run_commands") return Promise.resolve([]);
      if (cmd === "debug_breakpoints") return Promise.resolve({ "app.py": [bp(null)] });
      if (cmd === "list_directory")
        return Promise.resolve([{ name: "app.py", is_dir: false, path: "app.py" }]);
      if (cmd === "read_file_content") return Promise.resolve("def subtotal():\n    pass\n");
      if (cmd === "debug_adapter")
        return Promise.resolve({
          language: "python",
          command: "debugpy-adapter",
          args: [],
          installed: true,
        });
      if (cmd === "debug_launch_options")
        return Promise.resolve([
          { name: "app", command: "python3 app.py", configuration: { program: "app.py" } },
        ]);
      if (cmd === "debug_status")
        return Promise.resolve({
          sessionId: null,
          language: null,
          stopped: null,
          breakpoints: { "app.py": [bp(null)] },
        });
      if (cmd === "debug_start")
        return Promise.resolve({
          sessionId: "s1",
          language: "python",
          stopped: null,
          breakpoints: { "app.py": [bp(true)] },
        });
      return defaultInvoke(cmd, args);
    });
    render(<App />);
    await openProject();
    // Which adapter to offer follows the file in focus, so a Python file has
    // to be open before there is anything to start.
    openExplorerPanel();
    fireEvent.click(await screen.findByText("app.py"));

    fireEvent.click(screen.getByTestId("rail-run"));
    const start = await screen.findByTestId("debug-start");
    await waitFor(() => expect(start).not.toBeDisabled());
    fireEvent.click(start);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("debug_start", expect.anything())
    );
    // The App must take the adapter's verdicts, not leave the disk copy —
    // which is deliberately stripped of them — in place.
    await waitFor(() => expect(screen.getByTestId("debug-running")).toBeDefined());
  });

  it("keeps Start enabled after the breakpointed file's tab closes", async () => {
    // DEB-08 dogfood regression: Start's availability followed the focused
    // tab's language. Set a breakpoint in app.py, close that tab so no file
    // is selected, and Start must still be enabled — a valid Run
    // Configuration and breakpoint still exist, just not in a visible tab.
    const bp = (verified: boolean | null) => ({
      path: "app.py",
      line: 8,
      enabled: true,
      condition: null,
      verified,
      actualLine: null,
      message: null,
    });
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "run_commands") return Promise.resolve([["app", "python3 app.py"]]);
      if (cmd === "detect_run_commands") return Promise.resolve([]);
      if (cmd === "debug_breakpoints") return Promise.resolve({ "app.py": [bp(null)] });
      if (cmd === "list_directory")
        return Promise.resolve([{ name: "app.py", is_dir: false, path: "app.py" }]);
      if (cmd === "read_file_content") return Promise.resolve("def subtotal():\n    pass\n");
      if (cmd === "debug_adapter")
        return Promise.resolve({
          language: "python",
          command: "debugpy-adapter",
          args: [],
          installed: true,
        });
      if (cmd === "debug_launch_options")
        return Promise.resolve([
          { name: "app", command: "python3 app.py", configuration: { program: "app.py" } },
        ]);
      if (cmd === "debug_status")
        return Promise.resolve({
          sessionId: null,
          language: null,
          stopped: null,
          breakpoints: { "app.py": [bp(null)] },
        });
      return defaultInvoke(cmd, args);
    });
    render(<App />);
    await openProject();
    openExplorerPanel();
    fireEvent.click(await screen.findByText("app.py"));

    fireEvent.click(screen.getByTestId("rail-run"));
    const start = await screen.findByTestId("debug-start");
    await waitFor(() => expect(start).not.toBeDisabled());

    // Close the only open tab — no file is focused any more.
    const tab = screen.getByTestId("file-tab");
    fireEvent.click(within(tab).getByTestId("file-tab-close"));
    await waitFor(() => expect(screen.queryByTestId("file-tab")).toBeNull());

    expect(screen.getByTestId("debug-start")).not.toBeDisabled();
  });

  it("opens run configuration from the rail's Run icon", async () => {
    withRun([["dev", "pnpm start"]]);
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("rail-run"));
    expect(await screen.findByTestId("run-row-dev")).toBeDefined();
  });
});

describe("New thread always starts a new thread", () => {
  const withThreads = () =>
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "preflight")
          return Promise.resolve({
            agents: [{ id: "claude", name: "Claude Code", cmd: "claude" }],
            selected: "claude",
            openspec: true,
            grillApply: true,
            ponytail: true,
            graphify: true,
            ready: true,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        return defaultInvoke(cmd, args);
      }
    );

  it("returns to the mode picker after Go was picked but nothing was sent", async () => {
    withThreads();
    render(<App />);
    await openProject();

    // Pick Go: the composer opens, no thread created yet.
    fireEvent.click(await screen.findByTestId("pick-go"));
    expect(await screen.findByTestId("composer-input")).toBeDefined();

    // New thread must start over. It used to do nothing at all here: the
    // leftover pending mode outranked the picker in the render condition,
    // so every "New thread" button looked broken.
    fireEvent.click(screen.getByTestId("rail-history"));
    fireEvent.click(await screen.findByTestId("new-thread"));
    expect(await screen.findByTestId("mode-picker")).toBeDefined();
  });

  it("picking Go on a new thread does not reopen the thread you were reading", async () => {
    // The picker used to render *over* the selected thread without
    // deselecting it, so Go fell straight through to that thread's history —
    // the new draft vanished and an older conversation took its place.
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_threads")
          return Promise.resolve([
            {
              id: "t1",
              projectHash: "proj-1",
              title: "Older conversation",
              createdAt: "2026-08-06T00:00:00Z",
              updatedAt: "2026-08-06T00:00:00Z",
              currentMode: "go",
              openSpecChangeName: null,
            },
          ]);
        if (cmd === "read_thread")
          return Promise.resolve([
            {
              seq: 1,
              ts: "2026-08-06T00:00:00Z",
              role: "user",
              mode: "go",
              content: "what did we do yesterday",
            },
          ]);
        if (cmd === "preflight")
          return Promise.resolve({
            agents: [{ id: "claude", name: "Claude Code", cmd: "claude" }],
            selected: "claude",
            openspec: true,
            grillApply: true,
            ponytail: true,
            graphify: true,
            ready: true,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        return defaultInvoke(cmd, args);
      }
    );
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent(
        "Older conversation"
      )
    );

    fireEvent.click(screen.getByTestId("rail-history"));
    fireEvent.click(await screen.findByTestId("new-thread"));
    fireEvent.click(await screen.findByTestId("pick-go"));

    // An empty composer for a thread that doesn't exist yet — not the old
    // thread's messages.
    expect(await screen.findByTestId("composer-input")).toBeDefined();
    expect(screen.queryByText("what did we do yesterday")).toBeNull();
    expect(screen.getByTestId("thread-title")).toHaveTextContent("New thread");
  });

  it("returns to the mode picker after Spec's framing menu was opened", async () => {
    withThreads();
    render(<App />);
    await openProject();

    fireEvent.click(await screen.findByTestId("pick-spec"));
    expect(await screen.findByTestId("spec-type-picker")).toBeDefined();

    fireEvent.click(screen.getByTestId("rail-history"));
    fireEvent.click(await screen.findByTestId("new-thread"));
    expect(await screen.findByTestId("mode-picker")).toBeDefined();
  });
});

describe("Picking a provider/model before the thread exists", () => {
  it("remembers the choice instead of silently doing nothing", async () => {
    // Picking "Go" shows the composer before any thread exists (D20's
    // deferred empty composer). Its provider/model pickers used to return
    // early there: the menu closed, the label never changed, and nothing
    // was written anywhere.
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "list_models")
          return Promise.resolve({
            configId: "model",
            current: "opus",
            models: [
              { id: "opus", name: "Opus" },
              { id: "sonnet", name: "Sonnet" },
            ],
          });
        if (cmd === "preflight")
          return Promise.resolve({
            agents: [{ id: "claude", name: "Claude Code", cmd: "claude" }],
            selected: "claude",
            openspec: true,
            grillApply: true,
            ponytail: true,
            graphify: true,
            ready: true,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        return defaultInvoke(cmd, args);
      }
    );
    render(<App />);
    await openProject();

    fireEvent.click(await screen.findByTestId("pick-go"));
    fireEvent.click(await screen.findByTestId("model-btn"));
    fireEvent.click(await screen.findByTestId("model-opt-sonnet"));

    await waitFor(() =>
      expect(screen.getByTestId("model-btn")).toHaveTextContent("Sonnet")
    );
    // Nothing to persist onto yet: the choice rides along and is written
    // when the thread is created, as the new-thread menu already does.
    expect(invokeMock).not.toHaveBeenCalledWith(
      "set_thread_executor",
      expect.anything()
    );
  });

  it("writes that choice onto the thread the first send creates", async () => {
    // The Spec path persisted the framing pick; Go's deferred thread never
    // did, so a Go turn silently ran on the auto-detected agent's default
    // model — Sonnet, however loudly the composer said otherwise.
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "list_models")
          return Promise.resolve({
            configId: "model",
            current: "opus",
            models: [
              { id: "opus", name: "Opus" },
              { id: "sonnet", name: "Sonnet" },
            ],
          });
        if (cmd === "preflight")
          return Promise.resolve({
            agents: [{ id: "claude", name: "Claude Code", cmd: "claude" }],
            selected: "claude",
            openspec: true,
            grillApply: true,
            ponytail: true,
            graphify: true,
            ready: true,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        if (cmd === "create_thread")
          return Promise.resolve({
            id: "t-new",
            projectHash: "proj-1",
            title: "New thread",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "go",
            openSpecChangeName: null,
          });
        if (cmd === "set_thread_mode" || cmd === "set_thread_executor")
          return Promise.resolve({
            id: "t-new",
            projectHash: "proj-1",
            title: "New thread",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "go",
            openSpecChangeName: null,
            executor: "claude",
            model: "sonnet",
          });
        if (cmd === "send_message")
          return Promise.resolve({
            seq: 1,
            role: "user",
            content: "build it",
            ts: "2026-08-06T00:00:00Z",
          });
        return defaultInvoke(cmd, args);
      }
    );
    render(<App />);
    await openProject();

    fireEvent.click(await screen.findByTestId("pick-go"));
    fireEvent.click(await screen.findByTestId("model-btn"));
    fireEvent.click(await screen.findByTestId("model-opt-sonnet"));
    await waitFor(() =>
      expect(screen.getByTestId("model-btn")).toHaveTextContent("Sonnet")
    );

    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "build it" },
    });
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_thread_executor", {
        projectHash: "proj-1",
        threadId: "t-new",
        executor: "claude",
        model: "sonnet",
      })
    );
  });
});

describe("Running a chain from the deferred composer", () => {
  it("creates the thread the chain needs instead of silently doing nothing", async () => {
    // `|=<chain>` used to bail on `!thread` before the D20 creation block
    // below it ever ran, so the very first thing typed into a go-mode
    // composer — the one case where no thread exists yet — cleared the
    // input and did nothing at all: no run, no error, no message.
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "list_chains")
          return Promise.resolve([
            {
              name: "ship",
              nodes: {
                designer: { role: "designer", guideline: "", agent: "claude" },
              },
              edges: [],
              entry: "designer",
            },
          ]);
        if (cmd === "preflight")
          return Promise.resolve({
            agents: [{ id: "claude", name: "Claude Code", cmd: "claude" }],
            selected: "claude",
            openspec: true,
            grillApply: true,
            ponytail: true,
            graphify: true,
            ready: true,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        if (cmd === "create_thread" || cmd === "set_thread_mode")
          return Promise.resolve({
            id: "t-new",
            projectHash: "proj-1",
            title: "New thread",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "go",
            openSpecChangeName: null,
          });
        if (cmd === "run_chain") return Promise.resolve("run-1");
        return defaultInvoke(cmd, args);
      }
    );
    render(<App />);
    await openProject();

    fireEvent.click(await screen.findByTestId("pick-go"));
    fireEvent.change(await screen.findByTestId("composer-input"), {
      target: { value: "|=ship add a --shout flag" },
    });
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("run_chain", {
        projectHash: "proj-1",
        chainName: "ship",
        seedInput: "add a --shout flag",
        threadId: "t-new",
      })
    );
    // The seed is the chain's input, not a chat turn — it must not also be
    // sent to the agent as an ordinary message.
    expect(invokeMock).not.toHaveBeenCalledWith(
      "send_message",
      expect.anything()
    );
  });
});

describe("Collapsing chat (Cmd+J)", () => {
  it("leaves Vibe's chat alone — it is the primary surface there", async () => {
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await screen.findByTestId("vibe-shell");

    // No toggle to hide it with, and Cmd+J can't either: Vibe without chat
    // is just Editor with the panels on the wrong side.
    expect(screen.queryByTestId("toggle-chat")).toBeNull();
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(screen.getByTestId("right-sidebar")).toBeDefined();
    expect(screen.getByTestId("vibe-shell")).not.toHaveAttribute("data-chat");
  });
});

describe("Resize handles (one per row)", () => {
  it("keeps each handle in its own row, so the sidebar edge is grabbable", async () => {
    render(<App />);
    await openProject();
    openExplorerPanel();
    const sidebarHandle = screen.getByTestId("resize-left-rail");
    const chatHandle = screen.getByTestId("resize-right-panel");

    // Ordering every `.ds-resize-handle-x` together stacked the chat handle
    // on top of the sidebar's, so dragging the sidebar edge resized chat.
    expect(sidebarHandle.parentElement).toHaveClass("ds-shell-contents");
    expect(chatHandle.parentElement).toHaveClass("ds-work-row");
    expect(sidebarHandle.parentElement).not.toBe(chatHandle.parentElement);
  });
});

describe("Status bar (mockup parity)", () => {
  it("spans the shell, below the bottom panel, in both presets", async () => {
    render(<App />);
    await openProject();
    const bar = screen.getByTestId("editor-status-bar");
    // Outside the editor column: it reports on the whole window, and the
    // mockup puts it under the bottom panel, full width.
    expect(bar.closest(".ds-editor-col")).toBeNull();
    expect(bar.closest(".ds-window")).not.toBeNull();

    fireEvent.click(screen.getByTestId("shell-vibe"));
    expect(screen.getByTestId("editor-status-bar")).toBeDefined();
  });

  it("shows the cursor position once a file is open, and nothing before", async () => {
    render(<App />);
    await openProject();
    openExplorerPanel();
    expect(screen.queryByTestId("cursor-position")).toBeNull();

    fireEvent.click(await screen.findByText("AGENTS.md"));
    expect(await screen.findByTestId("cursor-position")).toHaveTextContent(
      /Ln \d+, Col \d+/
    );
  });
});

describe("Chat column width per preset (Governing Rule)", () => {
  const chatWidth = () =>
    screen.getByTestId("right-sidebar").style.getPropertyValue("--panel-w");

  it("gives Vibe a wide chat and Editor a narrow one", async () => {
    render(<App />);
    await openProject();
    // Editor: the code is the subject, chat is the sidekick.
    expect(chatWidth()).toBe("300px");

    fireEvent.click(screen.getByTestId("shell-vibe"));
    // Vibe: the conversation is the subject.
    expect(chatWidth()).toBe("520px");

    fireEvent.click(screen.getByTestId("shell-editor"));
    expect(chatWidth()).toBe("300px");
  });

  it("remembers each preset's width separately", async () => {
    localStorage.setItem(
      "palisade:layout:proj-1:right",
      JSON.stringify({ size: 340, collapsed: false })
    );
    localStorage.setItem(
      "palisade:layout:proj-1:vibe-chat",
      JSON.stringify({ size: 700, collapsed: false })
    );
    render(<App />);
    await openProject();
    expect(chatWidth()).toBe("340px");
    fireEvent.click(screen.getByTestId("shell-vibe"));
    expect(chatWidth()).toBe("700px");
  });
});

describe("Bottom panel (shell-redesign Phase 2)", () => {
  it("starts collapsed and opens on the chrome toggle, with Terminal active", async () => {
    render(<App />);
    await openProject();
    expect(screen.getByTestId("bottom-panel")).toHaveAttribute("hidden");

    fireEvent.click(screen.getByTestId("toggle-terminal"));
    expect(screen.getByTestId("bottom-panel")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("bp-tab-terminal")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(await screen.findByTestId("terminal-pane")).toBeDefined();
  });

  it("counts problems on the tab, so a diagnostic is visible without opening it", async () => {
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("toggle-terminal"));
    expect(screen.queryByTestId("bp-problem-count")).toBeNull();

    act(() =>
      publishDiagnostics("file:///p/a.ts", [
        {
          path: "a.ts",
          line: 1,
          severity: "error",
          message: "boom",
          source: null,
        },
      ])
    );
    expect(screen.getByTestId("bp-problem-count")).toHaveTextContent("1");
  });

  it("keeps the terminal alive while the Problems tab is showing", async () => {
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("toggle-terminal"));
    await screen.findByTestId("terminal-pane");

    fireEvent.click(screen.getByTestId("bp-tab-problems"));
    expect(screen.getByTestId("problems-empty")).toBeDefined();
    // Unmounting would kill the shell process and everything running in it.
    expect(screen.getByTestId("terminal-pane")).toBeDefined();

    fireEvent.click(screen.getByTestId("bp-tab-terminal"));
    expect(screen.queryByTestId("problems-empty")).toBeNull();
    expect(screen.getByTestId("terminal-pane")).toBeDefined();
  });

  it("has a Tests tab that shows per-test results from the latest verify run", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "verify_commands") return Promise.resolve([["test", "cargo test"]]);
      if (cmd === "list_verifications")
        return Promise.resolve([
          {
            id: "v1",
            projectHash: "p1",
            threadId: null,
            sessionId: null,
            name: "test",
            command: "cargo test",
            exitCode: 101,
            outputTail: "running 2 tests",
            gitHead: "abcdef1234567890",
            at: "2026-08-26T10:00:00Z",
            tests: {
              framework: "cargo",
              parsed: true,
              unexplainedFailure: false,
              cases: [
                { name: "tests::ok", status: "passed", file: "src/lib.rs", line: null, message: null },
                {
                  name: "tests::bad",
                  status: "failed",
                  file: "src/lib.rs",
                  line: 9,
                  message: "left != right",
                },
              ],
            },
          },
        ]);
      return defaultInvoke(cmd, args);
    });
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("toggle-terminal"));
    fireEvent.click(screen.getByTestId("bp-tab-tests"));

    expect(await screen.findByTestId("test-case-tests::bad")).toHaveAttribute(
      "data-status",
      "failed"
    );
    // The terminal keeps running behind the tab, as it does behind Problems.
    expect(screen.getByTestId("terminal-pane")).toBeDefined();
  });

  it("shows how many tests failed on the Tests tab itself", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "verify_commands") return Promise.resolve([["test", "cargo test"]]);
      if (cmd === "list_verifications")
        return Promise.resolve([
          {
            id: "v1",
            projectHash: "p1",
            threadId: null,
            sessionId: null,
            name: "test",
            command: "cargo test",
            exitCode: 101,
            outputTail: "",
            gitHead: null,
            at: "2026-08-26T10:00:00Z",
            tests: {
              framework: "cargo",
              parsed: true,
              unexplainedFailure: false,
              cases: [
                { name: "a", status: "failed", file: null, line: null, message: null },
                { name: "b", status: "errored", file: null, line: null, message: null },
                { name: "c", status: "passed", file: null, line: null, message: null },
              ],
            },
          },
        ]);
      return defaultInvoke(cmd, args);
    });
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("toggle-terminal"));
    expect(await screen.findByTestId("bp-test-count")).toHaveTextContent("2");
  });

  it("collapses again from the panel's own chevron", async () => {
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("toggle-terminal"));
    fireEvent.click(screen.getByTestId("bp-collapse"));
    expect(screen.getByTestId("bottom-panel")).toHaveAttribute("hidden");
  });
});

describe("Left icon rail (shell-redesign Amendment 3)", () => {
  it("mounts the rail with all nine panel icons", async () => {
    render(<App />);
    await openProject();
    const rail = screen.getByTestId("nav-rail");
    for (const id of [
      "explorer",
      "search",
      "git",
      "specs",
      "codemap",
      "run",
      "history",
      "workspace",
      "settings",
    ]) {
      expect(within(rail).getByTestId(`rail-${id}`)).toBeDefined();
    }
  });

  it("opens no panel by default, opens Explorer on click, and closes it on a second click", async () => {
    render(<App />);
    const rows = await screen.findAllByTestId("recent-project");
    fireEvent.click(rows[0]);
    await screen.findByTestId("shell-toggle");
    expect(screen.queryByTestId("side-panel")).toBeNull();

    fireEvent.click(screen.getByTestId("rail-explorer"));
    await waitFor(() => expect(screen.getByTestId("file-tree")).toBeDefined());
    expect(screen.getByTestId("side-panel")).toHaveAttribute(
      "data-panel",
      "explorer"
    );

    fireEvent.click(screen.getByTestId("rail-explorer"));
    expect(screen.queryByTestId("side-panel")).toBeNull();
  });

  it("swaps panels rather than stacking them", async () => {
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("rail-git"));
    expect(screen.getByTestId("side-panel")).toHaveAttribute(
      "data-panel",
      "git"
    );
    expect(screen.queryByTestId("file-tree")).toBeNull();
  });

  // Governing Rule: the panel inventory is identical in both presets, so an
  // open panel survives a preset switch instead of resetting.
  it("keeps the open panel when switching Vibe/Editor", async () => {
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("rail-specs"));
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() =>
      expect(screen.getByTestId("side-panel")).toHaveAttribute(
        "data-panel",
        "specs"
      )
    );
    fireEvent.click(screen.getByTestId("shell-editor"));
    expect(screen.getByTestId("side-panel")).toHaveAttribute(
      "data-panel",
      "specs"
    );
  });

  // Dogfood gap: the commit box says "commit on main" from a branch list read
  // once at project-open, so an agent turn that switches branches leaves the
  // UI naming the wrong branch on a write action. The branch has to ride the
  // same refresh the dirty dot does.
  it("renames the commit target when the branch changes under it", async () => {
    let current = "main";
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "git_branches")
          return Promise.resolve([
            { name: current, isCurrent: true, isRemote: false },
          ]);
        return defaultInvoke(cmd, args);
      }
    );
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("rail-git"));
    const box = () =>
      screen
        .getAllByRole("textbox")
        .find((el) => /commit on/.test(el.getAttribute("placeholder") ?? ""))!;
    await waitFor(() =>
      expect(box().getAttribute("placeholder")).toContain("commit on main")
    );

    current = "dogfood-branch";
    act(() => emit("fs-changed", { projectHash: "proj-1", paths: ["a.ts"] }));

    await waitFor(() =>
      expect(box().getAttribute("placeholder")).toContain(
        "commit on dogfood-branch"
      )
    );
  });

  it("shows a rail dot on Source Control when the tree is dirty", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "git_status")
          return Promise.resolve([{ path: "a.ts", code: " M" }]);
        return defaultInvoke(cmd, args);
      }
    );
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(
        screen.getByTestId("rail-git").querySelector(".ds-rail-dot")
      ).not.toBeNull()
    );
  });
});

describe("Right rail — chat only (shell-redesign Amendment 3)", () => {
  it("holds the chat surface and no file explorer or specs list", async () => {
    render(<App />);
    await openProject();
    const chat = screen.getByTestId("right-sidebar");
    expect(within(chat).queryByTestId("file-tree")).toBeNull();
    expect(within(chat).queryByTestId("project-picker")).toBeNull();
    expect(within(chat).queryByTestId("spec-pane")).toBeNull();
  });

  it("reaches the workspace picker from the Account rail icon", async () => {
    render(<App />);
    await openProject();
    await waitFor(() => expect(openWorkspacePanel()).toHaveValue("proj-1"));
  });

  it("reaches the thread list and New Thread from the History rail icon", async () => {
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("rail-history"));
    expect(screen.getByTestId("thread-list")).toBeDefined();
    expect(screen.getByTestId("new-thread")).toBeDefined();
  });
});

describe("Editor chrome (merged-design v2)", () => {
  it("renders editor tabs", async () => {
    render(<App />);
    await openProject();
    expect(screen.getByTestId("editor-tabs")).toBeDefined();
  });

  it("reaches the diff through a button, not a tab competing with the open files", async () => {
    render(<App />);
    await openProject();
    // The tab strip belongs to the files being edited; the diff is a view
    // you toggle into from the far right of it.
    expect(screen.getByTestId("toggle-diff")).toBeDefined();
    expect(screen.queryByTestId("tab-diff")).toBeNull();
    expect(screen.queryByTestId("tab-chat")).toBeNull();
  });

  it("starts on the editor with the diff toggle unpressed and no files open", async () => {
    render(<App />);
    await openProject();
    expect(screen.getByTestId("toggle-diff")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.queryAllByTestId("file-tab")).toHaveLength(0);
  });

  it("renders breadcrumbs", async () => {
    render(<App />);
    await openProject();
    // Breadcrumbs live in the editor toolbar, so they appear once a file is
    // open — the leading segment is the project name.
    openExplorerPanel();
    fireEvent.click(await screen.findByText("AGENTS.md"));
    await waitFor(() =>
      expect(screen.getByTestId("breadcrumbs").textContent).toContain(
        "AGENTS.md"
      )
    );
  });

  it("has no leftover status bar", async () => {
    render(<App />);
    await openProject();
    expect(screen.queryByTestId("status-bar")).toBeNull();
  });

  it("shows the file editor even when no thread exists", async () => {
    render(<App />);
    await openProject();

    openExplorerPanel();
    // The tree container mounts before its root listing resolves, so wait
    // for the entry rather than for its parent.
    fireEvent.click(await screen.findByText("AGENTS.md"));

    await waitFor(() =>
      expect(screen.getByTestId("file-editor")).toBeDefined()
    );
    await waitFor(() =>
      expect(document.querySelector(".cm-content")).not.toBeNull()
    );
    // "Create a thread to get started" is legitimate in the right panel's Threads tab now
    // (chat lives there) — only assert it doesn't bleed into the center Editor pane.
    expect(
      within(screen.getByTestId("main-pane")).queryByText(
        "Create a thread to get started."
      )
    ).toBeNull();
  });

  it("offers the Go/Spec picker instead of a blank chat when no thread is open", async () => {
    // Threads exist, none is selected — the state left behind by closing the
    // last thread tab. "Create a thread to get started." is a dead end here;
    // the next step is picking a mode, so show that instead.
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_threads")
          return Promise.resolve([
            {
              id: "t1",
              projectHash: "proj-1",
              title: "Test Thread",
              createdAt: "2026-08-06T00:00:00Z",
              updatedAt: "2026-08-06T00:00:00Z",
              currentMode: "go",
              openSpecChangeName: null,
              executorSessionId: null,
            },
          ]);
        return defaultInvoke(cmd, args);
      }
    );
    render(<App />);
    await openProject();

    await screen.findByTestId("thread-tab");
    fireEvent.click(screen.getByTestId("thread-tab-close"));

    await screen.findByTestId("mode-picker");
    expect(screen.getByTestId("pick-go")).toBeDefined();
    expect(screen.getByTestId("pick-spec")).toBeDefined();
    expect(screen.queryByText("Create a thread to get started.")).toBeNull();
  });

  it("shows the diff empty state even when no thread exists", async () => {
    render(<App />);
    await openProject();

    await waitFor(() =>
      expect(screen.getByTestId("editor-tabs")).toBeDefined()
    );
    fireEvent.click(screen.getByTestId("toggle-diff"));

    await waitFor(() => {
      expect(
        within(screen.getByTestId("main-pane")).queryByText(
          "Create a thread to get started."
        )
      ).toBeNull();
      expect(screen.getByText(/no file changes/i)).toBeDefined();
    });
  });
});

describe("Settings panel (D14/D15)", () => {
  it("opens the settings panel with color scheme and font controls", async () => {
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );
    fireEvent.click(screen.getByTestId("open-settings"));

    expect(screen.getByTestId("settings-panel")).toBeDefined();
    expect(screen.getAllByTestId("accent-swatch").length).toBeGreaterThan(0);
    expect(screen.getByTestId("editor-font-select")).toBeDefined();
  });

  it("opens an existing .palisade/project-settings.json in the editor without recreating it", async () => {
    const writeCalls: unknown[] = [];
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/palisade-code",
              displayName: "palisade-code",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              {
                id: "claude",
                label: "Claude Code",
                path: "/usr/local/bin/claude",
                skillsOk: true,
                pluginOk: true,
              },
              {
                id: "codex",
                label: "Codex",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
            ],
            selected: "claude",
            openspec: true,
            grillApply: false,
            ponytail: true,
            graphify: true,
            ready: true,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "read_file_content")
          return Promise.resolve('{"formatOnSave":{}}');
        if (cmd === "write_file_content") writeCalls.push(args);
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );
    fireEvent.click(screen.getByTestId("open-settings"));
    fireEvent.click(screen.getByTestId("open-project-settings"));

    await waitFor(() =>
      expect(screen.getByTestId("breadcrumbs").textContent).toContain(
        ".palisade/project-settings.json"
      )
    );
    expect(writeCalls).toHaveLength(0);
  });

  it("creates .palisade/project-settings.json with defaults when none exists yet", async () => {
    const writeCalls: Record<string, unknown>[] = [];
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/palisade-code",
              displayName: "palisade-code",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              {
                id: "claude",
                label: "Claude Code",
                path: "/usr/local/bin/claude",
                skillsOk: true,
                pluginOk: true,
              },
              {
                id: "codex",
                label: "Codex",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
            ],
            selected: "claude",
            openspec: true,
            grillApply: false,
            ponytail: true,
            graphify: true,
            ready: true,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "read_file_content")
          return Promise.reject(new Error("no such file"));
        if (cmd === "write_file_content") {
          writeCalls.push(args ?? {});
          return Promise.resolve(null);
        }
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );
    fireEvent.click(screen.getByTestId("open-settings"));
    fireEvent.click(screen.getByTestId("open-project-settings"));

    await waitFor(() => expect(writeCalls).toHaveLength(1));
    expect(writeCalls[0].relativePath).toBe(".palisade/project-settings.json");
    expect(String(writeCalls[0].content)).toContain("formatOnSave");
    await waitFor(() =>
      expect(screen.getByTestId("breadcrumbs").textContent).toContain(
        ".palisade/project-settings.json"
      )
    );
  });
});

describe("Right sidebar (merged-design v2)", () => {
  it("renders right sidebar", async () => {
    render(<App />);
    await openProject();
    expect(screen.getByTestId("right-sidebar")).toBeDefined();
  });

  it("has no leftover right-rail tab strip — each panel is its own rail icon", async () => {
    render(<App />);
    await openProject();
    expect(screen.queryByTestId("tab-threads")).toBeNull();
    expect(screen.queryByTestId("tab-codemap")).toBeNull();
    expect(screen.queryByTestId("tab-notes")).toBeNull();
  });

  it("has no leftover Files tab (superseded by the file explorer column)", async () => {
    render(<App />);
    await openProject();
    expect(screen.queryByTestId("tab-files")).toBeNull();
  });

  it("is open by default at 300px (D57 — Workspace + Threads are load-bearing, not optional)", async () => {
    render(<App />);
    await openProject();
    const sidebar = screen.getByTestId("right-sidebar");
    expect(sidebar.style.getPropertyValue("--panel-w")).toBe("300px");
    expect(screen.getByTestId("resize-right-panel")).toBeDefined();
  });

  // Amendment 9: the chat toggle is Editor-preset only — Vibe's chat is the
  // primary surface and already has the session-list toggle.
  it("collapses the chat rail via the toggle and restores on a second click", async () => {
    render(<App />);
    await openProject();
    const toggle = screen.getByTestId("toggle-chat");

    fireEvent.click(toggle);
    expect(screen.queryByTestId("right-sidebar")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByTestId("right-sidebar")).toBeDefined();
  });

  it("offers the chat toggle in Editor only", async () => {
    // Vibe's chat is the subject of the preset, not a panel — collapsing it
    // there leaves the user staring at an editor they came to Vibe to avoid.
    render(<App />);
    await openProject();
    expect(screen.getByTestId("toggle-chat")).toBeDefined();

    fireEvent.click(screen.getByTestId("shell-vibe"));
    await screen.findByTestId("vibe-shell");
    expect(screen.queryByTestId("toggle-chat")).toBeNull();
  });

  it("sizes Vibe's chat from its own resizable, so the handle actually works", async () => {
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await screen.findByTestId("vibe-shell");

    const sidebar = screen.getByTestId("right-sidebar");
    expect(sidebar.style.getPropertyValue("--panel-w")).toBe("520px");

    const handle = screen.getByTestId("resize-right-panel");
    fireEvent.pointerDown(handle, { clientX: 700 });
    fireEvent.pointerMove(window, { clientX: 760, buttons: 1 });
    fireEvent.pointerUp(window);

    expect(
      screen.getByTestId("right-sidebar").style.getPropertyValue("--panel-w")
    ).toBe("580px");
  });
});

describe("Resizable layout persistence", () => {
  it("persists side-panel width via drag and rehydrates on remount", async () => {
    const { unmount } = render(<App />);
    await openProject();
    openExplorerPanel();

    fireEvent.pointerDown(screen.getByTestId("resize-left-rail"), {
      clientX: 200,
    });
    fireEvent.pointerMove(window, { clientX: 260, buttons: 1 });
    fireEvent.pointerUp(window);
    expect(
      screen.getByTestId("side-panel").style.getPropertyValue("--panel-w")
    ).toBe("253px");

    unmount();
    render(<App />);
    await openProject();
    openExplorerPanel();
    expect(
      screen.getByTestId("side-panel").style.getPropertyValue("--panel-w")
    ).toBe("253px");
  });

  it("disables text selection on the body while dragging a handle, restores it on release", async () => {
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );

    expect(document.body.style.userSelect).not.toBe("none");

    fireEvent.pointerDown(screen.getByTestId("resize-left-rail"), {
      clientX: 200,
    });
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerMove(window, { clientX: 260, buttons: 1 });
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerUp(window);
    expect(document.body.style.userSelect).not.toBe("none");
  });

  // A native window drag, a pointercancel, or releasing outside the window
  // all swallow the pointerup — without a self-heal the handle then tracked
  // the cursor forever with no way to let go.
  it("ends a drag whose pointerup never arrives", async () => {
    render(<App />);
    await openProject();
    openExplorerPanel();

    fireEvent.pointerDown(screen.getByTestId("resize-left-rail"), {
      clientX: 200,
    });
    expect(document.body.style.userSelect).toBe("none");

    // The button is already up: this move is proof the release was lost.
    fireEvent.pointerMove(window, { clientX: 260, buttons: 0 });
    expect(document.body.style.userSelect).not.toBe("none");

    const settled = screen
      .getByTestId("side-panel")
      .style.getPropertyValue("--panel-w");
    // Further movement must no longer resize anything.
    fireEvent.pointerMove(window, { clientX: 420, buttons: 0 });
    expect(
      screen.getByTestId("side-panel").style.getPropertyValue("--panel-w")
    ).toBe(settled);
  });

  // Cmd+\\ and the rail icon drive the same `activePanel` state — there is
  // deliberately no second "collapsed" flag to fall out of sync.
  it("closes and reopens the side panel via Cmd+\\", async () => {
    render(<App />);
    await openProject();
    openExplorerPanel();
    expect(screen.getByTestId("side-panel")).toBeDefined();

    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(screen.queryByTestId("side-panel")).toBeNull();
    expect(screen.queryByTestId("resize-left-rail")).toBeNull();

    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(screen.getByTestId("side-panel")).toBeDefined();
    expect(screen.getByTestId("resize-left-rail")).toBeDefined();
  });
});

describe("Keyboard navigation (accessibility)", () => {
  it("switches threads via Enter on a keyboard-focused thread row", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/palisade-code",
              displayName: "palisade-code",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "list_threads") {
          return Promise.resolve([
            {
              id: "t1",
              title: "Thread A",
              createdAt: "2026-08-06T00:00:00Z",
              currentMode: "spec",
            },
            {
              id: "t2",
              title: "Thread B",
              createdAt: "2026-08-06T00:00:00Z",
              currentMode: "spec",
            },
          ]);
        }
        if (cmd === "read_thread") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              {
                id: "claude",
                label: "Claude Code",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
              {
                id: "codex",
                label: "Codex",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
            ],
            selected: null,
            openspec: false,
            grillApply: false,
            ponytail: false,
            graphify: false,
            ready: false,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") return Promise.resolve([]);
        if (cmd === "git_branches") return Promise.resolve([]);
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("rail-history"));
    const threadList = screen.getByTestId("thread-list");
    // Scoped to the thread list: the selected thread's title also appears in the always-visible chat header below.
    await waitFor(() =>
      expect(within(threadList).getByText("Thread A")).toBeDefined()
    );
    const rowB = within(threadList).getByText("Thread B").closest("li")!;
    expect(rowB).toHaveAttribute("tabIndex", "0");

    fireEvent.keyDown(rowB, { key: "Enter" });

    // The History panel stays open after a selection — rail panels are pinned
    // by their icon, not dismissed by picking a row. The chat header below
    // reflects the newly-selected thread.
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread B")
    );
  });

  it("switches branches via Enter on a keyboard-focused branch row", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          agents: [
            {
              id: "claude",
              label: "Claude Code",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
            {
              id: "codex",
              label: "Codex",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
          ],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "load_graphify")
        return Promise.resolve({
          outDir: "",
          report: "",
          graph: null,
          summary: "",
        });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "git_branches") {
        return Promise.resolve([
          { name: "main", isCurrent: true, isRemote: false },
          { name: "feature", isCurrent: false, isRemote: false },
        ]);
      }
      if (cmd === "git_checkout_branch") return Promise.resolve();
      return Promise.resolve([]);
    });

    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(within(openWorkspacePanel().closest(".ds-panel-body")!).getByTestId("branch-indicator")).toBeDefined()
    );
    fireEvent.click(screen.getByTestId("branch-indicator"));

    const row = (await screen.findByText("feature")).closest("li")!;
    expect(row).toHaveAttribute("tabIndex", "0");

    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "git_checkout_branch",
        expect.objectContaining({ name: "feature" })
      )
    );
  });

  it("fuzzy-filters the branch list as you type, like the file palette does for files", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          agents: [
            {
              id: "claude",
              label: "Claude Code",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
            {
              id: "codex",
              label: "Codex",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
          ],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "load_graphify")
        return Promise.resolve({
          outDir: "",
          report: "",
          graph: null,
          summary: "",
        });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "git_branches") {
        return Promise.resolve([
          { name: "main", isCurrent: true, isRemote: false },
          { name: "feature-login", isCurrent: false, isRemote: false },
          { name: "bugfix-crash", isCurrent: false, isRemote: false },
        ]);
      }
      return Promise.resolve([]);
    });

    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(within(openWorkspacePanel().closest(".ds-panel-body")!).getByTestId("branch-indicator")).toBeDefined()
    );
    fireEvent.click(screen.getByTestId("branch-indicator"));
    await waitFor(() =>
      expect(screen.getAllByTestId("branch-option")).toHaveLength(3)
    );

    fireEvent.change(screen.getByTestId("branch-new-input"), {
      target: { value: "login" },
    });

    await waitFor(() => {
      const options = screen
        .getAllByTestId("branch-option")
        .map((el) => el.textContent);
      expect(options).toEqual(["feature-login"]);
    });
  });

  it("deletes a non-current local branch from the branch picker after confirming (GIT-14)", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          agents: [
            { id: "claude", label: "Claude Code", path: null, skillsOk: true, pluginOk: true },
            { id: "codex", label: "Codex", path: null, skillsOk: true, pluginOk: true },
          ],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "load_graphify")
        return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "git_branches") {
        return Promise.resolve([
          { name: "main", isCurrent: true, isRemote: false },
          { name: "stale-feature", isCurrent: false, isRemote: false },
        ]);
      }
      if (cmd === "git_delete_branch") return Promise.resolve();
      return Promise.resolve([]);
    });

    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(within(openWorkspacePanel().closest(".ds-panel-body")!).getByTestId("branch-indicator")).toBeDefined()
    );
    fireEvent.click(screen.getByTestId("branch-indicator"));

    const row = (await screen.findByText("stale-feature")).closest("li")!;
    fireEvent.click(within(row).getByTestId("branch-delete"));

    const confirmButton = await screen.findByRole("button", { name: /delete/i });
    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "git_delete_branch",
        expect.objectContaining({ name: "stale-feature" })
      )
    );
  });
});

describe("Unsaved-edit guard (data-loss prevention)", () => {
  it("keeps an unsaved edit alive when you open another file, and confirms only when its tab is closed", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/palisade-code",
              displayName: "palisade-code",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              {
                id: "claude",
                label: "Claude Code",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
              {
                id: "codex",
                label: "Codex",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
            ],
            selected: null,
            openspec: false,
            grillApply: false,
            ponytail: false,
            graphify: false,
            ready: false,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") {
          const relativePath = String(args?.relativePath ?? "");
          if (relativePath === "") {
            return Promise.resolve([
              { name: "a.ts", is_dir: false, path: "a.ts" },
              { name: "b.ts", is_dir: false, path: "b.ts" },
            ]);
          }
          return Promise.resolve([]);
        }
        if (cmd === "read_file_content") return Promise.resolve("content\n");
        if (cmd === "write_file_content") return Promise.resolve(null);
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await openProject();
    openExplorerPanel();
    await waitFor(() => expect(screen.getByText("a.ts")).toBeDefined());
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "content"
      )
    );

    const cmContent = document.querySelector(".cm-content") as HTMLElement;
    cmContent.focus();
    await user.type(cmContent, "x");

    // Opening another file no longer costs you the first one, so there is
    // nothing to confirm — both stay open and a.ts keeps its edit.
    fireEvent.click(screen.getByText("b.ts"));
    await waitFor(() =>
      expect(screen.getByTestId("breadcrumbs").textContent).toContain("b.ts")
    );
    expect(screen.queryByTestId("confirm-delete")).toBeNull();
    expect(screen.getAllByTestId("file-tab")).toHaveLength(2);

    const dirtyTab = screen
      .getAllByTestId("file-tab")
      .find((tab) => tab.getAttribute("data-path") === "a.ts");
    expect(dirtyTab).toHaveAttribute("data-dirty", "true");

    // Closing it is where the work would actually be thrown away.
    fireEvent.click(within(dirtyTab!).getByTestId("file-tab-close"));
    const discardBtn = await screen.findByTestId("confirm-delete");
    expect(discardBtn).toHaveTextContent("Discard");

    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getAllByTestId("file-tab")).toHaveLength(2);

    fireEvent.click(within(dirtyTab!).getByTestId("file-tab-close"));
    fireEvent.click(screen.getByTestId("confirm-delete"));
    await waitFor(() =>
      expect(screen.getAllByTestId("file-tab")).toHaveLength(1)
    );
  });

  it("guards the whole tab list when switching projects, not just the visible file", async () => {
    const user = userEvent.setup();
    const project = (hash: string, name: string) => ({
      hash,
      root: `/tmp/${name}`,
      displayName: name,
      createdAt: "2026-08-06T00:00:00Z",
      lastAccessedAt: "2026-08-06T00:00:00Z",
    });
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects")
          return Promise.resolve([
            project("proj-1", "one"),
            project("proj-2", "two"),
          ]);
        if (cmd === "switch_project")
          return Promise.resolve(
            project(String(args?.hash ?? "proj-1"), "one")
          );
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              {
                id: "claude",
                label: "Claude Code",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
              {
                id: "codex",
                label: "Codex",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
            ],
            selected: null,
            openspec: false,
            grillApply: false,
            ponytail: false,
            graphify: false,
            ready: false,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") {
          return Promise.resolve(
            String(args?.relativePath ?? "") === ""
              ? [{ name: "a.ts", is_dir: false, path: "a.ts" }]
              : []
          );
        }
        if (cmd === "read_file_content") return Promise.resolve("content\n");
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await openProject();
    openExplorerPanel();
    await waitFor(() => expect(screen.getByText("a.ts")).toBeDefined());
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "content"
      )
    );

    const cmContent = document.querySelector(".cm-content") as HTMLElement;
    cmContent.focus();
    await user.type(cmContent, "x");
    await waitFor(() =>
      expect(screen.getAllByTestId("file-tab")[0]).toHaveAttribute(
        "data-dirty",
        "true"
      )
    );

    // Switching projects closes every tab at once — the expensive version of
    // the mistake the file-open path has guarded against for a while.
    fireEvent.change(openWorkspacePanel(), {
      target: { value: "proj-2" },
    });

    const discard = await screen.findByTestId("confirm-delete");
    expect(discard).toHaveTextContent("Discard");
    expect(screen.getAllByTestId("file-tab")).toHaveLength(1);
  });

  it("switches files immediately with no prompt when there's nothing unsaved", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/palisade-code",
              displayName: "palisade-code",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              {
                id: "claude",
                label: "Claude Code",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
              {
                id: "codex",
                label: "Codex",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
            ],
            selected: null,
            openspec: false,
            grillApply: false,
            ponytail: false,
            graphify: false,
            ready: false,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") {
          const relativePath = String(args?.relativePath ?? "");
          if (relativePath === "") {
            return Promise.resolve([
              { name: "a.ts", is_dir: false, path: "a.ts" },
              { name: "b.ts", is_dir: false, path: "b.ts" },
            ]);
          }
          return Promise.resolve([]);
        }
        if (cmd === "read_file_content") return Promise.resolve("content\n");
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await openProject();
    openExplorerPanel();
    await waitFor(() => expect(screen.getByText("a.ts")).toBeDefined());
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() =>
      expect(screen.getByTestId("breadcrumbs").textContent).toContain("a.ts")
    );

    fireEvent.click(screen.getByText("b.ts"));
    await waitFor(() =>
      expect(screen.getByTestId("breadcrumbs").textContent).toContain("b.ts")
    );
    expect(screen.queryByTestId("confirm-delete")).toBeNull();
  });
});

describe("Heading hierarchy (accessibility)", () => {
  it("has a document h1 and no h4 anywhere in the app shell", () => {
    const { container } = render(<App />);
    expect(container.querySelector("h1")).not.toBeNull();
    expect(container.querySelectorAll("h4")).toHaveLength(0);
  });
});

describe("Labeled inputs (accessibility)", () => {
  it("labels the chat composer input, not just its placeholder", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") {
        return Promise.resolve([
          {
            id: "t1",
            title: "Thread A",
            createdAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
          },
        ]);
      }
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          agents: [
            {
              id: "claude",
              label: "Claude Code",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
            {
              id: "codex",
              label: "Codex",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
          ],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "load_graphify")
        return Promise.resolve({
          outDir: "",
          report: "",
          graph: null,
          summary: "",
        });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "git_branches") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    render(<App />);
    await openProject();
    // The single thread auto-selects on load, so the composer is already visible.
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );

    expect(screen.getByLabelText("Message")).toBe(
      screen.getByTestId("composer-input")
    );
  });

  it("labels the new-branch-name input, not just its placeholder", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          agents: [
            {
              id: "claude",
              label: "Claude Code",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
            {
              id: "codex",
              label: "Codex",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
          ],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "load_graphify")
        return Promise.resolve({
          outDir: "",
          report: "",
          graph: null,
          summary: "",
        });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "git_branches")
        return Promise.resolve([
          { name: "main", isCurrent: true, isRemote: false },
        ]);
      return Promise.resolve([]);
    });

    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(within(openWorkspacePanel().closest(".ds-panel-body")!).getByTestId("branch-indicator")).toBeDefined()
    );
    fireEvent.click(screen.getByTestId("branch-indicator"));

    expect(screen.getByLabelText(/new branch name/i)).toBe(
      screen.getByTestId("branch-new-input")
    );
  });
});

describe("Error banner provenance", () => {
  it("keeps an earlier failure visible instead of a later one silently clobbering it", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          agents: [
            {
              id: "claude",
              label: "Claude Code",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
            {
              id: "codex",
              label: "Codex",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
          ],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "load_graphify")
        return Promise.resolve({
          outDir: "",
          report: "",
          graph: null,
          summary: "",
        });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "git_branches") {
        return Promise.resolve([
          { name: "main", isCurrent: true, isRemote: false },
          { name: "feature", isCurrent: false, isRemote: false },
          { name: "bugfix", isCurrent: false, isRemote: false },
        ]);
      }
      if (cmd === "git_checkout_branch")
        return Promise.reject(new Error("checkout failed: dirty tree"));
      return Promise.resolve([]);
    });

    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(within(openWorkspacePanel().closest(".ds-panel-body")!).getByTestId("branch-indicator")).toBeDefined()
    );

    fireEvent.click(screen.getByTestId("branch-indicator"));
    fireEvent.click(await screen.findByText("feature"));
    await waitFor(() => expect(screen.getAllByTestId("error")).toHaveLength(1));

    fireEvent.click(screen.getByTestId("branch-indicator"));
    fireEvent.click(await screen.findByText("bugfix"));
    await waitFor(() => expect(screen.getAllByTestId("error")).toHaveLength(2));

    // Both instances survive rather than the second overwriting the first.
    expect(screen.getAllByTestId("error")).toHaveLength(2);

    fireEvent.click(screen.getAllByTestId("error")[0]);
    await waitFor(() => expect(screen.getAllByTestId("error")).toHaveLength(1));
  });
});

describe("Find in files (Cmd+Shift+F)", () => {
  it("opens the find-in-files palette on Cmd+Shift+F and closes on Escape", async () => {
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );

    fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("text-search-input")).toHaveFocus()
    );

    fireEvent.keyDown(screen.getByTestId("text-search-input"), {
      key: "Escape",
    });
    expect(screen.queryByTestId("text-search-input")).toBeNull();
  });
});

describe("Theme toggle", () => {
  afterEach(() => {
    localStorage.removeItem("palisade:theme");
    delete document.documentElement.dataset.theme;
  });

  it("cycles auto -> light -> dark -> auto and stamps data-theme on <html>", async () => {
    render(<App />);
    await openProject();
    const toggle = screen.getByTestId("theme-toggle");
    expect(toggle).toHaveAttribute("aria-label", "Theme: auto");
    expect(document.documentElement.dataset.theme).toBeUndefined();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-label", "Theme: light");
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-label", "Theme: dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-label", "Theme: auto");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("First-run onboarding", () => {
  it("explains what Palisade is and offers a prominent Open Project action when there are no projects yet", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") return Promise.resolve([]);
        return defaultInvoke(cmd, args);
      }
    );

    render(<App />);
    await screen.findByTestId("onboarding");
    // The brand mark, not a bare "no projects" sentence.
    expect(screen.getByAltText("Palisade")).toBeDefined();
    // With no project there is nothing to recall.
    expect(screen.queryByTestId("recent-project")).toBeNull();

    fireEvent.click(screen.getByTestId("add-project"));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true })
    );
  });

  it("surfaces executor detection on the first screen, before any project is open", async () => {
    render(<App />);
    const status = await screen.findByTestId("onboarding-status");
    expect(status.textContent).toMatch(/no coding agent found/i);
  });

  it("the onboarding composer's send picks a folder, creates a go-mode thread with the chosen agent, and sends the typed message", async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === "list_projects") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              { id: "claude", name: "Claude Code" },
              { id: "codex", name: "Codex" },
            ],
            selected: "claude",
            openspec: true,
            grillApply: true,
            ponytail: true,
            graphify: true,
            ready: true,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "add_project") {
          return Promise.resolve({
            hash: "proj-new",
            root: "/tmp/new-repo",
            displayName: "new-repo",
            createdAt: "2026-08-24T00:00:00Z",
            lastAccessedAt: "2026-08-24T00:00:00Z",
          });
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-new",
            root: "/tmp/new-repo",
            displayName: "new-repo",
            createdAt: "2026-08-24T00:00:00Z",
            lastAccessedAt: "2026-08-24T00:00:00Z",
          });
        }
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "git_branches") return Promise.resolve([]);
        if (cmd === "list_directory") return Promise.resolve([]);
        if (cmd === "list_models") {
          return Promise.resolve({ models: [], current: null, configId: null });
        }
        if (cmd === "create_thread") {
          return Promise.resolve({
            id: "thread-new",
            projectHash: "proj-new",
            title: "New thread",
            createdAt: "2026-08-24T00:00:00Z",
            updatedAt: "2026-08-24T00:00:00Z",
            currentMode: "go",
            openSpecChangeName: null,
          });
        }
        if (cmd === "set_thread_mode" || cmd === "set_thread_executor") {
          return Promise.resolve({
            id: "thread-new",
            projectHash: "proj-new",
            title: "New thread",
            createdAt: "2026-08-24T00:00:00Z",
            updatedAt: "2026-08-24T00:00:00Z",
            currentMode: "go",
            openSpecChangeName: null,
            executor: (args?.executor as string) ?? "claude",
            model: (args?.model as string) ?? null,
          });
        }
        if (cmd === "send_message") {
          return Promise.resolve({
            seq: 1,
            ts: "2026-08-24T00:00:01Z",
            role: "user",
            mode: "go",
            content: args?.content ?? "",
          });
        }
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await screen.findByTestId("onboarding");

    // Open the composer and pick the non-default provider — the framing
    // choice this writes must survive through project creation.
    fireEvent.click(screen.getByTestId("onboarding-composer-toggle"));
    fireEvent.click(await screen.findByTestId("onboarding-agent-pill"));
    fireEvent.click(await screen.findByTestId("onboarding-executor-opt-codex"));

    fireEvent.change(screen.getByTestId("onboarding-composer"), {
      target: { value: "Add dark mode toggle to settings" },
    });

    vi.mocked(open).mockResolvedValueOnce("/tmp/new-repo");
    fireEvent.click(screen.getByTestId("onboarding-send"));

    // Lands in the real, live thread — not back on an empty shell.
    await screen.findByTestId("vibe-shell");
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "send_message")).toBe(true)
    );

    expect(
      calls.find((c) => c.cmd === "add_project")?.args
    ).toEqual({ path: "/tmp/new-repo" });
    expect(
      calls.find((c) => c.cmd === "set_thread_mode")?.args
    ).toMatchObject({ mode: "go" });
    expect(
      calls.find((c) => c.cmd === "set_thread_executor")?.args
    ).toMatchObject({ executor: "codex" });
    expect(
      calls.find((c) => c.cmd === "send_message")?.args
    ).toMatchObject({
      content: "Add dark mode toggle to settings",
      mode: "go",
    });
  });

  it("opens a recent project on click instead of auto-entering it on launch", async () => {
    render(<App />);
    // Launch lands on onboarding even though a recent project exists — the
    // user opens it themselves, the way every other IDE behaves.
    await screen.findByTestId("onboarding");
    expect(screen.queryByTestId("shell-toggle")).toBeNull();

    fireEvent.click((await screen.findAllByTestId("recent-project"))[0]);
    await screen.findByTestId("shell-toggle");
    expect(screen.queryByTestId("onboarding")).toBeNull();
  });
});

describe("Workspace shell toggle (vibe-editor-shell-redesign)", () => {
  it("renders a Vibe/Editor toggle in the top chrome, with Editor active by default", async () => {
    render(<App />);
    await openProject();
    const chrome = screen.getByTestId("top-chrome");
    const toggle = within(chrome).getByTestId("shell-toggle");
    expect(within(toggle).getByTestId("shell-editor").className).toMatch(
      /active/
    );
    expect(within(toggle).getByTestId("shell-vibe").className).not.toMatch(
      /active/
    );
  });

  it("switching to Vibe renders the Vibe shell in place of the Editor shell, preserving the active project", async () => {
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );
    expect(screen.getByTestId("editor-shell")).toBeDefined();
    expect(screen.queryByTestId("vibe-shell")).toBeNull();

    fireEvent.click(screen.getByTestId("shell-vibe"));

    expect(screen.queryByTestId("editor-shell")).toBeNull();
    expect(screen.getByTestId("vibe-shell")).toBeDefined();
    expect(openWorkspacePanel()).toHaveValue("proj-1");
  });

  it("picking Go from the Vibe shell's empty mode picker shows the empty composer (not the picker again)", async () => {
    const createCalls: Record<string, unknown>[] = [];
    let threadCreated = false;
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/palisade-code",
              displayName: "palisade-code",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "create_thread") {
          createCalls.push(args ?? {});
          threadCreated = true;
          return Promise.resolve({
            id: "thread-new",
            projectHash: "proj-1",
            title: "New thread",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "go",
            openSpecChangeName: null,
          });
        }
        if (cmd === "set_thread_mode") {
          return Promise.resolve({
            id: "thread-new",
            projectHash: "proj-1",
            title: "New thread",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "go",
            openSpecChangeName: null,
          });
        }
        if (cmd === "list_threads") {
          return Promise.resolve(
            threadCreated
              ? [
                  {
                    id: "thread-new",
                    projectHash: "proj-1",
                    title: "New thread",
                    createdAt: "2026-08-06T00:00:00Z",
                    updatedAt: "2026-08-06T00:00:00Z",
                    currentMode: "go",
                    openSpecChangeName: null,
                  },
                ]
              : []
          );
        }
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              {
                id: "claude",
                label: "Claude Code",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
              {
                id: "codex",
                label: "Codex",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
            ],
            selected: null,
            openspec: false,
            grillApply: false,
            ponytail: false,
            graphify: false,
            ready: false,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") return Promise.resolve([]);
        if (cmd === "read_thread") return Promise.resolve([]);
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await openProject();

    // Switch to the Vibe shell (which uses showEmptyModePicker, not newThreadPicker).
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() => expect(screen.getByTestId("vibe-shell")).toBeDefined());
    // The empty mode picker shows because there are no threads.
    await waitFor(() =>
      expect(screen.getByTestId("mode-picker")).toBeDefined()
    );

    fireEvent.click(screen.getByTestId("pick-go"));

    // D20: no thread yet — the empty composer renders, not the picker again.
    await waitFor(() =>
      expect(screen.getByTestId("composer-input")).toBeDefined()
    );
    expect(createCalls.length).toBe(0);
    expect(screen.queryByTestId("mode-picker")).toBeNull();
  });

  it("picking Spec from the Vibe shell's empty mode picker shows the framing menu (not the picker again)", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/palisade-code",
              displayName: "palisade-code",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              {
                id: "claude",
                label: "Claude Code",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
              {
                id: "codex",
                label: "Codex",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
            ],
            selected: null,
            openspec: false,
            grillApply: false,
            ponytail: false,
            graphify: false,
            ready: false,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") return Promise.resolve([]);
        if (cmd === "read_thread") return Promise.resolve([]);
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await openProject();

    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() => expect(screen.getByTestId("vibe-shell")).toBeDefined());
    await waitFor(() =>
      expect(screen.getByTestId("mode-picker")).toBeDefined()
    );

    fireEvent.click(screen.getByTestId("pick-spec"));

    // Regression: the framing menu must show, not the picker again.
    await waitFor(() =>
      expect(screen.getByTestId("spec-type-picker")).toBeDefined()
    );
    expect(screen.queryByTestId("mode-picker")).toBeNull();
  });

  it("picking a spec type in the Vibe shell transitions to the thread without flashing back to the mode picker", async () => {
    const createCalls: Record<string, unknown>[] = [];
    const specModeCalls: Record<string, unknown>[] = [];
    let threadCreated = false;
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/palisade-code",
              displayName: "palisade-code",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "create_thread") {
          createCalls.push(args ?? {});
          threadCreated = true;
          return Promise.resolve({
            id: "thread-new",
            projectHash: "proj-1",
            title: "New thread",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
            openSpecChangeName: null,
            specType: "Feature",
          });
        }
        if (cmd === "spec_mode") {
          specModeCalls.push(args ?? {});
          return Promise.resolve({
            id: "thread-new",
            projectHash: "proj-1",
            title: "New thread",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
            openSpecChangeName: null,
            specType: "Feature",
          });
        }
        if (cmd === "list_threads") {
          return Promise.resolve(
            threadCreated
              ? [
                  {
                    id: "thread-new",
                    projectHash: "proj-1",
                    title: "New thread",
                    createdAt: "2026-08-06T00:00:00Z",
                    updatedAt: "2026-08-06T00:00:00Z",
                    currentMode: "spec",
                    openSpecChangeName: null,
                    specType: "Feature",
                  },
                ]
              : []
          );
        }
        if (cmd === "read_thread") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              {
                id: "claude",
                label: "Claude Code",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
            ],
            selected: "claude",
            openspec: false,
            grillApply: false,
            ponytail: false,
            graphify: false,
            ready: false,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") return Promise.resolve([]);
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await openProject();

    // Switch to the Vibe shell (uses showEmptyModePicker, not newThreadPicker).
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() => expect(screen.getByTestId("vibe-shell")).toBeDefined());
    await waitFor(() =>
      expect(screen.getByTestId("mode-picker")).toBeDefined()
    );

    fireEvent.click(screen.getByTestId("pick-spec"));
    await waitFor(() =>
      expect(screen.getByTestId("spec-type-picker")).toBeDefined()
    );

    // Pick Feature — this triggers async createThread + specMode + selectThread.
    // The mode picker must NOT flash back during the async gap.
    fireEvent.click(screen.getByTestId("spec-type-feature"));

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(specModeCalls).toEqual([
      {
        projectHash: "proj-1",
        threadId: "thread-new",
        specType: "Feature",
        bypass: false,
      },
    ]);
    // The thread title appears — the transition completed.
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("New thread")
    );
    // The mode picker never reappeared at any point.
    expect(screen.queryByTestId("mode-picker")).toBeNull();
    expect(screen.queryByTestId("spec-type-picker")).toBeNull();
  });

  it("sending a Go message in the Vibe shell sends the message without flashing back to the mode picker", async () => {
    const sendCalls: Record<string, unknown>[] = [];
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/palisade-code",
              displayName: "palisade-code",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "list_threads") {
          return Promise.resolve([
            {
              id: "thread-go",
              projectHash: "proj-1",
              title: "Go thread",
              createdAt: "2026-08-06T00:00:00Z",
              updatedAt: "2026-08-06T00:00:00Z",
              currentMode: "go",
              openSpecChangeName: null,
            },
          ]);
        }
        if (cmd === "send_message") {
          sendCalls.push(args ?? {});
          return Promise.resolve({
            seq: 1,
            ts: "2026-08-06T00:00:00Z",
            role: "user",
            mode: "go",
            content: String(args?.content ?? ""),
          });
        }
        if (cmd === "read_thread") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              {
                id: "claude",
                label: "Claude Code",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
            ],
            selected: null,
            openspec: false,
            grillApply: false,
            ponytail: false,
            graphify: false,
            ready: false,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") return Promise.resolve([]);
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await openProject();

    // Switch to the Vibe shell.
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() => expect(screen.getByTestId("vibe-shell")).toBeDefined());
    // The go-mode thread auto-selects.
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Go thread")
    );

    // Type and send a message.
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "Hello world" },
    });
    fireEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => expect(sendCalls.length).toBe(1));
    expect(sendCalls[0]).toMatchObject({
      projectHash: "proj-1",
      threadId: "thread-go",
      content: "Hello world",
      mode: "go",
    });
    // The mode picker never appeared.
    expect(screen.queryByTestId("mode-picker")).toBeNull();
  });

  it("switching shells does not call set_thread_mode or change the active thread's mode", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/palisade-code",
              displayName: "palisade-code",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "list_threads") {
          return Promise.resolve([
            {
              id: "t1",
              projectHash: "proj-1",
              title: "Thread A",
              createdAt: "2026-08-06T00:00:00Z",
              updatedAt: "2026-08-06T00:00:00Z",
              currentMode: "go",
              openSpecChangeName: null,
              executorSessionId: null,
            },
          ]);
        }
        if (cmd === "read_thread") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              {
                id: "claude",
                label: "Claude Code",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
              {
                id: "codex",
                label: "Codex",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
            ],
            selected: null,
            openspec: false,
            grillApply: false,
            ponytail: false,
            graphify: false,
            ready: false,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") return Promise.resolve([]);
        return Promise.resolve([]);
      }
    );
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );

    fireEvent.click(screen.getByTestId("shell-editor"));
    fireEvent.click(screen.getByTestId("shell-vibe"));

    expect(invokeMock).not.toHaveBeenCalledWith(
      "set_thread_mode",
      expect.anything()
    );
  });

  it("Vibe shell renders no Codebase Map control anywhere", async () => {
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("shell-vibe"));
    expect(screen.queryByTestId("tab-codemap")).toBeNull();
    expect(screen.queryByTestId("graph-pane")).toBeNull();
  });
});

describe("Vibe preset layout (shell-redesign Amendment 3)", () => {
  const toVibe = async () => {
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await screen.findByTestId("vibe-shell");
  };

  it("shows the Spec/Go picker centered in Vibe when there are no threads", async () => {
    render(<App />);
    await openProject();
    await toVibe();

    const picker = screen.getByTestId("mode-picker");
    expect(picker.className).toContain("ds-vibe-empty-picker");
    expect(screen.getByTestId("pick-go")).toBeDefined();
    expect(screen.getByTestId("pick-spec")).toBeDefined();
  });

  // Governing Rule: same children in both presets, rearranged by CSS order.
  // Vibe adds the session list and moves the rail to the trailing edge; it
  // does not gain or lose a panel.
  it("renders the same panel inventory as Editor, plus the session list", async () => {
    render(<App />);
    await openProject();
    await toVibe();

    expect(screen.getByTestId("session-list")).toBeDefined();
    expect(screen.getByTestId("nav-rail")).toBeDefined();
    expect(screen.getByTestId("editor-col")).toBeDefined();
    expect(screen.getByTestId("right-sidebar")).toBeDefined();
  });

  it("hides the session list in the Editor preset", async () => {
    render(<App />);
    await openProject();
    await toVibe();
    expect(screen.getByTestId("session-list")).toBeDefined();

    fireEvent.click(screen.getByTestId("shell-editor"));
    await screen.findByTestId("editor-shell");
    expect(screen.queryByTestId("session-list")).toBeNull();
  });

  it("collapses and restores the session list from the title bar", async () => {
    render(<App />);
    await openProject();
    await toVibe();

    fireEvent.click(screen.getByTestId("toggle-session-list"));
    expect(screen.queryByTestId("session-list")).toBeNull();

    fireEvent.click(screen.getByTestId("toggle-session-list"));
    expect(screen.getByTestId("session-list")).toBeDefined();
  });

  it("opens a file from the Explorer panel into the shared editor column", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_directory") {
          const relativePath = String(args?.relativePath ?? "");
          if (relativePath === "")
            return Promise.resolve([
              { name: "a.ts", is_dir: false, path: "a.ts" },
            ]);
          return Promise.resolve([]);
        }
        if (cmd === "read_file_content") return Promise.resolve("content\n");
        return defaultInvoke(cmd, args);
      }
    );

    render(<App />);
    await openProject();
    await toVibe();

    openExplorerPanel();
    await waitFor(() => expect(screen.getByText("a.ts")).toBeDefined());
    fireEvent.click(screen.getByText("a.ts"));

    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "content"
      )
    );
  });
});

describe("Harness warnings", () => {
  it("shows a warning as a warning, not as a failed action", async () => {
    render(<App />);
    await openProject();

    // These are advisory ("another thread is running here", "that executor
    // id is unknown, falling back"). Routing them through the error banner
    // told the user their action had failed when nothing had.
    act(() => {
      emit("harness-warning", "1 other thread is running in this project");
    });

    const banner = await screen.findByTestId("error");
    expect(banner).toHaveAttribute("data-tone", "warn");
    expect(banner.textContent).toContain("1 other thread is running");
    expect(banner.textContent).not.toContain("Couldn't complete that");
  });
});

describe("Command palette", () => {
  it("opens on Cmd+Shift+P and lists commands with their shortcuts", async () => {
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );

    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });

    await waitFor(() =>
      expect(screen.getByTestId("command-palette-input")).toBeDefined()
    );
    const items = screen.getAllByTestId("command-palette-item");
    expect(items.length).toBeGreaterThan(0);
    // The shortcut is shown next to the command, from the same declaration
    // the keyboard handler dispatches.
    expect(screen.getByTestId("command-palette-results").textContent).toContain(
      "⌘J"
    );
  });

  it("hovering a command highlights it without running it", async () => {
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("command-palette-input")).toBeDefined()
    );

    fireEvent.change(screen.getByTestId("command-palette-input"), {
      target: { value: "terminal" },
    });
    fireEvent.mouseEnter(screen.getAllByTestId("command-palette-item")[0]);

    // Still open, and the command has not fired.
    expect(screen.getByTestId("command-palette-input")).toBeDefined();
    expect(screen.queryByTestId("terminal-pane")).toBeNull();
  });

  it("filters as you type and runs the chosen command", async () => {
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("command-palette-input")).toBeDefined()
    );

    fireEvent.change(screen.getByTestId("command-palette-input"), {
      target: { value: "terminal" },
    });
    const items = screen.getAllByTestId("command-palette-item");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute("data-command", "view.terminal");

    fireEvent.click(items[0]);
    await waitFor(() =>
      expect(screen.queryByTestId("command-palette-input")).toBeNull()
    );
    await waitFor(() =>
      expect(screen.getByTestId("terminal-pane")).toBeDefined()
    );
  });

  it("says so when nothing matches", async () => {
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );
    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("command-palette-input")).toBeDefined()
    );

    fireEvent.change(screen.getByTestId("command-palette-input"), {
      target: { value: "zzzznope" },
    });
    expect(screen.getByTestId("command-palette-empty")).toBeDefined();
  });

  it("does not also open the file palette, which is one Shift away", async () => {
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );

    fireEvent.keyDown(window, { key: "p", metaKey: true, shiftKey: true });

    await waitFor(() =>
      expect(screen.getByTestId("command-palette-input")).toBeDefined()
    );
    expect(screen.queryByTestId("file-palette-input")).toBeNull();
  });
});

describe("Session restore", () => {
  const project = {
    hash: "proj-1",
    root: "/tmp/p",
    displayName: "p",
    createdAt: "2026-08-06T00:00:00Z",
    lastAccessedAt: "2026-08-06T00:00:00Z",
  };
  const router =
    (missing: string[] = []) =>
    (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") return Promise.resolve([project]);
      if (cmd === "switch_project") return Promise.resolve(project);
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          agents: [
            {
              id: "claude",
              label: "Claude Code",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
            {
              id: "codex",
              label: "Codex",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
          ],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "load_graphify")
        return Promise.resolve({
          outDir: "",
          report: "",
          graph: null,
          summary: "",
        });
      if (cmd === "list_directory") {
        return Promise.resolve(
          String(args?.relativePath ?? "") === ""
            ? [
                { name: "a.ts", is_dir: false, path: "a.ts" },
                { name: "b.ts", is_dir: false, path: "b.ts" },
              ]
            : []
        );
      }
      if (cmd === "read_file_content") {
        const path = String(args?.relativePath ?? "");
        return missing.includes(path)
          ? Promise.reject(new Error(`no such file: ${path}`))
          : Promise.resolve("content\n");
      }
      return Promise.resolve([]);
    };

  it("reopens the tabs that were open, with the same one active", async () => {
    localStorage.setItem(
      "palisade:session:proj-1",
      JSON.stringify({ openPaths: ["a.ts", "b.ts"], activePath: "a.ts" })
    );
    invokeMock.mockImplementation(router());

    render(<App />);
    await openProject();

    await waitFor(() =>
      expect(screen.getAllByTestId("file-tab")).toHaveLength(2)
    );
    expect(
      screen.getAllByTestId("file-tab").map((t) => t.getAttribute("data-path"))
    ).toEqual(["a.ts", "b.ts"]);
    await waitFor(() =>
      expect(screen.getByTestId("breadcrumbs").textContent).toContain("a.ts")
    );
  });

  it("drops a tab whose file has gone since last time", async () => {
    localStorage.setItem(
      "palisade:session:proj-1",
      JSON.stringify({ openPaths: ["a.ts", "deleted.ts"], activePath: "a.ts" })
    );
    invokeMock.mockImplementation(router(["deleted.ts"]));

    render(<App />);
    await openProject();

    await waitFor(() =>
      expect(screen.getAllByTestId("file-tab")).toHaveLength(1)
    );
    expect(screen.getAllByTestId("file-tab")[0]).toHaveAttribute(
      "data-path",
      "a.ts"
    );
  });

  it("comes back in the shell it was left in", async () => {
    localStorage.setItem(
      "palisade:session:proj-1",
      JSON.stringify({ openPaths: [], activePath: null, centerShell: "vibe" })
    );
    invokeMock.mockImplementation(router());

    render(<App />);
    await openProject();

    await waitFor(() => expect(screen.getByTestId("vibe-shell")).toBeDefined());
  });

  it("records what is open so the next launch can restore it", async () => {
    invokeMock.mockImplementation(router());
    render(<App />);
    await openProject();
    openExplorerPanel();

    fireEvent.click(await screen.findByText("b.ts"));
    await waitFor(() =>
      expect(screen.getAllByTestId("file-tab")).toHaveLength(1)
    );

    await waitFor(() => {
      const saved = JSON.parse(
        localStorage.getItem("palisade:session:proj-1") ?? "{}"
      );
      expect(saved.openPaths).toEqual(["b.ts"]);
      expect(saved.activePath).toBe("b.ts");
    });
  });
});

describe("Editor shell collapsible rail (vibe-editor-shell-redesign)", () => {
  it("renders the file tree on the left and Editor/Diff tabs in the center", async () => {
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(openWorkspacePanel()).toHaveValue("proj-1")
    );
    expect(screen.getByTestId("nav-rail")).toBeDefined();
    expect(screen.getByTestId("editor-tabs")).toBeDefined();
  });

  it("collapses the Threads & Codebase Map disclosure by default, so chat fills the rail without opening it", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") {
        return Promise.resolve([
          {
            id: "t1",
            projectHash: "proj-1",
            title: "Thread A",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "go",
            openSpecChangeName: null,
            executorSessionId: null,
          },
        ]);
      }
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          agents: [
            {
              id: "claude",
              label: "Claude Code",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
            {
              id: "codex",
              label: "Codex",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
          ],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "load_graphify")
        return Promise.resolve({
          outDir: "",
          report: "",
          graph: null,
          summary: "",
        });
      if (cmd === "list_directory") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    render(<App />);
    await openProject();
    expect(screen.queryByTestId("rail-disclosure-body")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    expect(screen.getByTestId("composer-input")).toBeDefined();
  });

  it("reaches a past thread in 2 clicks: open disclosure, then select the row", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") {
        return Promise.resolve([
          {
            id: "t1",
            projectHash: "proj-1",
            title: "Thread A",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "go",
            openSpecChangeName: null,
            executorSessionId: null,
          },
          {
            id: "t2",
            projectHash: "proj-1",
            title: "Thread B",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
            openSpecChangeName: null,
            executorSessionId: null,
          },
        ]);
      }
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          agents: [
            {
              id: "claude",
              label: "Claude Code",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
            {
              id: "codex",
              label: "Codex",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
          ],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "load_graphify")
        return Promise.resolve({
          outDir: "",
          report: "",
          graph: null,
          summary: "",
        });
      if (cmd === "list_directory") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );

    fireEvent.click(screen.getByTestId("rail-history")); // click 1: open
    const rowB = within(screen.getByTestId("thread-list"))
      .getByText("Thread B")
      .closest("li")!;
    fireEvent.click(rowB); // click 2: select

    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread B")
    );
    // Disclosure auto-collapses once a thread is picked (editor-collapsible-rail spec).
    expect(screen.queryByTestId("rail-disclosure-body")).toBeNull();
  });

  it("reaches Codebase Map in one click from the rail", async () => {
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("rail-codemap"));
    expect(await screen.findByTestId("graph-pane")).toBeDefined();
  });

  // Same one click in Vibe — the rail is shared, so the map is not further
  // away in one preset than the other.
  it("reaches Codebase Map in one click from the Vibe preset too", async () => {
    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await screen.findByTestId("vibe-shell");

    fireEvent.click(screen.getByTestId("rail-codemap"));
    expect(await screen.findByTestId("graph-pane")).toBeDefined();
  });
});

describe("Project switching", () => {
  const projA = {
    hash: "proj-a",
    root: "/tmp/proj-a",
    displayName: "proj-a",
    createdAt: "2026-08-06T00:00:00Z",
    lastAccessedAt: "2026-08-06T00:00:00Z",
  };
  const projB = {
    hash: "proj-b",
    root: "/tmp/proj-b",
    displayName: "proj-b",
    createdAt: "2026-08-06T00:00:00Z",
    lastAccessedAt: "2026-08-06T00:00:00Z",
  };

  beforeEach(() => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") return Promise.resolve([projA, projB]);
        if (cmd === "switch_project") {
          const hash = args?.hash;
          return Promise.resolve(hash === projB.hash ? projB : projA);
        }
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            agents: [
              {
                id: "claude",
                label: "Claude Code",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
              {
                id: "codex",
                label: "Codex",
                path: null,
                skillsOk: true,
                pluginOk: true,
              },
            ],
            selected: null,
            openspec: false,
            grillApply: false,
            ponytail: false,
            graphify: false,
            ready: false,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") {
          const relativePath = String(args?.relativePath ?? "");
          if (relativePath !== "") return Promise.resolve([]);
          const projectHash = args?.projectHash;
          return Promise.resolve(
            projectHash === projA.hash
              ? [{ name: "a.ts", is_dir: false, path: "a.ts" }]
              : [{ name: "b.ts", is_dir: false, path: "b.ts" }]
          );
        }
        if (cmd === "read_file_content") return Promise.resolve("content\n");
        if (cmd === "write_file_content") return Promise.resolve();
        if (cmd === "read_thread") return Promise.resolve([]);
        return Promise.resolve([]);
      }
    );
  });

  it("unassociates the open file from the previous project when the project switches", async () => {
    render(<App />);
    await openProject();

    openExplorerPanel();
    await waitFor(() => expect(screen.getByText("a.ts")).toBeDefined());
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() =>
      expect(screen.getByTestId("file-editor")).toBeDefined()
    );
    expect(
      screen.getByText("a.ts", { selector: ".ds-editor-path" })
    ).toBeDefined();

    fireEvent.change(openWorkspacePanel(), {
      target: { value: projB.hash },
    });

    // Rail panels are exclusive — the Account panel took the Explorer's slot,
    // so come back to it to see the new project's tree.
    fireEvent.click(screen.getByTestId("rail-explorer"));
    await waitFor(() => expect(screen.getByText("b.ts")).toBeDefined());
    expect(screen.queryByTestId("file-editor")).toBeNull();
    expect(screen.getByText(/select a file/i)).toBeDefined();
  });
});

describe("Executor/model/bypass menu (thread-executor-preferences)", () => {
  // The model/bypass control now lives in the composer, so every test needs
  // a project + thread + detected executor to reach it.
  const setupWithThread = (selected: string = "claude") => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects")
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      if (cmd === "switch_project")
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      if (cmd === "list_threads")
        return Promise.resolve([
          {
            id: "t1",
            projectHash: "proj-1",
            title: "Thread A",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
            openSpecChangeName: null,
          },
        ]);
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "executor_status") return Promise.resolve([]);
      if (cmd === "preflight")
        return Promise.resolve({
          agents: [
            {
              id: "claude",
              name: "Claude Code",
              version: null,
              path: selected === "claude" ? "/usr/local/bin/claude" : null,
              cmd: "claude-acp",
            },
            {
              id: "codex",
              name: "Codex",
              version: null,
              path: selected === "codex" ? "/usr/local/bin/codex" : null,
              cmd: "codex-acp",
            },
          ],
          selected,
          openspec: true,
          graphify: true,
          ready: true,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      return Promise.resolve([]);
    });
  };

  afterEach(() => {
    localStorage.removeItem("palisade:thread-prefs:proj-1:t1");
    localStorage.removeItem("palisade:thread-prefs:proj-1:t2");
  });

  it("shows the current executor in the composer and opens a menu on click", async () => {
    setupWithThread("claude");
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    await waitFor(() =>
      expect(screen.getByTestId("executor-btn")).toHaveTextContent(/claude/i)
    );
    expect(screen.queryByTestId("executor-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("executor-btn"));
    expect(await screen.findByTestId("executor-menu")).toBeDefined();
  });

  it("shows discovered ACP agents in the executor dropdown", async () => {
    setupWithThread("claude");
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    fireEvent.click(screen.getByTestId("executor-btn"));

    // Should show agent entries from the preflight
    expect(await screen.findByTestId("executor-opt-claude")).toBeDefined();
  });

  it("clicking a provider persists it on the thread and clears the model", async () => {
    setupWithThread("claude");
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    fireEvent.click(screen.getByTestId("executor-btn"));
    fireEvent.click(await screen.findByTestId("executor-opt-codex"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_thread_executor", {
        projectHash: "proj-1",
        threadId: "t1",
        executor: "codex",
        model: null,
      })
    );
  });

  it("leaves a banner behind after the menu closes, when a session is live", async () => {
    setupWithThread("claude");
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "send_message")
        return Promise.resolve({
          seq: 1,
          role: "user",
          content: "hello",
          createdAt: "2026-08-12T00:00:00Z",
        });
      return base(cmd, args);
    });
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    // A live session for this thread is what makes the switch ambiguous.
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "hello" },
    });
    fireEvent.submit(screen.getByTestId("composer-input").closest("form")!);
    await screen.findByTestId("composer-stop");

    fireEvent.click(screen.getByTestId("executor-btn"));
    fireEvent.click(await screen.findByTestId("executor-opt-codex"));

    // The menu is gone; the explanation is not.
    await waitFor(() =>
      expect(screen.queryByTestId("executor-menu")).toBeNull()
    );
    const banner = screen.getByTestId("executor-switch-banner");
    expect(banner.textContent).toContain("Codex");
  });

  it("feeds the model menu from the selected provider's probed models", async () => {
    setupWithThread("claude");
    const baseImpl = invokeMock.getMockImplementation();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_models")
        return Promise.resolve({
          configId: "model",
          current: "m1",
          models: [
            { id: "m1", name: "Model One" },
            { id: "m2", name: "Model Two" },
          ],
        });
      return baseImpl?.(cmd) ?? Promise.resolve([]);
    });
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );

    fireEvent.click(screen.getByTestId("model-btn"));
    expect(await screen.findByTestId("model-opt-m1")).toBeDefined();
    expect(await screen.findByTestId("model-opt-m2")).toBeDefined();
    expect(invokeMock).toHaveBeenCalledWith("list_models", {
      projectHash: "proj-1",
      agentId: "claude",
    });
    // The button shows the agent's current model by name.
    await waitFor(() =>
      expect(screen.getByTestId("model-btn")).toHaveTextContent("Model One")
    );
  });

  it("filters the model menu by search query", async () => {
    setupWithThread("claude");
    const baseImpl = invokeMock.getMockImplementation();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_models")
        return Promise.resolve({
          configId: "model",
          current: "m1",
          models: [
            { id: "m1", name: "Model One" },
            { id: "m2", name: "Model Two" },
          ],
        });
      return baseImpl?.(cmd) ?? Promise.resolve([]);
    });
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );

    fireEvent.click(screen.getByTestId("model-btn"));
    const search = await screen.findByTestId("model-search");
    fireEvent.change(search, { target: { value: "Two" } });

    await waitFor(() => {
      expect(screen.queryByTestId("model-opt-m2")).not.toBeNull();
      expect(screen.queryByTestId("model-opt-m1")).toBeNull();
    });
  });

  it("clicking a model pins provider and model on the thread", async () => {
    setupWithThread("claude");
    const baseImpl = invokeMock.getMockImplementation();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_models")
        return Promise.resolve({
          configId: "model",
          current: "m1",
          models: [
            { id: "m1", name: "Model One" },
            { id: "m2", name: "Model Two" },
          ],
        });
      return baseImpl?.(cmd) ?? Promise.resolve([]);
    });
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );

    fireEvent.click(screen.getByTestId("model-btn"));
    fireEvent.click(await screen.findByTestId("model-opt-m2"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_thread_executor", {
        projectHash: "proj-1",
        threadId: "t1",
        executor: "claude",
        model: "m2",
      })
    );
  });

  it("shows a hint when the provider manages its own model", async () => {
    setupWithThread("claude");
    const baseImpl = invokeMock.getMockImplementation();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_models")
        return Promise.resolve({ configId: null, current: null, models: [] });
      return baseImpl?.(cmd) ?? Promise.resolve([]);
    });
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );

    fireEvent.click(screen.getByTestId("model-btn"));
    expect(await screen.findByTestId("models-none")).toBeDefined();
  });

  it("removes the model picker for a chain executor instead of probing the chain as an agent", async () => {
    // A saved chain runs several agents in sequence, each with its own
    // model — `chain:<name>` used to get passed straight to `list_models`
    // as if it were an agent id, and the backend rejected it with
    // "unknown or unavailable agent `chain:ship`".
    setupWithThread("claude");
    const baseImpl = invokeMock.getMockImplementation();
    const listModels = vi.fn().mockResolvedValue({
      configId: "model",
      current: "m1",
      models: [{ id: "m1", name: "Model One" }],
    });
    let currentExecutor = "chain:ship";
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_threads")
        return Promise.resolve([
          {
            id: "t1",
            projectHash: "proj-1",
            title: "Thread A",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
            openSpecChangeName: null,
            executor: currentExecutor,
          },
        ]);
      if (cmd === "set_thread_executor") {
        currentExecutor = args?.executor as string;
        return Promise.resolve({ executor: currentExecutor });
      }
      if (cmd === "list_chains")
        return Promise.resolve([
          {
            name: "ship",
            nodes: {
              designer: { role: "designer", guideline: "", agent: "claude" },
            },
            edges: [],
            entry: "designer",
          },
        ]);
      if (cmd === "list_models") return listModels(args);
      return baseImpl?.(cmd, args) ?? Promise.resolve([]);
    });
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    await waitFor(() =>
      expect(screen.getByTestId("executor-btn")).toHaveTextContent("ship")
    );

    expect(screen.queryByTestId("model-btn")).not.toBeInTheDocument();

    // Switch away, then back onto the chain — picking it is exactly the
    // path that used to call `list_models` with "chain:ship" as the agent
    // id and get "unknown or unavailable agent `chain:ship`" back.
    fireEvent.click(screen.getByTestId("executor-btn"));
    fireEvent.click(await screen.findByTestId("executor-opt-claude"));
    await waitFor(() =>
      expect(screen.getByTestId("executor-btn")).toHaveTextContent(/claude/i)
    );

    fireEvent.click(screen.getByTestId("executor-btn"));
    fireEvent.click(await screen.findByTestId("executor-opt-chain:ship"));
    await waitFor(() =>
      expect(screen.getByTestId("executor-btn")).toHaveTextContent("ship")
    );
    expect(screen.queryByTestId("model-btn")).not.toBeInTheDocument();
    expect(listModels).not.toHaveBeenCalledWith({
      projectHash: "proj-1",
      agentId: "chain:ship",
    });
  });

  it("has a standalone permission-mode icon button, default Accept, that requires confirmation to enable Bypass and persists per-thread", async () => {
    setupWithThread("claude");
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    const btn = await screen.findByTestId("permission-mode-btn");
    expect(btn).toHaveAttribute("aria-label", "Accept permissions");

    // Clicking while in Accept mode opens a confirmation popover rather
    // than flipping immediately (D2e).
    fireEvent.click(btn);
    expect(await screen.findByTestId("permission-mode-confirm")).toBeDefined();
    expect(btn).toHaveAttribute("aria-label", "Accept permissions");

    fireEvent.click(screen.getByTestId("permission-mode-confirm-bypass"));
    await waitFor(() =>
      expect(
        screen.getByTestId("permission-mode-btn")
      ).toHaveAttribute("aria-label", "Bypass permissions")
    );
    expect(localStorage.getItem("palisade:thread-prefs:proj-1:t1")).toBe(
      JSON.stringify({ bypass: true })
    );

    // Bypass→Accept is a plain click, no confirmation.
    fireEvent.click(screen.getByTestId("permission-mode-btn"));
    await waitFor(() =>
      expect(
        screen.getByTestId("permission-mode-btn")
      ).toHaveAttribute("aria-label", "Accept permissions")
    );
  });

  it("declining the confirmation popover leaves the thread in Accept mode", async () => {
    setupWithThread("claude");
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    fireEvent.click(await screen.findByTestId("permission-mode-btn"));
    expect(await screen.findByTestId("permission-mode-confirm")).toBeDefined();

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.getByTestId("permission-mode-confirm")).toHaveStyle({
        display: "none",
      })
    );
    expect(screen.getByTestId("permission-mode-btn")).toHaveAttribute(
      "aria-label",
      "Accept permissions"
    );
  });

  it("shows a 'next session' hint when a live session exists for the thread", async () => {
    setupWithThread("claude");
    const baseImpl = invokeMock.getMockImplementation();
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "send_message")
        return Promise.resolve({
          seq: 1,
          role: "user",
          content: "hello",
          createdAt: "2026-08-12T00:00:00Z",
        });
      return baseImpl?.(cmd, args) ?? Promise.resolve([]);
    });
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    // Send a message so this thread genuinely has a live (busy) session —
    // the hint reads that same reactive state, not a separate poll.
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "hello" },
    });
    fireEvent.submit(screen.getByTestId("composer-input").closest("form")!);
    await screen.findByTestId("composer-stop");

    fireEvent.click(screen.getByTestId("executor-btn"));
    expect(await screen.findByTestId("next-session-hint")).toBeDefined();
  });

  it("shows no 'next session' hint before any message has been sent on the thread", async () => {
    setupWithThread("claude");
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    fireEvent.click(screen.getByTestId("executor-btn"));
    expect(screen.queryByTestId("next-session-hint")).toBeNull();
  });

  it("shows a stop button and calls stop_executor when the agent is busy", async () => {
    setupWithThread("claude");
    const baseImpl = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "send_message")
          return Promise.resolve({
            seq: 1,
            role: "user",
            content: "hello",
            createdAt: "2026-08-12T00:00:00Z",
          });
        return baseImpl?.(cmd, args) ?? Promise.resolve([]);
      }
    );
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    // Type and send a message — this sets busy=true because an executor is
    // detected (flight.selected is truthy), and busy stays true until the
    // event listener receives Done/Crashed.
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "hello" },
    });
    fireEvent.submit(screen.getByTestId("composer-input").closest("form")!);
    // The stop button replaces the send button while busy.
    const stopBtn = await screen.findByTestId("composer-stop");
    expect(stopBtn).toBeDefined();
    fireEvent.click(stopBtn);
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("stop_executor", {
        sessionId: null,
      })
    );
  });

  it("passes bypass to sendMessage", async () => {
    setupWithThread("claude");
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    // Enable bypass via the icon button + confirmation popover.
    fireEvent.click(await screen.findByTestId("permission-mode-btn"));
    fireEvent.click(await screen.findByTestId("permission-mode-confirm-bypass"));
    await waitFor(() =>
      expect(screen.getByTestId("permission-mode-btn")).toHaveAttribute(
        "aria-label",
        "Bypass permissions"
      )
    );

    // Send a message
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "hello" },
    });
    fireEvent.submit(screen.getByTestId("composer-input").closest("form")!);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("send_message", {
        projectHash: "proj-1",
        threadId: "t1",
        content: "hello",
        mode: "spec",
        model: null,
        bypass: true,
      })
    );
  });

  it("renders the user's own message immediately, before the backend round-trip resolves", async () => {
    // `send_message` also spawns/waits on the executor session before it
    // resolves — a cold agent spawn can take seconds. The bubble used to
    // wait for that round-trip, so the user's own message didn't appear
    // until the agent's reply did. Held open here to prove the bubble
    // renders before send_message ever resolves.
    setupWithThread("claude");
    const baseImpl = invokeMock.getMockImplementation();
    let resolveSend: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "send_message")
        return new Promise((resolve) => {
          resolveSend = resolve;
        });
      return baseImpl?.(cmd, args) ?? Promise.resolve([]);
    });
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );

    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "Hello world" },
    });
    fireEvent.submit(screen.getByTestId("composer-input").closest("form")!);

    // Still in flight — send_message hasn't resolved — but the bubble is
    // already there.
    expect(screen.getByTestId("messages")).toHaveTextContent("Hello world");

    resolveSend({
      seq: 1,
      ts: "2026-08-12T00:00:00Z",
      role: "user",
      mode: "spec",
      content: "Hello world",
    });
    await waitFor(() =>
      expect(screen.getByTestId("messages")).toHaveTextContent("Hello world")
    );
    // Reconciled with the real message, not duplicated.
    expect(
      screen.getAllByText("Hello world", { exact: false }).length
    ).toBeLessThanOrEqual(1);
  });

  it("drops the optimistic echo if the send itself fails", async () => {
    setupWithThread("claude");
    const baseImpl = invokeMock.getMockImplementation();
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "send_message") return Promise.reject(new Error("boom"));
      return baseImpl?.(cmd, args) ?? Promise.resolve([]);
    });
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );

    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "Hello world" },
    });
    fireEvent.submit(screen.getByTestId("composer-input").closest("form")!);

    expect(screen.getByTestId("messages")).toHaveTextContent("Hello world");
    await waitFor(() =>
      expect(screen.getByTestId("messages")).not.toHaveTextContent(
        "Hello world"
      )
    );
  });

  it("enabling Bypass on one thread leaves other threads (existing and new) in Accept mode (no sticky default)", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects")
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      if (cmd === "switch_project")
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      if (cmd === "list_threads")
        return Promise.resolve([
          {
            id: "t1",
            projectHash: "proj-1",
            title: "Thread A",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
            openSpecChangeName: null,
          },
          {
            id: "t2",
            projectHash: "proj-1",
            title: "Thread B",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
            openSpecChangeName: null,
          },
        ]);
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "executor_status") return Promise.resolve([]);
      if (cmd === "preflight")
        return Promise.resolve({
          agents: [
            {
              id: "claude",
              name: "Claude Code",
              version: null,
              path: "/usr/local/bin/claude",
              cmd: "claude-acp",
            },
          ],
          selected: "claude",
          openspec: true,
          graphify: true,
          ready: true,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      return Promise.resolve([]);
    });

    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );

    // Enable Bypass on Thread A.
    fireEvent.click(await screen.findByTestId("permission-mode-btn"));
    fireEvent.click(await screen.findByTestId("permission-mode-confirm-bypass"));
    await waitFor(() =>
      expect(screen.getByTestId("permission-mode-btn")).toHaveAttribute(
        "aria-label",
        "Bypass permissions"
      )
    );

    // Switch to Thread B: never configured, must still be Accept.
    fireEvent.click(screen.getByTestId("rail-history"));
    fireEvent.click(
      within(screen.getByTestId("thread-list")).getByText("Thread B").closest("li")!
    );
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread B")
    );
    expect(screen.getByTestId("permission-mode-btn")).toHaveAttribute(
      "aria-label",
      "Accept permissions"
    );

    localStorage.removeItem("palisade:thread-prefs:proj-1:t2");
  });
});

describe("Vibe spec tabs (vibe-spec-tabs)", () => {
  it("opens a spec tab when a spec row in the launcher is clicked", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects")
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      if (cmd === "switch_project")
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      if (cmd === "list_threads")
        return Promise.resolve([
          {
            id: "t1",
            projectHash: "proj-1",
            title: "Thread 1",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
            openSpecChangeName: null,
            executorSessionId: null,
          },
        ]);
      if (cmd === "list_spec_changes")
        return Promise.resolve([
          {
            name: "vibe-spec-tabs",
            completedTasks: 3,
            totalTasks: 10,
            lastModified: "2026-08-09T00:00:00Z",
            status: "in-progress",
          },
        ]);
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      if (cmd === "show_spec_change")
        return Promise.resolve({
          id: "vibe-spec-tabs",
          title: "vibe-spec-tabs",
          deltaCount: 0,
          deltas: [],
        });
      if (cmd === "verify_commands") return Promise.resolve([]);
      if (cmd === "list_verifications") return Promise.resolve([]);
      if (cmd === "read_file_content") return Promise.resolve("# content\n");
      if (cmd === "preflight")
        return Promise.resolve({
          agents: [],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      if (cmd === "load_graphify")
        return Promise.resolve({
          outDir: "",
          report: "",
          graph: null,
          summary: "",
        });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "read_thread") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("shell-vibe"));

    // The Specs rail panel replaced the Vibe-only launcher — one panel
    // inventory, both presets (the governing rule).
    fireEvent.click(screen.getByTestId("rail-specs"));
    const row = await screen.findByTestId("spec-change");
    fireEvent.click(within(row).getByText("vibe-spec-tabs"));

    // The spec tab should now be active in the files column
    await waitFor(() => {
      expect(screen.getAllByTestId("spec-inner-tab").length).toBe(5);
    });
  });

  it("opens a spec tab when the linked-change chip is clicked", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects")
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      if (cmd === "switch_project")
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      if (cmd === "list_threads")
        return Promise.resolve([
          {
            id: "t1",
            projectHash: "proj-1",
            title: "Thread 1",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
            openSpecChangeName: "vibe-spec-tabs",
            executorSessionId: null,
          },
        ]);
      if (cmd === "list_spec_changes")
        return Promise.resolve([
          {
            name: "vibe-spec-tabs",
            completedTasks: 3,
            totalTasks: 10,
            lastModified: "2026-08-09T00:00:00Z",
            status: "in-progress",
          },
        ]);
      if (cmd === "validate_spec_changes") return Promise.resolve(true);
      if (cmd === "show_spec_change")
        return Promise.resolve({
          id: "vibe-spec-tabs",
          title: "vibe-spec-tabs",
          deltaCount: 0,
          deltas: [],
        });
      if (cmd === "verify_commands") return Promise.resolve([]);
      if (cmd === "list_verifications") return Promise.resolve([]);
      if (cmd === "read_file_content") return Promise.resolve("# content\n");
      if (cmd === "preflight")
        return Promise.resolve({
          agents: [],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      if (cmd === "load_graphify")
        return Promise.resolve({
          outDir: "",
          report: "",
          graph: null,
          summary: "",
        });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "read_thread") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() =>
      expect(screen.getByTestId("change-chip")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByTestId("change-chip"));

    await waitFor(() => {
      expect(screen.getAllByTestId("spec-inner-tab").length).toBe(5);
    });
  });

  it("keeps a spec tab open when switching from Vibe to Editor mode", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects")
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/palisade-code",
              displayName: "palisade-code",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        if (cmd === "switch_project")
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        if (cmd === "list_threads")
          return Promise.resolve([
            {
              id: "t1",
              projectHash: "proj-1",
              title: "Thread 1",
              createdAt: "2026-08-06T00:00:00Z",
              updatedAt: "2026-08-06T00:00:00Z",
              currentMode: "spec",
              openSpecChangeName: null,
              executorSessionId: null,
            },
          ]);
        if (cmd === "list_spec_changes")
          return Promise.resolve([
            {
              name: "vibe-spec-tabs",
              completedTasks: 3,
              totalTasks: 10,
              lastModified: "2026-08-09T00:00:00Z",
              status: "in-progress",
            },
          ]);
        if (cmd === "validate_spec_changes") return Promise.resolve(true);
        if (cmd === "show_spec_change")
          return Promise.resolve({
            id: "vibe-spec-tabs",
            title: "vibe-spec-tabs",
            deltaCount: 0,
            deltas: [],
          });
        if (cmd === "verify_commands") return Promise.resolve([]);
        if (cmd === "list_verifications") return Promise.resolve([]);
        if (cmd === "read_file_content") {
          const relativePath = String(args?.relativePath ?? "");
          if (relativePath.startsWith("spec:"))
            return Promise.reject(new Error(`no such file: ${relativePath}`));
          return Promise.resolve("# content\n");
        }
        if (cmd === "preflight")
          return Promise.resolve({
            agents: [],
            selected: null,
            openspec: false,
            grillApply: false,
            ponytail: false,
            graphify: false,
            ready: false,
            warnings: [],
            checkedAt: "2026-08-06T00:00:00Z",
          });
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") return Promise.resolve([]);
        if (cmd === "read_thread") return Promise.resolve([]);
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await openProject();
    fireEvent.click(screen.getByTestId("shell-vibe"));

    fireEvent.click(screen.getByTestId("rail-specs"));
    const row = await screen.findByTestId("spec-change");
    fireEvent.click(within(row).getByText("vibe-spec-tabs"));
    await waitFor(() => {
      expect(screen.getAllByTestId("spec-inner-tab").length).toBe(5);
    });

    fireEvent.click(screen.getByTestId("shell-editor"));

    await waitFor(() => {
      expect(screen.getAllByTestId("spec-inner-tab").length).toBe(5);
    });
  });
});

// The `/` menu is fed entirely by the agent's ACP `available_commands_update`
// notification. Verified against @agentclientprotocol/claude-agent-acp 0.69.0:
// a project's own .claude/skills/*/SKILL.md arrives through this channel, so
// Palisade never scans a skill directory or hardcodes an agent's layout.
describe("Agent command menu", () => {
  const openThread = async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/palisade-code",
            displayName: "palisade-code",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/palisade-code",
          displayName: "palisade-code",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") {
        return Promise.resolve([
          {
            id: "t1",
            title: "Thread A",
            createdAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
          },
        ]);
      }
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          agents: [
            {
              id: "claude",
              label: "Claude Code",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
            {
              id: "codex",
              label: "Codex",
              path: null,
              skillsOk: true,
              pluginOk: true,
            },
          ],
          selected: null,
          openspec: false,
          grillApply: false,
          ponytail: false,
          graphify: false,
          ready: false,
          warnings: [],
          checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "load_graphify")
        return Promise.resolve({
          outDir: "",
          report: "",
          graph: null,
          summary: "",
        });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "git_branches") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<App />);
    await openProject();
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
  };

  const advertise = (commands: { name: string; description: string }[]) =>
    emit("agent-commands", {
      sessionId: "s1",
      threadId: "t1",
      commands,
    });

  it("opens with an empty state until the agent has advertised something", async () => {
    await openThread();
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "/" },
    });
    const menu = await screen.findByTestId("command-menu");
    expect(menu).toHaveTextContent(/no skills advertised/i);
  });

  it("distinguishes a query with no matches from an empty pool", async () => {
    await openThread();
    advertise([{ name: "review", description: "Review code changes" }]);
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "/zzz" },
    });
    const menu = await screen.findByTestId("command-menu");
    expect(menu).toHaveTextContent(/no matches for.*zzz/i);
  });

  it("lists the agent's commands, project skills included", async () => {
    await openThread();
    advertise([
      { name: "review", description: "Review code changes" },
      { name: "my-project-skill", description: "PROJECT MARKER" },
    ]);
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "/" },
    });
    const menu = await screen.findByTestId("command-menu");
    expect(menu).toHaveTextContent("/review");
    expect(menu).toHaveTextContent("/my-project-skill");
    expect(menu).toHaveTextContent("PROJECT MARKER");
  });

  it("filters as the user types and completes the choice into the draft", async () => {
    await openThread();
    advertise([
      { name: "review", description: "Review code changes" },
      { name: "propose", description: "Propose a change" },
    ]);
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/rev" } });
    const menu = await screen.findByTestId("command-menu");
    expect(menu).not.toHaveTextContent("/propose");

    fireEvent.keyDown(input, { key: "Enter" });
    // ACP invokes a command by sending "/name" as the prompt; picking one
    // collapses it into a pill and leaves the argument box empty.
    await waitFor(() =>
      expect(screen.getByTestId("composer-chip")).toHaveTextContent("/review")
    );
    expect(screen.getByTestId("composer-input")).toHaveValue("");
    expect(screen.queryByTestId("command-menu")).not.toBeInTheDocument();
  });

  it("does not send the message while the menu is open", async () => {
    await openThread();
    advertise([{ name: "review", description: "Review code changes" }]);
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/rev" } });
    await screen.findByTestId("command-menu");

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("composer-chip")).toHaveTextContent("/review")
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "send_message",
      expect.anything()
    );
  });

  it("moves the highlight with the arrow keys", async () => {
    await openThread();
    advertise([
      { name: "review", description: "Review code changes" },
      { name: "revert", description: "Revert a commit" },
    ]);
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/rev" } });
    await screen.findByTestId("command-menu");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("composer-chip")).toHaveTextContent("/revert")
    );
  });

  it("keeps the typed text when Escape dismisses the menu", async () => {
    await openThread();
    advertise([{ name: "review", description: "Review code changes" }]);
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/rev" } });
    await screen.findByTestId("command-menu");

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(input).toHaveValue("rev"));
    expect(screen.queryByTestId("command-menu")).not.toBeInTheDocument();
  });

  it("drives a Codex-style sigil command without double-prefixing it", async () => {
    await openThread();
    // codex-acp 1.4.0 carries the "$" inside the advertised name.
    advertise([{ name: "$tdd", description: "Test-driven development" }]);
    const input = screen.getByTestId("composer-input");

    fireEvent.change(input, { target: { value: "$td" } });
    const menu = await screen.findByTestId("command-menu");
    expect(menu).toHaveTextContent("$tdd");
    expect(menu).not.toHaveTextContent("/$tdd");

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("composer-chip")).toHaveTextContent("$tdd")
    );
  });

  it("finds a sigil command from a slash, since the user need not know", async () => {
    await openThread();
    advertise([{ name: "$tdd", description: "Test-driven development" }]);
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/tdd" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("composer-chip")).toHaveTextContent("$tdd")
    );
  });

  it("backspacing at the start of the argument eats the whole pill", async () => {
    await openThread();
    advertise([{ name: "review", description: "Review code changes" }]);
    const input = screen.getByTestId("composer-input");
    fireEvent.change(input, { target: { value: "/rev" } });
    await screen.findByTestId("command-menu");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByTestId("composer-chip");

    fireEvent.keyDown(screen.getByTestId("composer-input"), {
      key: "Backspace",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("composer-chip")).not.toBeInTheDocument()
    );
    expect(screen.getByTestId("composer-input")).toHaveValue("");
  });

  it("replaces the list when the agent re-advertises mid-session", async () => {
    await openThread();
    advertise([{ name: "old-skill", description: "Was here" }]);
    advertise([{ name: "new-skill", description: "Is here now" }]);
    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "/" },
    });
    const menu = await screen.findByTestId("command-menu");
    expect(menu).toHaveTextContent("/new-skill");
    expect(menu).not.toHaveTextContent("/old-skill");
  });
});
