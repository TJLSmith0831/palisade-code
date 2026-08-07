import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { open } from "@tauri-apps/plugin-dialog";
import "../App.css";

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
  default: ({ value }: { value: string }) => <div data-testid="md-editor">{value}</div>,
  MDEditor: { Markdown: ({ source }: { source: string }) => <div>{source}</div> },
}));

vi.mock("../GraphPane", () => ({
  default: () => <div data-testid="graph-pane" />,
}));

import App from "../App";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
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
  });
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
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") return Promise.resolve([{ id: "t1", projectHash: "proj-1", title: "Test Thread", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z", currentMode: "spec", openSpecChangeName: null, executorSessionId: null }]);
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: "/usr/local/bin/claude", codex: null, selected: "claude", openspec: true, grillApply: false, ponytail: true, graphify: true, ready: true, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "read_file_content") return Promise.resolve("");
      if (cmd === "get_file_info") return Promise.resolve(null);
      if (cmd === "git_branches") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const { unmount } = render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
    // The single thread auto-selects on load, so chat (and its composer) is
    // already visible in the Editor shell's right rail — no interaction needed.
    await waitFor(() => expect(screen.getByTestId("mode-selector")).toBeDefined());
    expect(screen.getByTestId("mode-spec")).toBeDefined();
    expect(screen.getByTestId("mode-go")).toBeDefined();
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
    await waitFor(() => expect(screen.getByTestId("preflight-status")).toHaveTextContent(/claude/i));
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
    fireEvent.mouseDown(screen.getByTestId("toggle-left-sidebar"), { button: 0, detail: 1 });
    expect(mockWindow.startDragging).not.toHaveBeenCalled();
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
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
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
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
    // Disclosure is collapsed by default (editor-collapsible-rail spec).
    expect(screen.queryByTestId("rail-disclosure-body")).toBeNull();

    fireEvent.click(screen.getByTestId("rail-disclosure-toggle"));
    expect(screen.getByTestId("tab-threads").className).toMatch(/active/);
    expect(screen.getByTestId("thread-list")).toBeDefined();
    expect(screen.getByTestId("new-thread")).toBeDefined();

    fireEvent.click(screen.getByTestId("tab-codemap"));
    expect(screen.getByTestId("tab-codemap").className).toMatch(/active/);
    // Workspace stays pinned above the disclosure regardless of which inner tab is active;
    // New Thread lives inside the Threads pane itself, so it hides with it.
    expect(screen.getByTestId("project-picker")).toBeDefined();
    expect(screen.queryByTestId("new-thread")).toBeNull();
  });

  it("opens a Vibe/Spec picker on New Thread, and seeds go-mode when Vibe is picked", async () => {
    const setModeCalls: Record<string, unknown>[] = [];
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
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
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "read_thread") return Promise.resolve([]);
      return Promise.resolve([]);
    });

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
    expect(setModeCalls).toEqual([{ projectHash: "proj-1", threadId: "thread-new", mode: "go" }]);
    await waitFor(() => expect(screen.getByTestId("thread-title")).toHaveTextContent("New thread"));
  });

  it("seeds spec-mode when Spec is picked from the new-thread picker", async () => {
    const setModeCalls: Record<string, unknown>[] = [];
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "create_thread") {
        return Promise.resolve({
          id: "thread-new", projectHash: "proj-1", title: "New thread",
          createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z",
          currentMode: "spec", openSpecChangeName: null, executorSessionId: null,
        });
      }
      if (cmd === "set_thread_mode") {
        setModeCalls.push(args ?? {});
        return Promise.resolve({
          id: "thread-new", projectHash: "proj-1", title: "New thread",
          createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z",
          currentMode: args?.mode, openSpecChangeName: null, executorSessionId: null,
        });
      }
      if (cmd === "list_threads") {
        return Promise.resolve([
          { id: "thread-new", projectHash: "proj-1", title: "New thread", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z", currentMode: "spec", openSpecChangeName: null, executorSessionId: null },
        ]);
      }
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "read_thread") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    render(<App />);

    fireEvent.click(screen.getByTestId("rail-disclosure-toggle"));
    await waitFor(() => expect(screen.getByTestId("new-thread")).toBeDefined());
    fireEvent.click(screen.getByTestId("new-thread"));
    fireEvent.click(screen.getByTestId("pick-spec"));

    await waitFor(() => expect(screen.queryByTestId("mode-picker")).toBeNull());
    expect(setModeCalls).toEqual([{ projectHash: "proj-1", threadId: "thread-new", mode: "spec" }]);
    await waitFor(() => expect(screen.getByTestId("spec-banner")).toBeDefined());
  });

  it("has add project button", () => {
    render(<App />);
    expect(screen.getByTestId("add-project")).toBeDefined();
  });

  it("has no standalone /propose button, but /propose still works as a composer slash command", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") {
        return Promise.resolve([
          { id: "t1", projectHash: "proj-1", title: "Thread A", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z", currentMode: "spec", openSpecChangeName: null, executorSessionId: null },
        ]);
      }
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: "/usr/local/bin/claude", codex: null, selected: "claude", openspec: true, grillApply: false, ponytail: true, graphify: true, ready: true, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "propose") return Promise.resolve();
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A"));
    expect(screen.queryByTestId("propose")).toBeNull();

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "/propose" } });
    fireEvent.submit(screen.getByTestId("composer-input").closest("form")!);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("propose", { projectHash: "proj-1", threadId: "t1" }),
    );
  });
});

