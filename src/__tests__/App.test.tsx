import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

// Mock Tauri APIs before importing App
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

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
vi.mock("@uiw/react-md-editor", () => ({
  default: ({ value }: { value: string }) => (
    <div data-testid="md-editor">{value}</div>
  ),
  MDEditor: {
    Markdown: ({ source }: { source: string }) => <div>{source}</div>,
  },
}));

vi.mock("../GraphPane", () => ({
  default: () => <div data-testid="graph-pane" />,
}));

import App from "../App";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          {
            hash: "proj-1",
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/floo-network",
          displayName: "floo-network",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          claude: null,
          codex: null,
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
    }
  );
});

afterEach(() => {
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

  it("renders the .ds-window shell", () => {
    render(<App />);
    expect(screen.getByTestId("window-shell")).toBeDefined();
  });

  it("has 12px border-radius on the window shell", () => {
    render(<App />);
    const shell = screen.getByTestId("window-shell");
    const style = getComputedStyle(shell);
    expect(style.borderRadius).toBe("12px");
  });
});

describe("Top chrome (merged-design v2)", () => {
  it("renders at 36px height", () => {
    render(<App />);
    const chrome = screen.getByTestId("top-chrome");
    expect(getComputedStyle(chrome).height).toBe("36px");
  });

  it("has Spec/Go mode toggle in the chat composer", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/floo-network",
              displayName: "floo-network",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
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
        if (cmd === "read_thread") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            claude: "/usr/local/bin/claude",
            codex: null,
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
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") return Promise.resolve([]);
        if (cmd === "read_file_content") return Promise.resolve("");
        if (cmd === "get_file_info") return Promise.resolve(null);
        if (cmd === "git_branches") return Promise.resolve([]);
        return Promise.resolve([]);
      }
    );
    const { unmount } = render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );
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

  it("shows preflight status in utility cluster", () => {
    render(<App />);
    expect(screen.getByTestId("preflight-status")).toBeDefined();
  });

  it("shows a persistent visible 'claude' label, not just an icon, when Claude is selected", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          claude: "/usr/local/bin/claude",
          codex: null,
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
      return Promise.resolve([]);
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("preflight-status")).toHaveTextContent(
        /claude/i
      )
    );
  });

  it("starts dragging on a single mousedown, and toggles maximize on double-click, on the top chrome", () => {
    mockWindow.startDragging.mockClear();
    mockWindow.toggleMaximize.mockClear();
    render(<App />);
    const chrome = screen.getByTestId("top-chrome");

    fireEvent.mouseDown(chrome, { button: 0, detail: 1 });
    expect(mockWindow.startDragging).toHaveBeenCalledTimes(1);
    expect(mockWindow.toggleMaximize).not.toHaveBeenCalled();

    fireEvent.mouseDown(chrome, { button: 0, detail: 2 });
    expect(mockWindow.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("does not drag/maximize when mousedown originates on an excluded chrome button", () => {
    mockWindow.startDragging.mockClear();
    render(<App />);
    fireEvent.mouseDown(screen.getByTestId("toggle-left-sidebar"), {
      button: 0,
      detail: 1,
    });
    expect(mockWindow.startDragging).not.toHaveBeenCalled();
  });

  it("shows a hover tooltip on top-chrome icon buttons instead of a native title attribute", async () => {
    render(<App />);
    const button = screen.getByTestId("toggle-left-sidebar");
    expect(button).not.toHaveAttribute("title");

    await userEvent.hover(button);
    expect(
      await screen.findByRole("tooltip", { name: /toggle left sidebar/i })
    ).toBeInTheDocument();
  });
});

describe("Navigation rail — File Explorer only (D57)", () => {
  it("renders at 193px width by default and is resizable", () => {
    render(<App />);
    const rail = screen.getByTestId("nav-rail");
    expect(rail.style.getPropertyValue("--rail-w")).toBe("193px");
    expect(screen.getByTestId("resize-left-rail")).toBeDefined();
  });

  it("has a visible toggle button that collapses/restores it", async () => {
    const { unmount } = render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );
    const rail = screen.getByTestId("nav-rail");
    const toggle = screen.getByTestId("toggle-left-sidebar");

    fireEvent.click(toggle);
    expect(rail.style.marginLeft).not.toBe("0px");
    expect(screen.queryByTestId("resize-left-rail")).toBeNull();

    fireEvent.click(toggle);
    expect(rail.style.marginLeft).toBe("0px");
    expect(screen.getByTestId("resize-left-rail")).toBeDefined();
    unmount();
  });

  it("contains only the file tree — no Workspace picker or Threads list", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("file-tree")).toBeDefined());
    const rail = screen.getByTestId("nav-rail");
    expect(rail.querySelector('[data-testid="file-tree"]')).not.toBeNull();
    expect(rail.querySelector('[data-testid="project-picker"]')).toBeNull();
    expect(rail.querySelector('[data-testid="thread-list"]')).toBeNull();
    expect(rail.querySelector('[data-testid="new-thread"]')).toBeNull();
  });
});

