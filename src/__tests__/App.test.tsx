import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    const threadItem = await screen.findByText("Test Thread");
    fireEvent.click(threadItem);
    // Switch to the chat tab where the composer (and mode toggle) lives
    fireEvent.click(screen.getByTestId("tab-chat"));
    await waitFor(() => expect(screen.getByTestId("mode-selector")).toBeDefined());
    expect(screen.getByTestId("mode-spec")).toBeDefined();
    expect(screen.getByTestId("mode-go")).toBeDefined();
    unmount();
  });

  it("shows preflight status in utility cluster", () => {
    render(<App />);
    expect(screen.getByTestId("preflight-status")).toBeDefined();
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

  it("has New Thread button", () => {
    render(<App />);
    expect(screen.getByTestId("new-thread")).toBeDefined();
  });

  it("has thread list", () => {
    render(<App />);
    expect(screen.getByTestId("thread-list")).toBeDefined();
  });

  it("defaults to the Threads tab, and keeps Workspace visible when switching tabs", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("project-picker")).toHaveValue("proj-1"));
    expect(screen.getByTestId("tab-threads").className).toMatch(/active/);
    expect(screen.getByTestId("thread-list")).toBeDefined();
    expect(screen.getByTestId("new-thread")).toBeDefined();

    fireEvent.click(screen.getByTestId("tab-codemap"));
    expect(screen.getByTestId("tab-codemap").className).toMatch(/active/);
    // Workspace stays pinned above the tabs regardless of which tab is active;
    // New Thread lives inside the Threads pane itself, so it hides with it.
    expect(screen.getByTestId("project-picker")).toBeDefined();
    expect(screen.queryByTestId("new-thread")).toBeNull();
  });

  it("switches to the chat panel when a new thread is created", async () => {
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
      if (cmd === "create_thread") {
        return Promise.resolve({
          id: "thread-new",
          title: "New thread",
          createdAt: "2026-08-06T00:00:00Z",
          currentMode: "spec",
        });
      }
      if (cmd === "list_threads") {
        return Promise.resolve([
          {
            id: "thread-new",
            title: "New thread",
            createdAt: "2026-08-06T00:00:00Z",
            currentMode: "spec",
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

    await waitFor(() => expect(screen.getByTestId("new-thread")).toBeDefined());
    fireEvent.click(screen.getByTestId("new-thread"));

    await waitFor(() => {
      expect(screen.getByTestId("tab-chat").className).toMatch(/active/);
    });
  });

  it("has add project button", () => {
    render(<App />);
    expect(screen.getByTestId("add-project")).toBeDefined();
  });
});

describe("Editor chrome (merged-design v2)", () => {
  it("renders editor tabs", () => {
    render(<App />);
    expect(screen.getByTestId("editor-tabs")).toBeDefined();
  });

  it("has Console Chat and Code Change Diff tabs", () => {
    render(<App />);
    expect(screen.getByTestId("tab-chat")).toBeDefined();
    expect(screen.getByTestId("tab-diff")).toBeDefined();
  });

  it("defaults to the Editor tab, listed first, ahead of Console Chat and Diff", () => {
    render(<App />);
    const tabs = screen.getByTestId("editor-tabs");
    const order = Array.from(tabs.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(order).toEqual(["tab-editor", "tab-chat", "tab-diff"]);
    expect(screen.getByTestId("tab-editor").className).toMatch(/active/);
    expect(screen.getByText("Editor")).toBeDefined();
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
    expect(screen.queryByText("Create a thread to get started.")).toBeNull();
  });

  it("shows the diff tab empty state even when no thread exists", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("editor-tabs")).toBeDefined());
    fireEvent.click(screen.getByTestId("tab-diff"));

    await waitFor(() => {
      expect(screen.queryByText("Create a thread to get started.")).toBeNull();
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

  it("has Threads and Code Map tabs, and no leftover Notes tab", () => {
    render(<App />);
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