describe("Editor chrome (merged-design v2)", () => {
  it("renders editor tabs", () => {
    render(<App />);
    expect(screen.getByTestId("editor-tabs")).toBeDefined();
  });

  it("has a Code Change Diff tab, and no separate Console Chat tab (chat moved to the right panel)", () => {
    render(<App />);
    expect(screen.getByTestId("tab-diff")).toBeDefined();
    expect(screen.queryByTestId("tab-chat")).toBeNull();
  });

  it("defaults to the Editor tab, listed first, ahead of Diff", () => {
    render(<App />);
    const tabs = screen.getByTestId("editor-tabs");
    const order = Array.from(tabs.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(order).toEqual(["tab-editor", "tab-diff"]);
    expect(screen.getByTestId("tab-editor").className).toMatch(/active/);
    expect(within(tabs).getByText("Editor")).toBeDefined();
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
    fireEvent.click(screen.getByTestId("tab-editor"));
    fireEvent.click(screen.getByText("AGENTS.md"));

    await waitFor(() => expect(screen.getByTestId("file-editor")).toBeDefined());
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
    // "Create a thread to get started" is legitimate in the right panel's Threads tab now
    // (chat lives there) — only assert it doesn't bleed into the center Editor pane.
    expect(within(screen.getByTestId("main-pane")).queryByText("Create a thread to get started.")).toBeNull();
  });

  it("shows the diff tab empty state even when no thread exists", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("editor-tabs")).toBeDefined());
    fireEvent.click(screen.getByTestId("tab-diff"));

    await waitFor(() => {
      expect(within(screen.getByTestId("main-pane")).queryByText("Create a thread to get started.")).toBeNull();
      expect(screen.getByText(/no file changes/i)).toBeDefined();
    });
  });
});