describe("Right sidebar — Workspace + Threads (D57)", () => {
  it("has workspace selector with project picker", () => {
    render(<App />);
    expect(screen.getByTestId("project-picker")).toBeDefined();
  });

  it("has a New Thread button, reachable by opening the Threads & Codebase Map disclosure", () => {
    render(<App />);
    expect(screen.queryByTestId("new-thread")).toBeNull();
    fireEvent.click(screen.getByTestId("rail-disclosure-toggle"));
    expect(screen.getByTestId("new-thread")).toBeDefined();
  });

  it("has a thread list, reachable by opening the Threads & Codebase Map disclosure", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("rail-disclosure-toggle"));
    expect(screen.getByTestId("thread-list")).toBeDefined();
  });

  it("defaults to the Threads tab inside the disclosure, and keeps Workspace visible when switching tabs", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );
    // Disclosure is collapsed by default (editor-collapsible-rail spec).
    expect(screen.queryByTestId("rail-disclosure-body")).toBeNull();

    fireEvent.click(screen.getByTestId("rail-disclosure-toggle"));
    expect(screen.getByTestId("tab-threads")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByTestId("thread-list")).toBeDefined();
    expect(screen.getByTestId("new-thread")).toBeDefined();

    fireEvent.click(screen.getByTestId("tab-codemap"));
    expect(screen.getByTestId("tab-codemap")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    // Workspace stays pinned above the disclosure regardless of which inner tab is active;
    // New Thread lives inside the Threads pane itself, so it hides with it.
    expect(screen.getByTestId("project-picker")).toBeDefined();
    expect(screen.queryByTestId("new-thread")).toBeNull();
  });

  it("opens a Vibe/Spec picker on New Thread, and seeds go-mode when Vibe is picked", async () => {
    const setModeCalls: Record<string, unknown>[] = [];
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/floo-network",
              displayName: "floo-network",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "create_thread") {
          return Promise.resolve({
            id: "thread-new",
            projectHash: "proj-1",
            title: "New thread",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
            openSpecChangeName: null,
            executorSessionId: null,
          });
        }
        if (cmd === "set_thread_mode") {
          setModeCalls.push(args ?? {});
          return Promise.resolve({
            id: "thread-new",
            projectHash: "proj-1",
            title: "New thread",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: args?.mode,
            openSpecChangeName: null,
            executorSessionId: null,
          });
        }
        if (cmd === "list_threads") {
          return Promise.resolve([
            {
              id: "thread-new",
              projectHash: "proj-1",
              title: "New thread",
              createdAt: "2026-08-06T00:00:00Z",
              updatedAt: "2026-08-06T00:00:00Z",
              currentMode: "go",
              openSpecChangeName: null,
              executorSessionId: null,
            },
          ]);
        }
        if (cmd === "preflight") {
          return Promise.resolve({
            claude: null,
            codex: null,
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

    fireEvent.click(screen.getByTestId("rail-disclosure-toggle"));
    await waitFor(() => expect(screen.getByTestId("new-thread")).toBeDefined());
    fireEvent.click(screen.getByTestId("new-thread"));

    // Opening the picker collapses the disclosure — the picker renders
    // inline in the chat surface below it, not a modal.
    expect(screen.queryByTestId("rail-disclosure-body")).toBeNull();
    expect(screen.getByTestId("mode-picker")).toBeDefined();
    expect(screen.getByTestId("pick-vibe")).toBeDefined();
    expect(screen.getByTestId("pick-spec")).toBeDefined();

    fireEvent.click(screen.getByTestId("pick-vibe"));

    await waitFor(() => expect(screen.queryByTestId("mode-picker")).toBeNull());
    expect(setModeCalls).toEqual([
      { projectHash: "proj-1", threadId: "thread-new", mode: "go" },
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("New thread")
    );
  });

  it("seeds spec-mode when Spec is picked from the new-thread picker", async () => {
    const setModeCalls: Record<string, unknown>[] = [];
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/floo-network",
              displayName: "floo-network",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "create_thread") {
          return Promise.resolve({
            id: "thread-new",
            projectHash: "proj-1",
            title: "New thread",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
            openSpecChangeName: null,
            executorSessionId: null,
          });
        }
        if (cmd === "set_thread_mode") {
          setModeCalls.push(args ?? {});
          return Promise.resolve({
            id: "thread-new",
            projectHash: "proj-1",
            title: "New thread",
            createdAt: "2026-08-06T00:00:00Z",
            updatedAt: "2026-08-06T00:00:00Z",
            currentMode: args?.mode,
            openSpecChangeName: null,
            executorSessionId: null,
          });
        }
        if (cmd === "list_threads") {
          return Promise.resolve([
            {
              id: "thread-new",
              projectHash: "proj-1",
              title: "New thread",
              createdAt: "2026-08-06T00:00:00Z",
              updatedAt: "2026-08-06T00:00:00Z",
              currentMode: "spec",
              openSpecChangeName: null,
              executorSessionId: null,
            },
          ]);
        }
        if (cmd === "preflight") {
          return Promise.resolve({
            claude: null,
            codex: null,
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

    fireEvent.click(screen.getByTestId("rail-disclosure-toggle"));
    await waitFor(() => expect(screen.getByTestId("new-thread")).toBeDefined());
    fireEvent.click(screen.getByTestId("new-thread"));
    fireEvent.click(screen.getByTestId("pick-spec"));

    await waitFor(() => expect(screen.queryByTestId("mode-picker")).toBeNull());
    expect(setModeCalls).toEqual([
      { projectHash: "proj-1", threadId: "thread-new", mode: "spec" },
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("spec-banner")).toBeDefined()
    );
  });

  it("has add project button", () => {
    render(<App />);
    expect(screen.getByTestId("add-project")).toBeDefined();
  });

  it("has no standalone /propose button, but /propose still works as a composer slash command", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/floo-network",
              displayName: "floo-network",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/floo-network",
            displayName: "floo-network",
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
              currentMode: "spec",
              openSpecChangeName: null,
              executorSessionId: null,
            },
          ]);
        }
        if (cmd === "read_thread") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            claude: "/usr/local/bin/claude",
            codex: null,
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
        if (cmd === "load_graphify")
          return Promise.resolve({
            outDir: "",
            report: "",
            graph: null,
            summary: "",
          });
        if (cmd === "list_directory") return Promise.resolve([]);
        if (cmd === "propose") return Promise.resolve();
        return Promise.resolve([]);
      }
    );

    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );
    expect(screen.queryByTestId("propose")).toBeNull();

    fireEvent.change(screen.getByTestId("composer-input"), {
      target: { value: "/propose" },
    });
    fireEvent.submit(screen.getByTestId("composer-input").closest("form")!);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("propose", {
        projectHash: "proj-1",
        threadId: "t1",
      })
    );
  });
});

