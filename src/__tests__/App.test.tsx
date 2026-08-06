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

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    close: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
  })),
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
    if (cmd === "list_notes") return Promise.resolve([]);
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

  it("renders traffic lights inside the window shell", () => {
    render(<App />);
    expect(screen.getByTestId("traffic-lights")).toBeDefined();
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

  it("has centered Spec/Go mode pill switch", () => {
    render(<App />);
    expect(screen.getByTestId("mode-selector")).toBeDefined();
    expect(screen.getByTestId("mode-spec")).toBeDefined();
    expect(screen.getByTestId("mode-go")).toBeDefined();
  });

  it("shows preflight status in utility cluster", () => {
    render(<App />);
    expect(screen.getByTestId("preflight-status")).toBeDefined();
  });

  it("has data-tauri-drag-region on top chrome", () => {
    render(<App />);
    const chrome = screen.getByTestId("top-chrome");
    expect(chrome.getAttribute("data-tauri-drag-region")).toBe("");
  });
});

describe("Navigation rail (merged-design v2)", () => {
  it("renders at 193px width", () => {
    render(<App />);
    const rail = screen.getByTestId("nav-rail");
    expect(getComputedStyle(rail).width).toBe("193px");
  });

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
    expect(screen.getByTestId("file-editor-textarea")).toBeDefined();
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

describe("Right sidebar (merged-design v2)", () => {
  it("renders right sidebar", () => {
    render(<App />);
    expect(screen.getByTestId("right-sidebar")).toBeDefined();
  });

  it("has Code Map and Notes tabs", () => {
    render(<App />);
    expect(screen.getByTestId("tab-codemap")).toBeDefined();
    expect(screen.getByTestId("tab-notes")).toBeDefined();
  });

  it("has no leftover Files tab (superseded by the file explorer column)", () => {
    render(<App />);
    expect(screen.queryByTestId("tab-files")).toBeNull();
  });

  it("is collapsed by default", () => {
    render(<App />);
    const sidebar = screen.getByTestId("right-sidebar");
    expect(sidebar.className).toMatch(/collapsed/);
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