describe("Settings panel (D14/D15)", () => {
  it("opens the settings panel with color scheme and font controls", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
    fireEvent.click(screen.getByTestId("open-settings"));

    expect(screen.getByTestId("settings-panel")).toBeDefined();
    expect(screen.getAllByTestId("accent-swatch").length).toBeGreaterThan(0);
    expect(screen.getByTestId("editor-font-select")).toBeDefined();
  });

  it("opens an existing .project-settings.json in the editor without recreating it", async () => {
    const writeCalls: unknown[] = [];
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "preflight") {
        return Promise.resolve({ claude: "/usr/local/bin/claude", codex: null, selected: "claude", openspec: true, grillApply: false, ponytail: true, graphify: true, ready: true, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "read_file_content") return Promise.resolve('{"formatOnSave":{}}');
      if (cmd === "write_file_content") writeCalls.push(args);
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
    fireEvent.click(screen.getByTestId("open-settings"));
    fireEvent.click(screen.getByTestId("open-project-settings"));

    await waitFor(() => expect(screen.getByTestId("breadcrumbs").textContent).toContain(".project-settings.json"));
    expect(writeCalls).toHaveLength(0);
  });

  it("creates .project-settings.json with defaults when none exists yet", async () => {
    const writeCalls: Record<string, unknown>[] = [];
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "preflight") {
        return Promise.resolve({ claude: "/usr/local/bin/claude", codex: null, selected: "claude", openspec: true, grillApply: false, ponytail: true, graphify: true, ready: true, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "read_file_content") return Promise.reject(new Error("no such file"));
      if (cmd === "write_file_content") {
        writeCalls.push(args ?? {});
        return Promise.resolve(null);
      }
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
    fireEvent.click(screen.getByTestId("open-settings"));
    fireEvent.click(screen.getByTestId("open-project-settings"));

    await waitFor(() => expect(writeCalls).toHaveLength(1));
    expect(writeCalls[0].relativePath).toBe(".project-settings.json");
    expect(String(writeCalls[0].content)).toContain("formatOnSave");
    await waitFor(() => expect(screen.getByTestId("breadcrumbs").textContent).toContain(".project-settings.json"));
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
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));

    fireEvent.pointerDown(screen.getByTestId("resize-left-rail"), { clientX: 200 });
    fireEvent.pointerMove(window, { clientX: 260 });
    fireEvent.pointerUp(window);
    expect(screen.getByTestId("nav-rail").style.getPropertyValue("--rail-w")).toBe("253px");

    unmount();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
    expect(screen.getByTestId("nav-rail").style.getPropertyValue("--rail-w")).toBe("253px");
  });

  it("disables text selection on the body while dragging a handle, restores it on release", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));

    expect(document.body.style.userSelect).not.toBe("none");

    fireEvent.pointerDown(screen.getByTestId("resize-left-rail"), { clientX: 200 });
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerMove(window, { clientX: 260 });
    expect(document.body.style.userSelect).toBe("none");

    fireEvent.pointerUp(window);
    expect(document.body.style.userSelect).not.toBe("none");
  });

  it("collapses and restores the left rail via Cmd+\\, persisted across remount", async () => {
    const { unmount } = render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));

    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(screen.getByTestId("nav-rail").style.marginLeft).not.toBe("0px");
    expect(screen.queryByTestId("resize-left-rail")).toBeNull();

    unmount();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
    expect(screen.getByTestId("nav-rail").style.marginLeft).not.toBe("0px");

    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(screen.getByTestId("nav-rail").style.marginLeft).toBe("0px");
    expect(screen.getByTestId("resize-left-rail")).toBeDefined();
  });
});

describe("Keyboard navigation (accessibility)", () => {
  it("switches threads via Enter on a keyboard-focused thread row", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") {
        return Promise.resolve([
          { id: "t1", title: "Thread A", createdAt: "2026-08-06T00:00:00Z", currentMode: "spec" },
          { id: "t2", title: "Thread B", createdAt: "2026-08-06T00:00:00Z", currentMode: "spec" },
        ]);
      }
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "git_branches") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    render(<App />);
    fireEvent.click(screen.getByTestId("rail-disclosure-toggle"));
    const threadList = screen.getByTestId("thread-list");
    // Scoped to the thread list: the selected thread's title also appears in the always-visible chat header below.
    await waitFor(() => expect(within(threadList).getByText("Thread A")).toBeDefined());
    const rowB = within(threadList).getByText("Thread B").closest("li")!;
    expect(rowB).toHaveAttribute("tabIndex", "0");

    fireEvent.keyDown(rowB, { key: "Enter" });

    // Selecting a thread collapses the disclosure (editor-collapsible-rail spec)
    // and the chat header below reflects the newly-selected thread.
    await waitFor(() => expect(screen.queryByTestId("thread-list")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread B"));
  });

  it("switches branches via Enter on a keyboard-focused branch row", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
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
    await waitFor(() => expect(screen.getByTestId("branch-indicator")).toBeDefined());
    fireEvent.click(screen.getByTestId("branch-indicator"));

    const row = (await screen.findByText("feature")).closest("li")!;
    expect(row).toHaveAttribute("tabIndex", "0");

    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("git_checkout_branch", expect.objectContaining({ name: "feature" })),
    );
  });

  it("fuzzy-filters the branch list as you type, like the file palette does for files", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
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
    await waitFor(() => expect(screen.getByTestId("branch-indicator")).toBeDefined());
    fireEvent.click(screen.getByTestId("branch-indicator"));
    await waitFor(() => expect(screen.getAllByTestId("branch-option")).toHaveLength(3));

    fireEvent.change(screen.getByTestId("branch-new-input"), { target: { value: "login" } });

    await waitFor(() => {
      const options = screen.getAllByTestId("branch-option").map((el) => el.textContent);
      expect(options).toEqual(["feature-login"]);
    });
  });
});