describe("Editor chrome (merged-design v2)", () => {
  it("renders editor tabs", () => {
    render(<App />);
    expect(screen.getByTestId("editor-tabs")).toBeDefined();
  });

  it("reaches the diff through a button, not a tab competing with the open files", () => {
    render(<App />);
    // The tab strip belongs to the files being edited; the diff is a view
    // you toggle into from the far right of it.
    expect(screen.getByTestId("toggle-diff")).toBeDefined();
    expect(screen.queryByTestId("tab-diff")).toBeNull();
    expect(screen.queryByTestId("tab-chat")).toBeNull();
  });

  it("starts on the editor with the diff toggle unpressed and no files open", () => {
    render(<App />);
    expect(screen.getByTestId("toggle-diff")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    expect(screen.queryAllByTestId("file-tab")).toHaveLength(0);
  });

  it("renders breadcrumbs", () => {
    render(<App />);
    expect(screen.getByTestId("breadcrumbs")).toBeDefined();
  });

  it("has no leftover status bar", () => {
    render(<App />);
    expect(screen.queryByTestId("status-bar")).toBeNull();
  });

  it("shows the file editor even when no thread exists", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("file-tree")).toBeDefined());
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

  it("shows the diff empty state even when no thread exists", async () => {
    render(<App />);

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
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );
    fireEvent.click(screen.getByTestId("open-settings"));

    expect(screen.getByTestId("settings-panel")).toBeDefined();
    expect(screen.getAllByTestId("accent-swatch").length).toBeGreaterThan(0);
    expect(screen.getByTestId("editor-font-select")).toBeDefined();
  });

  it("opens an existing .project-settings.json in the editor without recreating it", async () => {
    const writeCalls: unknown[] = [];
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/floo-network",
              displayName: "floo-network",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "preflight") {
          return Promise.resolve({
            claude: "/usr/local/bin/claude",
            codex: null,
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
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );
    fireEvent.click(screen.getByTestId("open-settings"));
    fireEvent.click(screen.getByTestId("open-project-settings"));

    await waitFor(() =>
      expect(screen.getByTestId("breadcrumbs").textContent).toContain(
        ".project-settings.json"
      )
    );
    expect(writeCalls).toHaveLength(0);
  });

  it("creates .project-settings.json with defaults when none exists yet", async () => {
    const writeCalls: Record<string, unknown>[] = [];
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/floo-network",
              displayName: "floo-network",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "preflight") {
          return Promise.resolve({
            claude: "/usr/local/bin/claude",
            codex: null,
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
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );
    fireEvent.click(screen.getByTestId("open-settings"));
    fireEvent.click(screen.getByTestId("open-project-settings"));

    await waitFor(() => expect(writeCalls).toHaveLength(1));
    expect(writeCalls[0].relativePath).toBe(".project-settings.json");
    expect(String(writeCalls[0].content)).toContain("formatOnSave");
    await waitFor(() =>
      expect(screen.getByTestId("breadcrumbs").textContent).toContain(
        ".project-settings.json"
      )
    );
  });
});

describe("Right sidebar (merged-design v2)", () => {
  it("renders right sidebar", () => {
    render(<App />);
    expect(screen.getByTestId("right-sidebar")).toBeDefined();
  });

  it("has Threads and Code Map tabs inside the disclosure, and no leftover Notes tab", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("rail-disclosure-toggle"));
    expect(screen.getByTestId("tab-threads")).toBeDefined();
    expect(screen.getByTestId("tab-codemap")).toBeDefined();
    expect(screen.queryByTestId("tab-notes")).toBeNull();
  });

  it("has no leftover Files tab (superseded by the file explorer column)", () => {
    render(<App />);
    expect(screen.queryByTestId("tab-files")).toBeNull();
  });

  it("is open by default at 300px (D57 — Workspace + Threads are load-bearing, not optional)", () => {
    render(<App />);
    const sidebar = screen.getByTestId("right-sidebar");
    expect(sidebar.style.marginRight).toBe("0px");
    expect(sidebar.style.getPropertyValue("--panel-w")).toBe("300px");
    expect(screen.getByTestId("resize-right-panel")).toBeDefined();
  });

  it("collapses via the toggle and restores on a second click", () => {
    render(<App />);
    const sidebar = screen.getByTestId("right-sidebar");
    const toggle = screen.getByTestId("toggle-right-sidebar");

    fireEvent.click(toggle);
    expect(sidebar.style.marginRight).not.toBe("0px");
    expect(screen.queryByTestId("resize-right-panel")).toBeNull();

    fireEvent.click(toggle);
    expect(sidebar.style.marginRight).toBe("0px");
    expect(screen.getByTestId("resize-right-panel")).toBeDefined();
  });
});

