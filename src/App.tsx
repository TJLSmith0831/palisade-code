import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";

import * as api from "./api";
import type { ExecutorEvent, Message, Preflight, Project, ThreadMeta } from "./api";
import { EventList, filterForTab, itemsFromMessages, mergeDeltas, type Item } from "./EventView";
import FileEditorPane from "./FileEditorPane";
import FileTree from "./FileTree";
import GraphPane from "./GraphPane";
import { useResizable, type UseResizableResult } from "./useResizable";
import "./App.css";

// Cursor/VS Code-style panel-toggle glyph: outline + a filled column on the side being toggled.
const SidebarIcon = ({ side }: { side: "left" | "right" }) => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
    <rect x={side === "left" ? 2.5 : 9.5} y="3.5" width="4" height="9" rx="1" fill="currentColor" />
    <line
      x1={side === "left" ? 6.5 : 9.5}
      y1="2.5"
      x2={side === "left" ? 6.5 : 9.5}
      y2="13.5"
      stroke="currentColor"
      strokeWidth="1.3"
    />
  </svg>
);

// Keeps a resize drag alive after the pointer leaves the handle element.
const bindDrag = (handle: UseResizableResult["handleProps"], cursor: "col-resize" | "row-resize") =>
  (down: ReactPointerEvent) => {
    down.preventDefault();
    handle.onPointerDown(down);
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = cursor;
    const onMove = (e: PointerEvent) => handle.onPointerMove(e);
    const onUp = () => {
      handle.onPointerUp();
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

const lastThreadKey = (hash: string) => `floo:lastThread:${hash}`;
const SHOW_THINKING_KEY = "floo:showThinking";
const THEME_KEY = "floo:theme";
// TEMP TEST CHANGE
type Theme = "auto" | "light" | "dark";
const nextTheme = (t: Theme): Theme => (t === "auto" ? "light" : t === "light" ? "dark" : "auto");
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
// The executor (Claude Code / Codex) has its own file-read tooling, so we
// hand it a path rather than threading image bytes through the IPC channel.
export const imagePathsFrom = (paths: string[]): string[] => paths.filter((p) => IMAGE_PATH.test(p));

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [thread, setThread] = useState<ThreadMeta | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [note, setNote] = useState<{ name: string; content: string } | null>(null);
  const [notePane, setNotePane] = useState<"edit" | "preview">("edit");
  // One reusable command bar: new note, rename project, rename thread, and
  // now confirming a delete. `window.prompt`/`confirm` are no-ops in
  // Tauri's WKWebView — they return null without ever showing a dialog —
  // so anything that needs a line of text, or a yes/no from the user, has
  // to go through this.
  const [bar, setBar] = useState<
    | { kind: "input"; label: string; value: string; submit: (value: string) => void }
    | { kind: "confirm"; label: string; onConfirm: () => void }
    | null
  >(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flight, setFlight] = useState<Preflight | null>(null);
  const [live, setLive] = useState<ExecutorEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [showThinking, setShowThinking] = useState(() => localStorage.getItem(SHOW_THINKING_KEY) === "1");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [chatTab, setChatTab] = useState<"chat" | "editor" | "diff">("editor");
  const [rightTab, setRightTab] = useState<"codemap" | "notes">("codemap");
  const layoutHash = project?.hash ?? "default";
  const leftRail = useResizable({
    storageKey: `floo:layout:${layoutHash}:left`,
    defaultSize: 193,
    min: 160,
    max: 420,
    axis: "horizontal",
  });
  const rightPanel = useResizable({
    storageKey: `floo:layout:${layoutHash}:right`,
    defaultSize: 300,
    min: 260,
    max: 820,
    axis: "horizontal",
    reverse: true,
    defaultCollapsed: true,
  });
  const terminalPanel = useResizable({
    storageKey: `floo:layout:${layoutHash}:terminal`,
    defaultSize: 220,
    min: 120,
    max: 560,
    axis: "vertical",
    reverse: true,
    defaultCollapsed: true,
  });
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(THEME_KEY) as Theme) || "auto");
  const [dragActive, setDragActive] = useState(false);
  const [fileEdits, setFileEdits] = useState<{ path: string; before: string; after: string }[]>([]);

  const handleFileSave = useCallback((edit: { path: string; before: string; after: string }) => {
    setFileEdits((prev) => [...prev, edit]);
  }, []);

  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const fail = (err: unknown) => setError(String(err));

  const selectThread = useCallback(async (projectHash: string, next: ThreadMeta | null) => {
    setThread(next);
    if (!next) {
      setMessages([]);
      return;
    }
    localStorage.setItem(lastThreadKey(projectHash), next.id);
    setLive([]);
    setMessages(await api.readThread(projectHash, next.id));
  }, []);

  const selectProject = useCallback(
    async (next: Project) => {
      try {
        const refreshed = await api.switchProject(next.hash);
        setProject(refreshed);
        setNote(null);
        const [found, noteNames] = await Promise.all([
          api.listThreads(refreshed.hash),
          api.listNotes(refreshed.hash),
        ]);
        setThreads(found);
        setNotes(noteNames);
        const remembered = localStorage.getItem(lastThreadKey(refreshed.hash));
        await selectThread(refreshed.hash, found.find((t) => t.id === remembered) ?? found[0] ?? null);
      } catch (err) {
        fail(err);
      }
    },
    [selectThread],
  );

  // Restore the most recently used project on launch.
  useEffect(() => {
    api.listProjects().then((found) => {
      setProjects(found);
      if (found.length > 0) selectProject(found[0]);
    }, fail);
  }, [selectProject]);

  // -------------------------------------------------------------- projects

  const onAddProject = async () => {
    try {
      const picked = await open({ directory: true, title: "Add a project" });
      if (typeof picked !== "string") return;
      const added = await api.addProject(picked);
      setProjects(await api.listProjects());
      await selectProject(added);
    } catch (err) {
      fail(err);
    }
  };

  const onRenameProject = () => {
    if (!project) return;
    setBar({
      kind: "input",
      label: "Project display name",
      value: project.displayName,
      submit: async (name) => {
        try {
          await api.renameProject(project.hash, name);
          const refreshed = await api.listProjects();
          setProjects(refreshed);
          setProject(refreshed.find((p) => p.hash === project.hash) ?? project);
        } catch (err) {
          fail(err);
        }
      },
    });
  };

  // --------------------------------------------------------------- threads

  const onNewThread = async () => {
    if (!project) return;
    try {
      const created = await api.createThread(project.hash, "New thread");
      setThreads(await api.listThreads(project.hash));
      setNote(null);
      await selectThread(project.hash, created);
    } catch (err) {
      fail(err);
    }
  };

  const onRenameThread = (target: ThreadMeta) => {
    if (!project) return;
    setBar({
      kind: "input",
      label: "Thread title",
      value: target.title,
      submit: async (title) => {
        try {
          const renamed = await api.renameThread(project.hash, target.id, title);
          if (thread?.id === target.id) setThread(renamed);
          setThreads(await api.listThreads(project.hash));
        } catch (err) {
          fail(err);
        }
      },
    });
  };

  const onDeleteThread = (target: ThreadMeta) => {
    if (!project) return;
    setBar({
      kind: "confirm",
      label: `Delete "${target.title}"? This can't be undone.`,
      onConfirm: async () => {
        setBar(null);
        try {
          await api.deleteThread(project.hash, target.id);
          const found = await api.listThreads(project.hash);
          setThreads(found);
          // Only reselect if the deleted thread was the one open (D22) —
          // mirrors selectProject's found[0] ?? null fallback.
          if (thread?.id === target.id) await selectThread(project.hash, found[0] ?? null);
        } catch (err) {
          fail(err);
        }
      },
    });
  };

  // Keeps the event listener (registered once) pointed at the current thread.
  const current = useRef({ project, thread });
  current.current = { project, thread };

  // OS-level drag-drop gives real absolute paths (unlike HTML5 File objects
  // in WKWebView, which often lack them). Dropped images get appended to the
  // draft as paths — the executor already has file-read tools of its own.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        setDragActive(false);
        if (!current.current.thread) return;
        const images = imagePathsFrom(event.payload.paths);
        if (!images.length) return;
        setDraft((prev) => (prev ? `${prev} ${images.join(" ")}` : images.join(" ")));
        return;
      }
      setDragActive(event.payload.type !== "leave");
    });
    return () => {
      unlisten.then((un) => un());
    };
  }, []);

  const refresh = useCallback(async () => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    const [found, history] = await Promise.all([
      api.listThreads(project.hash),
      api.readThread(project.hash, thread.id),
    ]);
    setThreads(found);
    setThread(found.find((t) => t.id === thread.id) ?? thread);
    setMessages(history);
    setLive([]);
  }, []);

  useEffect(() => {
    api.preflight().then(setFlight, fail);
  }, []);

  // Executor output streams in live; once the turn ends, the persisted log
  // becomes the source of truth again so both paths can't drift.
  useEffect(() => {
    const streaming = listen<ExecutorEvent>("executor-event", async ({ payload }) => {
      if (payload.kind === "done" || payload.kind === "crashed") {
        setBusy(false);
        await refresh().catch(fail);
        return;
      }
      setLive((previous) => [...previous, payload]);
    });
    const updated = listen<string>("thread-updated", () => {
      refresh().catch(fail);
    });
    // A graphify watch spawn failure or crash — the routine "not on PATH"
    // case is already covered by the persistent preflight warning banner.
    const warned = listen<string>("graphify-warning", ({ payload }) => fail(payload));
    return () => {
      streaming.then((un) => un());
      updated.then((un) => un());
      warned.then((un) => un());
    };
  }, [refresh]);

  const onGo = async () => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    try {
      setBusy(true);
      const meta = await api.goMode(project.hash, thread.id);
      await refresh();
      // A linked change means /grill-apply was just sent; otherwise we're idle.
      if (!meta.openSpecChangeName) setBusy(false);
    } catch (err) {
      setBusy(false);
      fail(err);
    }
  };

  const onSpec = async () => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    try {
      await api.specMode(project.hash, thread.id);
      setBusy(false);
      await refresh();
    } catch (err) {
      fail(err);
    }
  };

  const onPropose = async () => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    try {
      setBusy(true);
      await api.propose(project.hash, thread.id);
      await refresh();
    } catch (err) {
      setBusy(false);
      fail(err);
    }
  };

  const onSend = async () => {
    if (!project || !thread || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    // /go and /propose are the same functions the buttons call.
    if (text === "/go") return onGo();
    if (text === "/spec") return onSpec();
    if (text === "/propose") return onPropose();
    try {
      setBusy(true);
      await api.sendMessage(project.hash, thread.id, text, thread.currentMode);
      setMessages(await api.readThread(project.hash, thread.id));
      // Chat-only mode never answers, so never leave the composer locked.
      if (!flight?.selected) setBusy(false);
    } catch (err) {
      setBusy(false);
      fail(err);
    }
  };

  // ----------------------------------------------------------------- notes

  const openNote = useCallback(
    async (projectHash: string, name: string) => {
      try {
        setNote({ name, content: await api.readNote(projectHash, name) });
        setNotePane("edit");
      } catch (err) {
        fail(err);
      }
    },
    [],
  );

  const onCreateNote = async (rawName: string) => {
    if (!project || !rawName.trim()) return;
    try {
      const path = await api.createNote(project.hash, rawName.trim());
      setNotes(await api.listNotes(project.hash));
      setBar(null);
      rightPanel.setCollapsed(false);
      setRightTab("notes");
      await openNote(project.hash, path.split("/").pop()!);
    } catch (err) {
      fail(err);
    }
  };

  // Auto-save hand-edits — no confirmation, no re-prompt.
  const saveTimer = useRef<number | undefined>(undefined);
  const onEditNote = (content: string) => {
    if (!project || !note) return;
    setNote({ ...note, content });
    window.clearTimeout(saveTimer.current);
    const { hash } = project;
    const { name } = note;
    saveTimer.current = window.setTimeout(() => {
      api.writeNote(hash, name, content).catch(fail);
    }, 300);
  };

  // ⌘N opens the note command bar from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (project) setBar({ kind: "input", label: "New note", value: "", submit: onCreateNote });
      }
      if (event.key === "Escape") setBar(null);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        rightPanel.toggleCollapsed();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
        event.preventDefault();
        leftRail.toggleCollapsed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project, onCreateNote, rightPanel.toggleCollapsed, leftRail.toggleCollapsed]);

  // ------------------------------------------------------------------ view

  return (
    <div className="ds-window" data-testid="window-shell">
      <div className="ds-traffic-lights" data-testid="traffic-lights">
        <button
          className="ds-light red"
          onClick={() => getCurrentWindow().close()}
          aria-label="Close window"
          title="Close"
        />
        <button
          className="ds-light yellow"
          onClick={() => getCurrentWindow().minimize()}
          aria-label="Minimize window"
          title="Minimize"
        />
        <button
          className="ds-light green"
          onClick={() => getCurrentWindow().toggleMaximize()}
          aria-label="Maximize window"
          title="Maximize"
        />
      </div>
      <div className="app" data-color-mode="dark">
        <header className="ds-top-chrome" data-testid="top-chrome" data-tauri-drag-region="">
          <div className="ds-mode-selector" data-testid="mode-selector">
            <button
              className={`ds-mode-btn ${thread?.currentMode === "spec" ? "active" : ""}`}
              onClick={() => thread?.currentMode !== "spec" && onSpec()}
              disabled={busy || !flight?.selected}
              data-testid="mode-spec"
            >
              Spec <kbd>S</kbd>
            </button>
            <button
              className={`ds-mode-btn ${thread?.currentMode === "go" ? "active" : ""}`}
              onClick={() => thread?.currentMode !== "go" && onGo()}
              disabled={busy || !flight?.selected}
              data-testid="mode-go"
            >
              Go <kbd>G</kbd>
            </button>
          </div>
          <div className="ds-chrome-utils">
            <button
              className="ds-icon-btn"
              onClick={() => leftRail.toggleCollapsed()}
              title="Toggle left sidebar (Cmd+\)"
              data-testid="toggle-left-sidebar"
            >
              <SidebarIcon side="left" />
            </button>
            <button
              className="ds-icon-btn"
              onClick={() => setTheme(nextTheme(theme))}
              title={`Theme: ${theme} (click to cycle auto → light → dark)`}
              data-testid="theme-toggle"
            >
              {theme === "auto" ? "Auto" : theme === "light" ? "Light" : "Dark"}
            </button>
            <button
              className="ds-icon-btn"
              onClick={() => rightPanel.toggleCollapsed()}
              title="Toggle right sidebar (Cmd+J)"
              data-testid="toggle-right-sidebar"
            >
              <SidebarIcon side="right" />
            </button>
            <button
              className={`ds-icon-btn ${flight?.ready ? "ok" : flight?.selected ? "warn" : "bad"}`}
              onClick={() => api.preflight(true).then(setFlight, fail)}
              title={
                flight
                  ? [`executor: ${flight.selected ?? "none"}`, ...flight.warnings].join("\n")
                  : "checking…"
              }
              data-testid="preflight-status"
            >
              {flight?.selected === "claude" ? (
                <svg viewBox="0 0 256 257" width="12" height="12" aria-label="Claude">
                  <path
                    fill="#D97757"
                    d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"
                  />
                </svg>
              ) : (
                flight?.selected ?? "—"
              )}
            </button>
          </div>
        </header>
      {flight && flight.warnings.length > 0 && (
        <div className="warnings" data-testid="preflight-warnings">
          {flight.warnings.map((warning) => (
            <div key={warning}>⚠ {warning}</div>
          ))}
        </div>
      )}

      {error && (
        <div className="error" onClick={() => setError(null)} data-testid="error">
          {error} <span className="dismiss">dismiss</span>
        </div>
      )}

      <div className="body">
        <nav
          className="ds-nav-rail"
          data-testid="nav-rail"
          style={
            {
              "--rail-w": `${leftRail.size}px`,
              marginLeft: leftRail.collapsed ? -leftRail.size : 0,
            } as CSSProperties
          }
        >
          <div className="ds-rail-section">
            <div className="ds-rail-label">Workspace</div>
            <select
              data-testid="project-picker"
              value={project?.hash ?? ""}
              onChange={(event) => {
                const next = projects.find((p) => p.hash === event.target.value);
                if (next) selectProject(next);
              }}
            >
              {projects.length === 0 && <option value="">No project</option>}
              {projects.map((p) => (
                <option key={p.hash} value={p.hash}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <div className="ds-rail-actions">
              <button onClick={onAddProject} data-testid="add-project">Add</button>
              {project && (
                <button onClick={onRenameProject} data-testid="rename-project">Rename</button>
              )}
            </div>
          </div>
          <div className="ds-rail-section">
            <button className="ds-new-thread" onClick={onNewThread} disabled={!project} data-testid="new-thread">
              + New Thread
            </button>
          </div>
          <div className="ds-rail-section ds-rail-threads">
            <div className="ds-rail-label">Threads</div>
            <ul data-testid="thread-list">
              {threads.map((t) => (
                <li
                  key={t.id}
                  className={t.id === thread?.id ? "active" : ""}
                  onClick={() => {
                    setNote(null);
                    if (project) selectThread(project.hash, t);
                  }}
                >
                  <div className="ds-thread-row">
                    <span className="ds-thread-title">{t.title}</span>
                    <div className="ds-thread-actions">
                      <button
                        className="ds-thread-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRenameThread(t);
                        }}
                        title="Rename thread"
                        data-testid="rename-thread-item"
                      >
                        ✎
                      </button>
                      <button
                        className="ds-thread-action delete"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteThread(t);
                        }}
                        title="Delete thread"
                        data-testid="delete-thread"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                  <span className="ds-thread-meta">
                    <span className={`badge ${t.currentMode}`}>{t.currentMode}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="ds-rail-footer">
            <div className="ds-user-chip">T</div>
            <span className="ds-user-name">tjlsmith</span>
            <label className="ds-think-toggle" data-testid="show-thinking">
              <input
                type="checkbox"
                checked={showThinking}
                onChange={(event) => {
                  const next = event.target.checked;
                  setShowThinking(next);
                  localStorage.setItem(SHOW_THINKING_KEY, next ? "1" : "0");
                }}
              />
              think
            </label>
          </div>
        </nav>

        {!leftRail.collapsed && (
          <div
            className="ds-resize-handle ds-resize-handle-x"
            data-testid="resize-left-rail"
            onPointerDown={bindDrag(leftRail.handleProps, "col-resize")}
          />
        )}

        {project && (
          <FileTree
            projectHash={project.hash}
            projectName={project.displayName}
            onSelectFile={setSelectedFile}
            activePath={selectedFile}
          />
        )}

        <main className="main">
          <div className="ds-editor-tabs" data-testid="editor-tabs">
            <button
              className={`ds-tab ${chatTab === "editor" ? "active" : ""}`}
              onClick={() => setChatTab("editor")}
              data-testid="tab-editor"
            >
              Editor
            </button>
            <button
              className={`ds-tab ${chatTab === "chat" ? "active" : ""}`}
              onClick={() => setChatTab("chat")}
              data-testid="tab-chat"
            >
              Console Chat
            </button>
            <button
              className={`ds-tab diff ${chatTab === "diff" ? "active" : ""}`}
              onClick={() => setChatTab("diff")}
              data-testid="tab-diff"
            >
              Code Change Diff
            </button>
          </div>
          <div className="ds-breadcrumbs" data-testid="breadcrumbs">
            <span>{project?.displayName ?? "—"}</span>
            <span className="ds-crumb-sep">/</span>
            <span className="ds-crumb-active">{selectedFile ?? "console"}</span>
          </div>
          {note ? (
            <>
              <div className="pane-head">
                <strong data-testid="note-name">{note.name}</strong>
                <div className="tabs">
                  <button
                    className={notePane === "edit" ? "on" : ""}
                    onClick={() => setNotePane("edit")}
                    data-testid="note-edit-tab"
                  >
                    Edit
                  </button>
                  <button
                    className={notePane === "preview" ? "on" : ""}
                    onClick={() => setNotePane("preview")}
                    data-testid="note-preview-tab"
                  >
                    Preview
                  </button>
                </div>
                <div className="spacer" />
                <button onClick={() => setNote(null)}>Close</button>
              </div>
              <div className="editor" data-testid="note-editor">
                <MDEditor
                  value={note.content}
                  onChange={(value) => onEditNote(value ?? "")}
                  preview={notePane}
                  hideToolbar
                  height="100%"
                />
              </div>
            </>
          ) : chatTab === "editor" ? (
            project ? (
              <FileEditorPane projectHash={project.hash} path={selectedFile} onSave={handleFileSave} />
            ) : (
              <p className="empty">Add a project to get started.</p>
            )
          ) : chatTab === "diff" ? (
            <div className="messages" data-testid="messages">
              {(() => {
                const threadEdits = thread
                  ? filterForTab([...itemsFromMessages(messages), ...mergeDeltas(live)], "diff")
                  : [];
                const manualEdits: Item[] = fileEdits.map((e, i) => ({
                  kind: "fileEdit" as const,
                  id: `manual-${i}`,
                  path: e.path,
                  before: e.before,
                  after: e.after,
                }));
                const allEdits = [...threadEdits, ...manualEdits];
                return (
                  <>
                    {allEdits.length === 0 && (
                      <p className="empty">No file changes yet.</p>
                    )}
                    <EventList items={allEdits} showThinking={showThinking} executor={flight?.selected ?? null} />
                  </>
                );
              })()}
            </div>
          ) : thread ? (
            <>
              <div className="pane-head">
                <strong data-testid="thread-title">{thread.title}</strong>
                <button onClick={() => onRenameThread(thread)} data-testid="rename-thread">
                  Rename
                </button>
                {thread.openSpecChangeName && (
                  <span className="change-chip" data-testid="change-chip">
                    {thread.openSpecChangeName}
                  </span>
                )}
                <div className="spacer" />
                <button
                  onClick={onPropose}
                  disabled={busy || thread.currentMode !== "spec" || !flight?.selected}
                  data-testid="propose"
                >
                  /propose
                </button>
              </div>
              {thread.currentMode === "spec" && (
                <div className="spec-banner" data-testid="spec-banner">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="spec-icon">
                    <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                  Spec Mode — read-only planning
                </div>
              )}
              <div className="messages" data-testid="messages">
                {(() => {
                  const items = filterForTab(
                    [...itemsFromMessages(messages), ...mergeDeltas(live)],
                    chatTab,
                  );
                  return (
                    <>
                      {items.length === 0 && (
                        <p className="empty">
                          No messages yet.
                        </p>
                      )}
                      <EventList
                        items={items}
                        showThinking={showThinking}
                        executor={flight?.selected ?? null}
                      />
                    </>
                  );
                })()}
                {busy && (
                  <div className="working" data-testid="working">
                    executor working…
                  </div>
                )}
              </div>
              <form
                className={`composer ${dragActive ? "drag-active" : ""}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  onSend();
                }}
              >
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={
                    flight?.selected
                      ? "Message, or /go · /spec · /propose"
                      : "Chat-only — no executor on PATH"
                  }
                  data-testid="composer-input"
                />
                <button
                  type="submit"
                  className="send"
                  data-testid="composer-send"
                  disabled={busy}
                  aria-label="Send message"
                  title="Send message"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
                  </svg>
                </button>
              </form>
            </>
          ) : (
            <p className="empty">
              {project ? "Create a thread to get started." : "Add a project to get started."}
            </p>
          )}

          {!terminalPanel.collapsed && (
            <>
              <div
                className="ds-resize-handle ds-resize-handle-y"
                data-testid="resize-terminal-panel"
                onPointerDown={bindDrag(terminalPanel.handleProps, "row-resize")}
              />
              <div
                className="ds-terminal-panel"
                data-testid="terminal-panel"
                style={{ "--terminal-h": `${terminalPanel.size}px` } as CSSProperties}
              />
            </>
          )}
        </main>

        {!rightPanel.collapsed && (
          <div
            className="ds-resize-handle ds-resize-handle-x"
            data-testid="resize-right-panel"
            onPointerDown={bindDrag(rightPanel.handleProps, "col-resize")}
          />
        )}

        <aside
          className="ds-right-sidebar"
          data-testid="right-sidebar"
          style={
            {
              "--panel-w": `${rightPanel.size}px`,
              marginRight: rightPanel.collapsed ? -rightPanel.size : 0,
            } as CSSProperties
          }
        >
          <div className="ds-right-tabs">
            <button
              className={rightTab === "codemap" ? "active" : ""}
              onClick={() => setRightTab("codemap")}
              data-testid="tab-codemap"
            >
              Codebase Map
            </button>
            <button
              className={rightTab === "notes" ? "active" : ""}
              onClick={() => setRightTab("notes")}
              data-testid="tab-notes"
            >
              Notes
            </button>
          </div>
          <div className="ds-right-panes">
            {rightTab === "codemap" && project && (
              <GraphPane
                projectHash={project.hash}
                threadId={thread?.id ?? null}
                onInjected={() => refresh().catch(fail)}
              />
            )}
            {rightTab === "notes" && project && (
              <div className="ds-notes-panel">
                <button
                  className="ds-new-thread"
                  onClick={() => setBar({ kind: "input", label: "New note", value: "", submit: onCreateNote })}
                  disabled={!project}
                  data-testid="create-note"
                >
                  + Create note
                </button>
                <ul data-testid="note-list">
                  {notes.map((name) => (
                    <li
                      key={name}
                      className={name === note?.name ? "active" : ""}
                      onClick={() => project && openNote(project.hash, name)}
                    >
                      <span className="ds-thread-title">{name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </aside>
      </div>

      {bar && bar.kind === "input" && (
        <div className="overlay" onClick={() => setBar(null)}>
          <div className="commandbar" onClick={(event) => event.stopPropagation()}>
            <label htmlFor="barInput">{bar.label}</label>
            <input
              id="barInput"
              name="barInput"
              autoFocus
              autoComplete="off"
              defaultValue={bar.value}
              placeholder={bar.value ? undefined : "filename"}
              data-testid="note-name-input"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  const value = event.currentTarget.value.trim();
                  if (!value) return;
                  const { submit } = bar;
                  setBar(null);
                  submit(value);
                }
              }}
            />
            <span className="hint">Enter to confirm · Esc to cancel</span>
          </div>
        </div>
      )}

      {bar && bar.kind === "confirm" && (
        <div className="overlay" onClick={() => setBar(null)}>
          <div className="commandbar" onClick={(event) => event.stopPropagation()}>
            <label>{bar.label}</label>
            <div className="confirm-actions">
              <button onClick={bar.onConfirm} className="danger" data-testid="confirm-delete" autoFocus>
                Delete
              </button>
              <button onClick={() => setBar(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