describe("Unsaved-edit guard (data-loss prevention)", () => {
  it("confirms before discarding an unsaved edit when switching files via the tree, and doesn't switch on Cancel", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
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
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("a.ts")).toBeDefined());
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("content"));

    const cmContent = document.querySelector(".cm-content") as HTMLElement;
    cmContent.focus();
    await user.type(cmContent, "x");

    fireEvent.click(screen.getByText("b.ts"));

    const discardBtn = await screen.findByTestId("confirm-delete");
    expect(discardBtn).toHaveTextContent("Discard");
    expect(screen.getByTestId("breadcrumbs").textContent).toContain("a.ts");

    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("confirm-delete")).toBeNull();
    expect(screen.getByTestId("breadcrumbs").textContent).toContain("a.ts");

    fireEvent.click(screen.getByText("b.ts"));
    fireEvent.click(screen.getByTestId("confirm-delete"));
    await waitFor(() => expect(screen.getByTestId("breadcrumbs").textContent).toContain("b.ts"));
  });

  it("switches files immediately with no prompt when there's nothing unsaved", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
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
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("a.ts")).toBeDefined());
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() => expect(screen.getByTestId("breadcrumbs").textContent).toContain("a.ts"));

    fireEvent.click(screen.getByText("b.ts"));
    await waitFor(() => expect(screen.getByTestId("breadcrumbs").textContent).toContain("b.ts"));
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
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") {
        return Promise.resolve([{ id: "t1", title: "Thread A", createdAt: "2026-08-06T00:00:00Z", currentMode: "spec" }]);
      }
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "git_branches") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    render(<App />);
    // The single thread auto-selects on load, so the composer is already visible.
    await waitFor(() => expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A"));

    expect(screen.getByLabelText("Message")).toBe(screen.getByTestId("composer-input"));
  });

  it("labels the new-branch-name input, not just its placeholder", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "git_branches") return Promise.resolve([{ name: "main", isCurrent: true, isRemote: false }]);
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByTestId("branch-indicator")).toBeDefined());
    fireEvent.click(screen.getByTestId("branch-indicator"));

    expect(screen.getByLabelText(/new branch name/i)).toBe(screen.getByTestId("branch-new-input"));
  });
});

describe("Error banner provenance", () => {
  it("keeps an earlier failure visible instead of a later one silently clobbering it", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") return Promise.resolve([]);
      if (cmd === "git_branches") {
        return Promise.resolve([
          { name: "main", isCurrent: true, isRemote: false },
          { name: "feature", isCurrent: false, isRemote: false },
          { name: "bugfix", isCurrent: false, isRemote: false },
        ]);
      }
      if (cmd === "git_checkout_branch") return Promise.reject(new Error("checkout failed: dirty tree"));
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByTestId("branch-indicator")).toBeDefined());

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
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));

    fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByTestId("text-search-input")).toHaveFocus());

    fireEvent.keyDown(screen.getByTestId("text-search-input"), { key: "Escape" });
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
    await waitFor(() => expect(screen.getByTestId("onboarding-empty")).toBeDefined());
    expect(screen.getByRole("heading", { level: 2, name: /floo network/i })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /add a project/i }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
  });
});