describe("Resizable layout persistence", () => {
  it("persists left rail width via drag and rehydrates on remount", async () => {
    const { unmount } = render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );

    fireEvent.pointerDown(screen.getByTestId("resize-left-rail"), {
      clientX: 200,
    });
    fireEvent.pointerMove(window, { clientX: 260 });
    fireEvent.pointerUp(window);
    expect(
      screen.getByTestId("nav-rail").style.getPropertyValue("--rail-w")
    ).toBe("253px");

    unmount();
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );
    expect(
      screen.getByTestId("nav-rail").style.getPropertyValue("--rail-w")
    ).toBe("253px");
  });

  it("disables text selection on the body while dragging a handle, restores it on release", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );

    expect(document.body.style.userSelect).not.toBe("none");

    fireEvent.pointerDown(screen.getByTestId("resize-left-rail"), {
      clientX: 200,
    });
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerMove(window, { clientX: 260 });
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerUp(window);
    expect(document.body.style.userSelect).not.toBe("none");
  });

  it("collapses and restores the left rail via Cmd+\\, persisted across remount", async () => {
    const { unmount } = render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );

    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(screen.getByTestId("nav-rail").style.marginLeft).not.toBe("0px");
    expect(screen.queryByTestId("resize-left-rail")).toBeNull();

    unmount();
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );
    expect(screen.getByTestId("nav-rail").style.marginLeft).not.toBe("0px");

    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(screen.getByTestId("nav-rail").style.marginLeft).toBe("0px");
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
              root: "/tmp/floo-network",
              displayName: "floo-network",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/floo-network",
            displayName: "floo-network",
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
            claude: null,
            codex: null,
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
    fireEvent.click(screen.getByTestId("rail-disclosure-toggle"));
    const threadList = screen.getByTestId("thread-list");
    // Scoped to the thread list: the selected thread's title also appears in the always-visible chat header below.
    await waitFor(() =>
      expect(within(threadList).getByText("Thread A")).toBeDefined()
    );
    const rowB = within(threadList).getByText("Thread B").closest("li")!;
    expect(rowB).toHaveAttribute("tabIndex", "0");

    fireEvent.keyDown(rowB, { key: "Enter" });

    // Selecting a thread collapses the disclosure (editor-collapsible-rail spec)
    // and the chat header below reflects the newly-selected thread.
    await waitFor(() => expect(screen.queryByTestId("thread-list")).toBeNull());
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
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/floo-network",
          displayName: "floo-network",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          claude: null,
          codex: null,
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
    await waitFor(() =>
      expect(screen.getByTestId("branch-indicator")).toBeDefined()
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
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/floo-network",
          displayName: "floo-network",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          claude: null,
          codex: null,
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
    await waitFor(() =>
      expect(screen.getByTestId("branch-indicator")).toBeDefined()
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
              root: "/tmp/floo-network",
              displayName: "floo-network",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            claude: null,
            codex: null,
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
            claude: null,
            codex: null,
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
    fireEvent.change(screen.getByTestId("project-picker"), {
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
              root: "/tmp/floo-network",
              displayName: "floo-network",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            claude: null,
            codex: null,
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
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/floo-network",
          displayName: "floo-network",
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
          claude: null,
          codex: null,
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
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/floo-network",
          displayName: "floo-network",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          claude: null,
          codex: null,
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
    await waitFor(() =>
      expect(screen.getByTestId("branch-indicator")).toBeDefined()
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
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/floo-network",
          displayName: "floo-network",
          createdAt: "2026-08-06T00:00:00Z",
          lastAccessedAt: "2026-08-06T00:00:00Z",
        });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          claude: null,
          codex: null,
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
    await waitFor(() =>
      expect(screen.getByTestId("branch-indicator")).toBeDefined()
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
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
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
    localStorage.removeItem("floo:theme");
    delete document.documentElement.dataset.theme;
  });

  it("cycles auto -> light -> dark -> auto and stamps data-theme on <html>", () => {
    render(<App />);
    const toggle = screen.getByTestId("theme-toggle");
    expect(toggle.textContent).toBe("Auto");
    expect(document.documentElement.dataset.theme).toBeUndefined();

    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("Light");
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("Dark");
    expect(document.documentElement.dataset.theme).toBe("dark");

    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("Auto");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("First-run onboarding", () => {
  it("shows an explanation and a prominent Add Project action when there are no projects yet, instead of a bare sentence", async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          claude: null,
          codex: null,
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
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("onboarding-empty")).toBeDefined()
    );
    expect(
      screen.getByRole("heading", { level: 2, name: /floo network/i })
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /add a project/i }));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true })
    );
  });
});

describe("Workspace shell toggle (vibe-editor-shell-redesign)", () => {
  it("renders a Vibe/Editor toggle in the top chrome, with Editor active by default", () => {
    render(<App />);
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
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );
    expect(screen.getByTestId("editor-shell")).toBeDefined();
    expect(screen.queryByTestId("vibe-shell")).toBeNull();

    fireEvent.click(screen.getByTestId("shell-vibe"));

    expect(screen.queryByTestId("editor-shell")).toBeNull();
    expect(screen.getByTestId("vibe-shell")).toBeDefined();
    expect(screen.getByTestId("project-picker")).toHaveValue("proj-1");
  });

  it("switching shells does not call set_thread_mode or change the active thread's mode", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/floo-network",
              displayName: "floo-network",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/floo-network",
            displayName: "floo-network",
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
            claude: null,
            codex: null,
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
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );

    fireEvent.click(screen.getByTestId("shell-editor"));
    fireEvent.click(screen.getByTestId("shell-vibe"));

    expect(invokeMock).not.toHaveBeenCalledWith(
      "set_thread_mode",
      expect.anything()
    );
  });

  it("Vibe shell renders no Codebase Map control anywhere", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("shell-vibe"));
    expect(screen.queryByTestId("tab-codemap")).toBeNull();
    expect(screen.queryByTestId("graph-pane")).toBeNull();
  });
});