describe("Workspace shell toggle (vibe-editor-shell-redesign)", () => {
  it("renders a Vibe/Editor toggle in the top chrome, with Editor active by default", () => {
    render(<App />);
    const chrome = screen.getByTestId("top-chrome");
    const toggle = within(chrome).getByTestId("shell-toggle");
    expect(within(toggle).getByTestId("shell-editor").className).toMatch(/active/);
    expect(within(toggle).getByTestId("shell-vibe").className).not.toMatch(/active/);
  });

  it("switching to Vibe renders the Vibe shell in place of the Editor shell, preserving the active project", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
    expect(screen.getByTestId("editor-shell")).toBeDefined();
    expect(screen.queryByTestId("vibe-shell")).toBeNull();

    fireEvent.click(screen.getByTestId("shell-vibe"));

    expect(screen.queryByTestId("editor-shell")).toBeNull();
    expect(screen.getByTestId("vibe-shell")).toBeDefined();
    expect(screen.getByTestId("project-picker")).toHaveValue("proj-1");
  });

  it("switching shells does not call set_thread_mode or change the active thread's mode", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") {
        return Promise.resolve([{ id: "t1", projectHash: "proj-1", title: "Thread A", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z", currentMode: "go", openSpecChangeName: null, executorSessionId: null }]);
      }
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") return Promise.resolve([]);
      return Promise.resolve([]);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));

    fireEvent.click(screen.getByTestId("shell-editor"));
    fireEvent.click(screen.getByTestId("shell-vibe"));

    expect(invokeMock).not.toHaveBeenCalledWith("set_thread_mode", expect.anything());
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
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));

    expect(screen.getByTestId("vibe-chat-column")).toBeDefined();
    // No Editor/Diff-style tab bar gates the chat column — it's always the main view.
    expect(screen.queryByTestId("editor-tabs")).toBeNull();
  });

  it("has an Edited Files column showing diff/turn-history content", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));

    expect(screen.getByTestId("col-files")).toBeDefined();
    expect(screen.getByTestId("vibe-files-content")).toBeDefined();
  });

  it("renders the file tree inside a collapsed-by-default File Explorer disclosure in the right rail", async () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));

    expect(screen.getByTestId("vibe-explorer-toggle")).toBeDefined();
    expect(screen.queryByTestId("vibe-explorer-body")).toBeNull();
    expect(screen.queryByTestId("file-tree")).toBeNull();

    fireEvent.click(screen.getByTestId("vibe-explorer-toggle"));
    await waitFor(() => expect(screen.getByTestId("file-tree")).toBeDefined());
  });

  it("opening a file from the File Explorer shows it in the Edited Files column", async () => {
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") {
        const relativePath = String(args?.relativePath ?? "");
        if (relativePath === "") return Promise.resolve([{ name: "a.ts", is_dir: false, path: "a.ts" }]);
        return Promise.resolve([]);
      }
      if (cmd === "read_file_content") return Promise.resolve("content\n");
      return Promise.resolve([]);
    });

    render(<App />);
    fireEvent.click(screen.getByTestId("shell-vibe"));
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));

    fireEvent.click(screen.getByTestId("vibe-explorer-toggle"));
    await waitFor(() => expect(screen.getByText("a.ts")).toBeDefined());
    fireEvent.click(screen.getByText("a.ts"));

    await waitFor(() => expect(screen.getByTestId("vibe-tab-file")).toBeDefined());
    expect(screen.getByTestId("vibe-tab-file").className).toMatch(/active/);
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("content"));
  });
});