describe("Vibe shell layout (vibe-editor-shell-redesign)", () => {
  it("renders chat as the main column, not a tab", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );

    expect(screen.getByTestId("vibe-chat-column")).toBeDefined();
    // No Editor/Diff-style tab bar gates the chat column — it's always the main view.
    expect(screen.queryByTestId("editor-tabs")).toBeNull();
  });

  it("has an Edited Files column showing diff/turn-history content", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );

    expect(screen.getByTestId("col-files")).toBeDefined();
    expect(screen.getByTestId("vibe-files-content")).toBeDefined();
  });

  it("renders the file tree inside a collapsed-by-default File Explorer disclosure in the right rail", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );

    expect(screen.getByTestId("vibe-explorer-toggle")).toBeDefined();
    expect(screen.queryByTestId("vibe-explorer-body")).toBeNull();
    expect(screen.queryByTestId("file-tree")).toBeNull();

    fireEvent.click(screen.getByTestId("vibe-explorer-toggle"));
    await waitFor(() => expect(screen.getByTestId("file-tree")).toBeDefined());
  });

  it("opening a file from the File Explorer shows it in the Edited Files column", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "list_projects") {
          return Promise.resolve([
            {
              hash: "proj-1",
              root: "/tmp/floo-network",
              displayName: "floo-network",
              createdAt: "2026-08-06T00:00:00Z",
              lastAccessedAt: "2026-08-06T00:00:00Z",
            },
          ]);
        }
        if (cmd === "switch_project") {
          return Promise.resolve({
            hash: "proj-1",
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          });
        }
        if (cmd === "list_threads") return Promise.resolve([]);
        if (cmd === "preflight") {
          return Promise.resolve({
            claude: null,
            codex: null,
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
          if (relativePath === "")
            return Promise.resolve([
              { name: "a.ts", is_dir: false, path: "a.ts" },
            ]);
          return Promise.resolve([]);
        }
        if (cmd === "read_file_content") return Promise.resolve("content\n");
        return Promise.resolve([]);
      }
    );

    render(<App />);
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );

    fireEvent.click(screen.getByTestId("vibe-explorer-toggle"));
    await waitFor(() => expect(screen.getByText("a.ts")).toBeDefined());
    fireEvent.click(screen.getByText("a.ts"));

    // Vibe shows the active file rather than a full tab strip, and now
    // lands on the file instead of on the changes view.
    await waitFor(() =>
      expect(screen.getByTestId("vibe-active-file")).toBeDefined()
    );
    expect(screen.getByTestId("vibe-toggle-diff")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain(
        "content"
      )
    );
  });

  it("renders the chat column at 520px by default with a resizer", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );

    const chat = screen.getByTestId("vibe-chat-column");
    expect(chat.style.getPropertyValue("--vibe-chat-w")).toBe("520px");
    expect(screen.getByTestId("resize-vibe-chat")).toBeDefined();
  });

  it("drags the resizer to resize the chat column and persists the width", async () => {
    const { unmount } = render(<App />);
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );

    const handle = screen.getByTestId("resize-vibe-chat");
    fireEvent.pointerDown(handle, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 560 });
    fireEvent.pointerUp(window);
    expect(
      screen
        .getByTestId("vibe-chat-column")
        .style.getPropertyValue("--vibe-chat-w")
    ).toBe("580px");

    unmount();
    render(<App />);
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );
    expect(
      screen
        .getByTestId("vibe-chat-column")
        .style.getPropertyValue("--vibe-chat-w")
    ).toBe("580px");
  });
});

describe("Command palette", () => {
  it("opens on Cmd+Shift+P and lists commands with their shortcuts", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
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

  it("filters as you type and runs the chosen command", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
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
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
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
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
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
          claude: null,
          codex: null,
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
      "floo:session:proj-1",
      JSON.stringify({ openPaths: ["a.ts", "b.ts"], activePath: "a.ts" })
    );
    invokeMock.mockImplementation(router());

    render(<App />);

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
      "floo:session:proj-1",
      JSON.stringify({ openPaths: ["a.ts", "deleted.ts"], activePath: "a.ts" })
    );
    invokeMock.mockImplementation(router(["deleted.ts"]));

    render(<App />);

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
      "floo:session:proj-1",
      JSON.stringify({ openPaths: [], activePath: null, centerShell: "vibe" })
    );
    invokeMock.mockImplementation(router());

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("vibe-shell")).toBeDefined());
  });

  it("records what is open so the next launch can restore it", async () => {
    invokeMock.mockImplementation(router());
    render(<App />);

    fireEvent.click(await screen.findByText("b.ts"));
    await waitFor(() =>
      expect(screen.getAllByTestId("file-tab")).toHaveLength(1)
    );

    await waitFor(() => {
      const saved = JSON.parse(
        localStorage.getItem("floo:session:proj-1") ?? "{}"
      );
      expect(saved.openPaths).toEqual(["b.ts"]);
      expect(saved.activePath).toBe("b.ts");
    });
  });
});