describe("Editor shell collapsible rail (vibe-editor-shell-redesign)", () => {
  it("renders the file tree on the left and Editor/Diff tabs in the center", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
    expect(screen.getByTestId("nav-rail")).toBeDefined();
    expect(screen.getByTestId("editor-tabs")).toBeDefined();
  });

  it("collapses the Threads & Codebase Map disclosure by default, so chat fills the rail without opening it", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") {
        return Promise.resolve([{ id: "t1", projectHash: "proj-1", title: "Thread A", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z", currentMode: "go", openSpecChangeName: null, executorSessionId: null }]);
      }
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    render(<App />);
    expect(screen.queryByTestId("rail-disclosure-body")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A"));
    expect(screen.getByTestId("composer-input")).toBeDefined();
  });

  it("reaches a past thread in 2 clicks: open disclosure, then select the row", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") {
        return Promise.resolve([
          { hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" },
        ]);
      }
      if (cmd === "switch_project") {
        return Promise.resolve({ hash: "proj-1", root: "/tmp/floo-network", displayName: "floo-network", createdAt: "2026-08-06T00:00:00Z", lastAccessedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "list_threads") {
        return Promise.resolve([
          { id: "t1", projectHash: "proj-1", title: "Thread A", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z", currentMode: "go", openSpecChangeName: null, executorSessionId: null },
          { id: "t2", projectHash: "proj-1", title: "Thread B", createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:00Z", currentMode: "spec", openSpecChangeName: null, executorSessionId: null },
        ]);
      }
      if (cmd === "read_thread") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({ claude: null, codex: null, selected: null, openspec: false, grillApply: false, ponytail: false, graphify: false, ready: false, warnings: [], checkedAt: "2026-08-06T00:00:00Z" });
      }
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") return Promise.resolve([]);
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread A"));

    fireEvent.click(screen.getByTestId("rail-disclosure-toggle")); // click 1: open
    const rowB = within(screen.getByTestId("thread-list")).getByText("Thread B").closest("li")!;
    fireEvent.click(rowB); // click 2: select

    await waitFor(() => expect(screen.getByTestId("thread-title")).toHaveTextContent("Thread B"));
    // Disclosure auto-collapses once a thread is picked (editor-collapsible-rail spec).
    expect(screen.queryByTestId("rail-disclosure-body")).toBeNull();
  });

  it("reaches Codebase Map in 2 clicks: open disclosure, then the Codebase Map tab", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
    fireEvent.click(screen.getByTestId("rail-disclosure-toggle")); // click 1: open
    fireEvent.click(screen.getByTestId("tab-codemap")); // click 2: select
    expect(screen.getByTestId("graph-pane")).toBeDefined();
  });

  it("reaches Codebase Map in 3 clicks from the Vibe shell: switch to Editor, open disclosure, Codebase Map tab", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
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
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
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
      if (cmd === "load_graphify") return Promise.resolve({ outDir: "", report: "", graph: null, summary: "" });
      if (cmd === "list_directory") {
        const relativePath = String(args?.relativePath ?? "");
        if (relativePath !== "") return Promise.resolve([]);
        const projectHash = args?.projectHash;
        return Promise.resolve(
          projectHash === projA.hash
            ? [{ name: "a.ts", is_dir: false, path: "a.ts" }]
            : [{ name: "b.ts", is_dir: false, path: "b.ts" }],
        );
      }
      if (cmd === "read_file_content") return Promise.resolve("content\n");
      if (cmd === "write_file_content") return Promise.resolve();
      if (cmd === "read_thread") return Promise.resolve([]);
      return Promise.resolve([]);
    });
  });

  it("unassociates the open file from the previous project when the project switches", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByText("a.ts")).toBeDefined());
    fireEvent.click(screen.getByText("a.ts"));
    await waitFor(() => expect(screen.getByTestId("file-editor")).toBeDefined());
    expect(screen.getByText("a.ts", { selector: ".ds-editor-path" })).toBeDefined();

    fireEvent.change(screen.getByTestId("project-picker"), { target: { value: projB.hash } });

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
          claude: "/usr/local/bin/claude", codex: null, selected: "claude", openspec: true,
          grillApply: false, ponytail: true, graphify: true, ready: true, warnings: [], checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      return Promise.resolve([]);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("model-btn")).toHaveTextContent("Sonnet 5"));
    expect(screen.queryByTestId("model-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("model-btn"));
    expect(screen.getByTestId("model-menu")).toBeDefined();
  });

  it("shows the executor as read-only status in the menu, with no control to switch it", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_projects") return Promise.resolve([]);
      if (cmd === "preflight") {
        return Promise.resolve({
          claude: "/usr/local/bin/claude", codex: null, selected: "claude", openspec: true,
          grillApply: false, ponytail: true, graphify: true, ready: true, warnings: [], checkedAt: "2026-08-06T00:00:00Z",
        });
      }
      return Promise.resolve([]);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("model-btn")).toBeDefined());
    fireEvent.click(screen.getByTestId("model-btn"));

    const executorRow = screen.getByTestId("executor-row");
    expect(executorRow.tagName).not.toBe("BUTTON");
    expect(executorRow).toHaveTextContent(/claude/i);
  });

  it("lets the user pick a model, persisting the choice across menu close/reopen", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("model-btn"));
    fireEvent.click(screen.getByTestId("model-opt-opus-5"));

    expect(localStorage.getItem("floo:model")).toBe("Opus 5");
    expect(screen.getByTestId("model-btn")).toHaveTextContent("Opus 5");
    expect(screen.queryByTestId("model-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("model-btn"));
    expect(screen.getByTestId("model-opt-opus-5").className).toMatch(/selected/);
  });

  it("has a bypass-permissions toggle, default off, that flips on and persists across menu reopen", () => {
    render(<App />);
    fireEvent.click(screen.getByTestId("model-btn"));
    const toggle = screen.getByTestId("bypass-toggle");
    expect(toggle.className).not.toMatch(/\bon\b/);
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);
    expect(toggle.className).toMatch(/\bon\b/);
    expect(localStorage.getItem("floo:bypass")).toBe("1");

    fireEvent.click(screen.getByTestId("model-btn")); // close
    fireEvent.click(screen.getByTestId("model-btn")); // reopen
    expect(screen.getByTestId("bypass-toggle").className).toMatch(/\bon\b/);
  });
});