describe("Editor shell collapsible rail (vibe-editor-shell-redesign)", () => {
  it("renders the file tree on the left and Editor/Diff tabs in the center", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
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
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/floo-network",
          displayName: "floo-network",
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
          claude: null,
          codex: null,
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
            root: "/tmp/floo-network",
            displayName: "floo-network",
            createdAt: "2026-08-06T00:00:00Z",
            lastAccessedAt: "2026-08-06T00:00:00Z",
          },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({
          hash: "proj-1",
          root: "/tmp/floo-network",
          displayName: "floo-network",
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
          claude: null,
          codex: null,
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
    await waitFor(() =>
      expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A")
    );

    fireEvent.click(screen.getByTestId("rail-disclosure-toggle")); // click 1: open
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

  it("reaches Codebase Map in 2 clicks: open disclosure, then the Codebase Map tab", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );
    fireEvent.click(screen.getByTestId("rail-disclosure-toggle")); // click 1: open
    fireEvent.click(screen.getByTestId("tab-codemap")); // click 2: select
    expect(screen.getByTestId("graph-pane")).toBeDefined();
  });

  it("reaches Codebase Map in 3 clicks from the Vibe shell: switch to Editor, open disclosure, Codebase Map tab", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("project-picker")).toHaveValue("proj-1")
    );
    fireEvent.click(screen.getByTestId("shell-vibe"));
    expect(screen.queryByTestId("graph-pane")).toBeNull();

    fireEvent.click(screen.getByTestId("shell-editor")); // click 1
    fireEvent.click(screen.getByTestId("rail-disclosure-toggle")); // click 2
    fireEvent.click(screen.getByTestId("tab-codemap")); // click 3

    expect(screen.getByTestId("graph-pane")).toBeDefined();
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
            claude: null,
            codex: null,
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

    await waitFor(() => expect(screen.getByText("a.ts")).toBeDefined());
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() =>
      expect(screen.getByTestId("file-editor")).toBeDefined()
    );
    expect(
      screen.getByText("a.ts", { selector: ".ds-editor-path" })
    ).toBeDefined();

    fireEvent.change(screen.getByTestId("project-picker"), {
      target: { value: projB.hash },
    });

    await waitFor(() => expect(screen.getByText("b.ts")).toBeDefined());
    expect(screen.queryByTestId("file-editor")).toBeNull();
    expect(screen.getByText(/select a file/i)).toBeDefined();
  });
});

describe("Executor/model/bypass menu (vibe-editor-shell-redesign)", () => {
  afterEach(() => {
    localStorage.removeItem("floo:model");
    localStorage.removeItem("floo:bypass");
  });

  it("shows the current model in the top chrome and opens a menu on click", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          claude: "/usr/local/bin/claude",
          codex: null,
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
      return Promise.resolve([]);
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("model-btn")).toHaveTextContent("Sonnet 5")
    );
    expect(screen.queryByTestId("model-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("model-btn"));
    expect(await screen.findByTestId("model-menu")).toBeDefined();
  });

  it("shows the executor as read-only status in the menu, with no control to switch it", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          claude: "/usr/local/bin/claude",
          codex: null,
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
      return Promise.resolve([]);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("model-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("model-btn"));

    const executorRow = await screen.findByTestId("executor-row");
    expect(executorRow.tagName).not.toBe("BUTTON");
    expect(executorRow).toHaveTextContent(/claude/i);
  });

  it("lets the user pick a model, persisting the choice across menu close/reopen", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("model-btn"));
    fireEvent.click(await screen.findByTestId("model-opt-opus-5"));

    expect(localStorage.getItem("floo:model")).toBe("Opus 5");
    expect(screen.getByTestId("model-btn")).toHaveTextContent("Opus 5");
    await waitFor(() => expect(screen.queryByTestId("model-menu")).toBeNull());

    fireEvent.click(screen.getByTestId("model-btn"));
    expect((await screen.findByTestId("model-opt-opus-5")).className).toMatch(
      /selected/
    );
  });

  it("has a bypass-permissions toggle, default off, that flips on and persists across menu reopen", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("model-btn"));
    const toggle = await screen.findByTestId("bypass-toggle");
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(localStorage.getItem("floo:bypass")).toBe("1");

    fireEvent.click(screen.getByTestId("model-btn")); // close
    fireEvent.click(screen.getByTestId("model-btn")); // reopen
    expect(await screen.findByTestId("bypass-toggle")).toBeChecked();
  });
});
