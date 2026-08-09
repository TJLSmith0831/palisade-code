import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Accordion,
  Menu,
  Modal as MantineModal,
  Switch,
  Tabs,
  Tooltip,
  useMantineColorScheme,
  Textarea,
  SegmentedControl,
  ActionIcon,
} from "@mantine/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

import * as api from "./api";
import type {
  ExecutorEvent,
  Message,
  Preflight,
  Project,
  ThreadMeta,
} from "./api";
import { onActivateKey } from "./a11y";
import { describeError } from "./errors";
import { fuzzyMatch } from "./fuzzyMatch";
import { RenameIcon, DeleteIcon } from "./icons";
import {
  EventList,
  filterForTab,
  itemsFromMessages,
  mergeDeltas,
  type Item,
} from "./EventView";
import FileEditorPane from "./FileEditorPane";
import FilePalette from "./FilePalette";
import TextSearchPalette from "./TextSearchPalette";
import FileTree from "./FileTree";
import DiffPane from "./DiffPane";
import GraphPane from "./GraphPane";
import SettingsPanel, { applyAccentHue, loadAccentHue } from "./SettingsPanel";
import TerminalPane from "./TerminalPane";
import { enableModernWindowStyle } from "./macRoundedCorners";
import { useResizable, type UseResizableResult } from "./useResizable";
import "./App.css";

// Cursor/VS Code-style panel-toggle glyph: outline + a filled column on the side being toggled.
const SidebarIcon = ({ side }: { side: "left" | "right" }) => (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    aria-hidden="true"
  >
    <rect
      x="1.5"
      y="2.5"
      width="13"
      height="11"
      rx="2"
      stroke="currentColor"
      strokeWidth="1.3"
    />
    <rect
      x={side === "left" ? 2.5 : 9.5}
      y="3.5"
      width="4"
      height="9"
      rx="1"
      fill="currentColor"
    />
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

// Standard gear/cog glyph (Heroicons Cog6Tooth outline), stroke-only to
// match the weight of the sidebar/terminal icons alongside it.
const SettingsIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
    />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
    />
  </svg>
);

// Same frame as SidebarIcon, with a prompt chevron + cursor bar instead of
// a filled column — reads as "terminal" while matching the sidebar toggles'
// weight and style.
const TerminalIcon = () => (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="none"
    aria-hidden="true"
  >
    <rect
      x="1.5"
      y="2.5"
      width="13"
      height="11"
      rx="2"
      stroke="currentColor"
      strokeWidth="1.3"
    />
    <path
      d="M4 6.2 6.8 8 4 9.8"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
    <line
      x1="8"
      y1="9.8"
      x2="11.2"
      y2="9.8"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
    />
  </svg>
);

// Same stroke weight as SettingsIcon (24x24 viewBox, 1.5 stroke) — the family
// used for small inline row actions (rename/delete/branch), as distinct from
// the 16x16/1.3 panel-toggle family above. RenameIcon/DeleteIcon live in
// ./icons since FilePalette needs the same two for its own row actions.
const BranchIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <line x1="6" y1="3" x2="6" y2="15" strokeLinecap="round" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path strokeLinecap="round" d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

// Shared chat surface: mounted as the Vibe shell's main column and as the
// Editor shell's right-rail chat area (see openspec/changes/
// vibe-editor-shell-redesign design.md Decision 2 — one component, two
// mount points, rather than shell-specific duplicates). Shows the inline
// Vibe/Spec new-thread picker in place of the thread view when active.
type ChatSurfaceProps = {
  project: Project | null;
  thread: ThreadMeta | null;
  messages: Message[];
  live: ExecutorEvent[];
  busy: boolean;
  showThinking: boolean;
  executor: Preflight["selected"] | null;
  flightSelected: boolean;
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void;
  onRenameThread: (target: ThreadMeta) => void;
  onSpec: () => void;
  onGo: () => void;
  dragActive: boolean;
  newThreadPicker: boolean;
  onPickMode: (mode: api.Mode) => void;
};

function ChatSurface({
  project,
  thread,
  messages,
  live,
  busy,
  showThinking,
  executor,
  flightSelected,
  draft,
  setDraft,
  onSend,
  onRenameThread,
  onSpec,
  onGo,
  dragActive,
  newThreadPicker,
  onPickMode,
}: ChatSurfaceProps) {
  if (newThreadPicker) {
    return (
      <>
        <div className="pane-head">
          <strong>New thread</strong>
        </div>
        <div className="ds-new-thread-picker" data-testid="mode-picker">
          <div className="ds-mode-picker">
            <button
              className="ds-mode-card"
              onClick={() => onPickMode("go")}
              data-testid="pick-vibe"
              autoFocus
            >
              <strong>Vibe</strong>
              <span>Chat first — start building right away.</span>
            </button>
            <button
              className="ds-mode-card"
              onClick={() => onPickMode("spec")}
              data-testid="pick-spec"
            >
              <strong>Spec</strong>
              <span>
                Plan first — read-only planning before code, via the grill flow.
              </span>
            </button>
          </div>
          <span className="hint">
            You can switch modes any time from the composer.
          </span>
        </div>
      </>
    );
  }

  // Entice the user to create a new thread only if threads are focused
  if (!thread) {
    return (
      <p className="empty">
        {project
          ? "Create a thread to get started."
          : "Add a project to get started."}
      </p>
    );
  }

  return (
    <>
      <div className="pane-head">
        <strong data-testid="thread-title">{thread.title}</strong>
        <button
          onClick={() => onRenameThread(thread)}
          data-testid="rename-thread"
        >
          Rename
        </button>
        {thread.openSpecChangeName && (
          <span className="change-chip" data-testid="change-chip">
            {thread.openSpecChangeName}
          </span>
        )}
        <div className="spacer" />
      </div>
      {thread.currentMode === "spec" && (
        <div className="spec-banner" data-testid="spec-banner">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="spec-icon"
          >
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
          Spec Mode — read-only planning
        </div>
      )}
      <div className="messages" data-testid="messages">
        {(() => {
          const items = filterForTab(
            [...itemsFromMessages(messages), ...mergeDeltas(live)],
            "chat"
          );
          return (
            <>
              {items.length === 0 && <p className="empty">No messages yet.</p>}
              <EventList
                items={items}
                showThinking={showThinking}
                executor={executor}
              />
            </>
          );
        })()}
        {busy && (
          <div className="working" data-testid="working">
            executor working
            <span className="working-dots">
              <span />
              <span />
              <span />
            </span>
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
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            flightSelected
              ? "Message, or /propose"
              : "Chat-only — no executor on PATH"
          }
          aria-label="Message"
          data-testid="composer-input"
          minRows={1}
          maxRows={6}
          style={{ resize: "vertical", width: "80%" }}
        />
        <SegmentedControl
          data-testid="mode-selector"
          value={thread.currentMode}
          onChange={(value) => {
            if (value === "spec") {
              onSpec();
            } else {
              onGo();
            }
          }}
          disabled={busy || !flightSelected}
          data={[
            { label: "Spec  S", value: "spec" },
            { label: "Go  G", value: "go" },
          ]}
          styles={{
            root: {
              background: "transparent",
              padding: 0,
              gap: 4,
            },
            indicator: {
              background: "var(--mantine-color-dark-8)",
              boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
              borderRadius: 8,
            },
            label: {
              fontSize: 12,
              fontWeight: 500,
            },
            control: {
              border: 0,
              borderRadius: 8,
              background: "transparent",
              padding: "4px 10px",
            },
          }}
        />
        <ActionIcon
          type="submit"
          data-testid="composer-send"
          disabled={busy}
          aria-label="Send message"
          title="Send message"
          size="lg"
          radius="md"
          variant="filled"
          styles={{
            root: {
              backgroundColor: "#66F978",
              color: "#0B1710",
            },
          }}
        >
          {/* Send icon */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#0B1710"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path stroke="none" d="M0 0h24v24H0z" fill="none" />
            <path d="M15 10l-4 4l6 6l4 -16l-18 7l4 2l2 6l3 -4" />
          </svg>
        </ActionIcon>
      </form>
    </>
  );
}

// Keeps a resize drag alive after the pointer leaves the handle element.
const bindDrag =
  (
    handle: UseResizableResult["handleProps"],
    cursor: "col-resize" | "row-resize"
  ) =>
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

// D15: .project-settings.json's known v1 shape. The backend auto-creates
// this on every project open (settings::ensure_file); this is only a
// fallback for the rare case a project's file was deleted after the fact
// and the user re-opens it via the settings button before switching
// projects again.
const DEFAULT_PROJECT_SETTINGS = `{
  "formatOnSave": {},
  "executorOverride": null
}
`;
const PROJECT_SETTINGS_FILE = ".project-settings.json";

const lastThreadKey = (hash: string) => `floo:lastThread:${hash}`;
const SHOW_THINKING_KEY = "floo:showThinking";
export const THEME_KEY = "floo:theme";
const TERMINAL_PLACEMENT_KEY = "floo:terminalPlacement";
const MODEL_KEY = "floo:model";
const BYPASS_KEY = "floo:bypass";
// A stored preference only — not yet threaded into the executor invocation
// (see openspec/changes/vibe-editor-shell-redesign design.md Non-Goals).
const MODELS = ["Sonnet 5", "Opus 5", "Haiku 4.5"];
type TerminalPlacement = "bottom" | "sidebar";
type Theme = "auto" | "light" | "dark";
const nextTheme = (t: Theme): Theme =>
  t === "auto" ? "light" : t === "light" ? "dark" : "auto";
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
// The executor (Claude Code / Codex) has its own file-read tooling, so we
// hand it a path rather than threading image bytes through the IPC channel.
export const imagePathsFrom = (paths: string[]): string[] =>
  paths.filter((p) => IMAGE_PATH.test(p));

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [thread, setThread] = useState<ThreadMeta | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [branches, setBranches] = useState<api.BranchInfo[]>([]);
  // One reusable command bar: rename project, rename thread, and confirming
  // a delete. `window.prompt`/`confirm` are no-ops in
  // Tauri's WKWebView — they return null without ever showing a dialog —
  // so anything that needs a line of text, or a yes/no from the user, has
  // to go through this.
  const [bar, setBar] = useState<
    | {
        kind: "input";
        label: string;
        value: string;
        submit: (value: string) => void;
      }
    | {
        kind: "confirm";
        label: string;
        confirmLabel?: string;
        onConfirm: () => void;
      }
    | {
        kind: "select";
        label: string;
        options: string[];
        submit: (choice: string) => void;
      }
    | null
  >(null);
  // Shows the inline Vibe/Spec picker in the chat surface in place of the
  // thread view — not part of `bar` since it isn't an overlay (spec:
  // new-thread-mode-picker requires it inline, not a modal dialog).
  const [newThreadPicker, setNewThreadPicker] = useState(false);
  // Editor shell: Threads & Codebase Map collapsible disclosure, collapsed
  // by default so chat owns the rail's height when idle (spec:
  // editor-collapsible-rail).
  const [editorRailOpen, setEditorRailOpen] = useState(false);
  // Vibe shell: File Explorer collapsible disclosure in the right rail,
  // collapsed by default (mirrors editorRailOpen's pattern).
  const [vibeExplorerOpen, setVibeExplorerOpen] = useState(false);
  // Vibe shell's Edited Files column: "changes" (diff/turn-history, default)
  // or "file" (the currently selectedFile, opened from the File Explorer).
  const [vibeFileTab, setVibeFileTab] = useState<"changes" | "file">("changes");
  // Live-filters the "select" bar's option list (branch picker) as the user
  // types, the same fuzzy-match convention FilePalette/TextSearchPalette use.
  const [selectQuery, setSelectQuery] = useState("");
  useEffect(() => {
    if (!bar) setSelectQuery("");
  }, [bar]);
  const [draft, setDraft] = useState("");
  // A list, not a single string: an action failing while an earlier failure
  // is still showing must not silently erase it — each stays visible until
  // its own dismiss, so a user who triggers two things in a row can tell
  // which one broke.
  const [errors, setErrors] = useState<{ id: string; message: string }[]>([]);
  const [flight, setFlight] = useState<Preflight | null>(null);
  const [live, setLive] = useState<ExecutorEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const showThinking = localStorage.getItem(SHOW_THINKING_KEY) === "1";
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [centerTab, setCenterTab] = useState<"editor" | "diff">("editor");
  // Which workspace shell is rendered — layout only, independent of a thread's
  // own Spec/Go mode (see openspec/changes/vibe-editor-shell-redesign).
  // Defaults to "editor" (today's layout) so existing users see no change
  // until they opt into "vibe" via the toggle.
  const [centerShell, setCenterShell] = useState<"vibe" | "editor">("editor");
  const [rightTab, setRightTab] = useState<"threads" | "codemap" | "terminal">(
    "threads"
  );
  const [terminalPlacement, setTerminalPlacement] = useState<TerminalPlacement>(
    () =>
      (localStorage.getItem(TERMINAL_PLACEMENT_KEY) as TerminalPlacement) ||
      "bottom"
  );
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
    defaultCollapsed: false,
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
  const toggleTerminalPlacement = useCallback(() => {
    setTerminalPlacement((prev) => {
      const next = prev === "bottom" ? "sidebar" : "bottom";
      localStorage.setItem(TERMINAL_PLACEMENT_KEY, next);
      if (next === "sidebar") {
        setRightTab("terminal");
        rightPanel.setCollapsed(false);
      } else {
        setRightTab((tab) => (tab === "terminal" ? "threads" : tab));
        terminalPanel.setCollapsed(false);
      }
      return next;
    });
  }, [rightPanel.setCollapsed, terminalPanel.setCollapsed]);
  // Placement-aware: toggles the bottom panel directly, or — when the
  // terminal lives in the sidebar — switches to its tab and opens the
  // sidebar, since terminalPanel.collapsed doesn't control visibility there.
  const toggleTerminal = useCallback(() => {
    if (terminalPlacement === "sidebar") {
      setRightTab("terminal");
      rightPanel.setCollapsed(false);
    } else {
      terminalPanel.toggleCollapsed();
    }
  }, [
    terminalPlacement,
    rightPanel.setCollapsed,
    terminalPanel.toggleCollapsed,
  ]);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(THEME_KEY) as Theme) || "auto"
  );
  const { setColorScheme: setMantineColorScheme } = useMantineColorScheme();
  const [selectedModel, setSelectedModel] = useState<string>(
    () => localStorage.getItem(MODEL_KEY) || MODELS[0]
  );
  const [bypassEnabled, setBypassEnabled] = useState<boolean>(
    () => localStorage.getItem(BYPASS_KEY) === "1"
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const onSelectModel = (model: string) => {
    setSelectedModel(model);
    localStorage.setItem(MODEL_KEY, model);
    setModelMenuOpen(false);
  };
  const onToggleBypass = () => {
    setBypassEnabled((prev) => {
      const next = !prev;
      localStorage.setItem(BYPASS_KEY, next ? "1" : "0");
      return next;
    });
  };
  const [dragActive, setDragActive] = useState(false);
  const [fileEdits, setFileEdits] = useState<
    { path: string; before: string; after: string }[]
  >([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [textSearchOpen, setTextSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteFiles, setPaletteFiles] = useState<string[]>([]);
  const filesCache = useRef<Map<string, string[]>>(new Map());
  const [fileTreeRefreshToken, setFileTreeRefreshToken] = useState(0);

  const handleFileSave = useCallback(
    (edit: { path: string; before: string; after: string }) => {
      setFileEdits((prev) => [...prev, edit]);
    },
    []
  );

  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  // Restore a previously-chosen accent color on launch.
  useEffect(() => {
    applyAccentHue(loadAccentHue());
  }, []);

  // macOS rounded corners + native traffic light repositioning (macOS only
  // — a no-op on other platforms). Must run once after the window is ready.
  useEffect(() => {
    enableModernWindowStyle({ offsetY: -3 });
  }, []);

  const fail = (err: unknown) =>
    setErrors((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, message: describeError(err) },
    ]);
  const dismissError = (id: string) =>
    setErrors((prev) => prev.filter((e) => e.id !== id));

  const selectThread = useCallback(
    async (projectHash: string, next: ThreadMeta | null) => {
      setThread(next);
      setNewThreadPicker(false);
      if (!next) {
        setMessages([]);
        return;
      }
      localStorage.setItem(lastThreadKey(projectHash), next.id);
      setLive([]);
      setMessages(await api.readThread(projectHash, next.id));
    },
    []
  );

  // Not every project is a git repo — that's a normal state, not an error,
  // so a failed lookup here just means "no branches to show" rather than
  // flashing the global error banner on every project switch.
  const refreshBranches = useCallback(async (projectHash: string) => {
    try {
      setBranches(await api.gitBranches(projectHash));
    } catch {
      setBranches([]);
    }
  }, []);

  const selectProject = useCallback(
    async (next: Project) => {
      try {
        const refreshed = await api.switchProject(next.hash);
        setProject(refreshed);
        setSelectedFile(null);
        setFileEdits([]);
        const found = await api.listThreads(refreshed.hash);
        setThreads(found);
        await refreshBranches(refreshed.hash);
        const remembered = localStorage.getItem(lastThreadKey(refreshed.hash));
        await selectThread(
          refreshed.hash,
          found.find((t) => t.id === remembered) ?? found[0] ?? null
        );
      } catch (err) {
        fail(err);
      }
    },
    [selectThread, refreshBranches]
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

  // Guards navigating away from a dirty editor: file-tree/palette/find-in-files
  // selection and opening project-settings.json all route through this instead
  // of calling setSelectedFile directly, so an in-progress edit can't be
  // silently discarded the way it could before.
  const selectFile = useCallback(
    (path: string) => {
      if (editorDirty && selectedFile && selectedFile !== path) {
        setBar({
          kind: "confirm",
          label: `Discard unsaved changes to "${selectedFile}"?`,
          confirmLabel: "Discard",
          onConfirm: () => {
            setBar(null);
            setSelectedFile(path);
          },
        });
        return;
      }
      setSelectedFile(path);
    },
    [editorDirty, selectedFile]
  );

  // Opens project-settings.json (D14/D15) in the editor, creating it with a
  // self-documenting default first if the project doesn't have one yet.
  const onOpenSettings = async () => {
    if (!project) return;
    try {
      await api.readFileContent(project.hash, PROJECT_SETTINGS_FILE);
    } catch {
      try {
        await api.writeFileContent(
          project.hash,
          PROJECT_SETTINGS_FILE,
          DEFAULT_PROJECT_SETTINGS
        );
      } catch (err) {
        fail(err);
        return;
      }
    }
    setCenterTab("editor");
    selectFile(PROJECT_SETTINGS_FILE);
  };

  // ---------------------------------------------------------------- branch

  const onOpenBranchPicker = () => {
    if (!project) return;
    const local = new Set(
      branches.filter((b) => !b.isRemote).map((b) => b.name)
    );
    // Remote branches with no local counterpart yet — offered so switching
    // to one creates a local tracking branch (git's own DWIM checkout
    // behavior), same as VS Code's remote-branch entries.
    const remoteOnly = branches
      .filter((b) => b.isRemote)
      .map((b) => b.name.split("/").slice(1).join("/"))
      .filter((name) => name && !local.has(name));
    const options = [
      ...branches.filter((b) => !b.isRemote).map((b) => b.name),
      ...new Set(remoteOnly),
    ];
    setBar({
      kind: "select",
      label: "Switch branch (or type a new name to create one)",
      options,
      submit: async (choice) => {
        setBar(null);
        try {
          if (options.includes(choice)) {
            await api.gitCheckoutBranch(project.hash, choice);
          } else {
            await api.gitCreateBranch(project.hash, choice);
          }
          await refreshBranches(project.hash);
        } catch (err) {
          fail(err);
        }
      },
    });
  };

  // --------------------------------------------------------------- threads

  const onNewThread = () => {
    if (!project) return;
    setNewThreadPicker(true);
    // Collapse the Editor shell's disclosure so the picker (mounted in the
    // always-visible chat area below it) is immediately visible.
    setEditorRailOpen(false);
  };

  // Vibe/Spec is a friendlier front door onto the two modes that already
  // exist — Vibe seeds go (chat first, build immediately), Spec seeds spec
  // (today's read-only grill/plan flow). No third mode.
  const onPickMode = async (mode: api.Mode) => {
    if (!project) return;
    setNewThreadPicker(false);
    try {
      const created = await api.createThread(project.hash, "New thread");
      const updated = await api.setThreadMode(project.hash, created.id, mode);
      setThreads(await api.listThreads(project.hash));
      await selectThread(project.hash, updated);
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
          const renamed = await api.renameThread(
            project.hash,
            target.id,
            title
          );
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
          if (thread?.id === target.id)
            await selectThread(project.hash, found[0] ?? null);
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
        setDraft((prev) =>
          prev ? `${prev} ${images.join(" ")}` : images.join(" ")
        );
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
    const streaming = listen<ExecutorEvent>(
      "executor-event",
      async ({ payload }) => {
        if (payload.kind === "done" || payload.kind === "crashed") {
          setBusy(false);
          await refresh().catch(fail);
          return;
        }
        setLive((previous) => [...previous, payload]);
      }
    );
    const updated = listen<string>("thread-updated", () => {
      refresh().catch(fail);
    });
    // A graphify watch spawn failure or crash — the routine "not on PATH"
    // case is already covered by the persistent preflight warning banner.
    const warned = listen<string>("harness-warning", ({ payload }) =>
      fail(payload)
    );
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

  // Cached per project hash so reopening a palette doesn't re-walk the tree.
  // Shared by the file palette (⌘P) and find-in-files (⌘⇧F) — both need the
  // same flat file list, just for different search modes.
  const ensurePaletteFiles = useCallback(async () => {
    if (!project) return;
    const cached = filesCache.current.get(project.hash);
    if (cached) {
      setPaletteFiles(cached);
      return;
    }
    try {
      const files = await api.listAllFiles(project.hash);
      filesCache.current.set(project.hash, files);
      setPaletteFiles(files);
    } catch (err) {
      fail(err);
    }
  }, [project]);

  const openFilePalette = useCallback(async () => {
    if (!project) return;
    setPaletteOpen(true);
    await ensurePaletteFiles();
  }, [project, ensurePaletteFiles]);

  const openTextSearch = useCallback(async () => {
    if (!project) return;
    setTextSearchOpen(true);
    await ensurePaletteFiles();
  }, [project, ensurePaletteFiles]);

  const searchProjectText = useCallback(
    (query: string) => {
      if (!project) return Promise.resolve([]);
      return api.searchText(project.hash, query);
    },
    [project]
  );

  // Bypasses the cache — used after a palette create/rename/delete so the
  // palette's own list (and the file tree, via the token bump) catch up.
  const refreshPaletteFiles = useCallback(async () => {
    if (!project) return;
    const files = await api.listAllFiles(project.hash);
    filesCache.current.set(project.hash, files);
    setPaletteFiles(files);
  }, [project]);

  const onCreateFile = useCallback(
    async (path: string) => {
      if (!project) return;
      await api.writeFileContent(project.hash, path, "");
      await refreshPaletteFiles();
      setFileTreeRefreshToken((t) => t + 1);
    },
    [project, refreshPaletteFiles]
  );

  const onRenameFile = useCallback(
    async (from: string, to: string) => {
      if (!project) return;
      await api.renamePath(project.hash, from, to);
      await refreshPaletteFiles();
      setFileTreeRefreshToken((t) => t + 1);
      setSelectedFile((current) => (current === from ? to : current));
    },
    [project, refreshPaletteFiles]
  );

  const onDeleteFile = useCallback(
    async (path: string) => {
      if (!project) return;
      await api.deletePath(project.hash, path);
      await refreshPaletteFiles();
      setFileTreeRefreshToken((t) => t + 1);
      setSelectedFile((current) => (current === path ? null : current));
    },
    [project, refreshPaletteFiles]
  );

  // The file tree performs its own create/rename/delete/move (surgical
  // per-directory refresh, no full-tree collapse) — these just keep the
  // open editor tab and the file-palette cache in sync afterward.
  const onTreePathRenamed = useCallback((from: string, to: string) => {
    setSelectedFile((current) => {
      if (current === from) return to;
      if (current?.startsWith(`${from}/`))
        return to + current.slice(from.length);
      return current;
    });
  }, []);

  const onTreePathDeleted = useCallback((path: string) => {
    setSelectedFile((current) =>
      current === path || current?.startsWith(`${path}/`) ? null : current
    );
  }, []);

  const onTreeFilesChanged = useCallback(() => {
    if (project) filesCache.current.delete(project.hash);
  }, [project]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
        event.preventDefault();
        openFilePalette();
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        openTextSearch();
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
      if ((event.metaKey || event.ctrlKey) && event.key === "`") {
        event.preventDefault();
        toggleTerminal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    openFilePalette,
    openTextSearch,
    rightPanel.toggleCollapsed,
    leftRail.toggleCollapsed,
    toggleTerminal,
  ]);

  // ------------------------------------------------------------------ view

  // Manual titlebar drag/double-click-to-maximize (data-tauri-drag-region
  // alone only drags — it doesn't distinguish a double-click for maximize,
  // per https://v2.tauri.app/learn/window-customization).
  const onTitlebarMouseDown = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if (
      (event.target as HTMLElement).closest("[data-tauri-drag-region-exclude]")
    )
      return;
    if (event.detail === 2) {
      getCurrentWindow().toggleMaximize();
    } else {
      getCurrentWindow().startDragging();
    }
  };

  return (
    <div className="ds-window" data-testid="window-shell">
      <div className="app" data-color-mode="dark">
        <header
          className="ds-top-chrome"
          data-testid="top-chrome"
          onMouseDown={onTitlebarMouseDown}
        >
          <h1 className="sr-only">Floo Network</h1>
          <div
            className="ds-shell-toggle"
            data-testid="shell-toggle"
            data-tauri-drag-region-exclude
          >
            <button
              className={centerShell === "vibe" ? "active" : ""}
              onClick={() => setCenterShell("vibe")}
              data-testid="shell-vibe"
            >
              Vibe
            </button>
            <button
              className={centerShell === "editor" ? "active" : ""}
              onClick={() => setCenterShell("editor")}
              data-testid="shell-editor"
            >
              Editor
            </button>
          </div>
          <div className="ds-chrome-utils">
            <Tooltip label="Toggle left sidebar (Cmd+\)">
              <button
                className="ds-icon-btn"
                onClick={() => leftRail.toggleCollapsed()}
                aria-label="Toggle left sidebar"
                data-testid="toggle-left-sidebar"
                data-tauri-drag-region-exclude
              >
                <SidebarIcon side="left" />
              </button>
            </Tooltip>
            <Tooltip label="Theme: click to cycle auto → light → dark">
              <button
                className="ds-icon-btn"
                onClick={() => {
                  const next = nextTheme(theme);
                  setTheme(next);
                  setMantineColorScheme(next);
                }}
                data-testid="theme-toggle"
                data-tauri-drag-region-exclude
              >
                {theme === "auto"
                  ? "Auto"
                  : theme === "light"
                    ? "Light"
                    : "Dark"}
              </button>
            </Tooltip>
            <Tooltip label="Toggle right sidebar (Cmd+J)">
              <button
                className="ds-icon-btn"
                onClick={() => rightPanel.toggleCollapsed()}
                aria-label="Toggle right sidebar"
                data-testid="toggle-right-sidebar"
                data-tauri-drag-region-exclude
              >
                <SidebarIcon side="right" />
              </button>
            </Tooltip>
            <Tooltip label="Toggle terminal (Cmd+`)">
              <button
                className="ds-icon-btn"
                onClick={toggleTerminal}
                aria-label="Toggle terminal"
                data-testid="toggle-terminal"
                data-tauri-drag-region-exclude
              >
                <TerminalIcon />
              </button>
            </Tooltip>
            <Tooltip label="Settings">
              <button
                className="ds-icon-btn"
                onClick={() => setSettingsOpen(true)}
                aria-label="Settings"
                data-testid="open-settings"
                data-tauri-drag-region-exclude
              >
                <SettingsIcon />
              </button>
            </Tooltip>
            <Menu opened={modelMenuOpen} onChange={setModelMenuOpen}>
              <Menu.Target>
                <Tooltip
                  label={`Model: ${selectedModel}${bypassEnabled ? " · bypass on" : ""}`}
                >
                  <button
                    className="ds-icon-btn"
                    data-testid="model-btn"
                    data-tauri-drag-region-exclude
                  >
                    {selectedModel}
                  </button>
                </Tooltip>
              </Menu.Target>
              <Menu.Dropdown className="ds-model-menu" data-testid="model-menu">
                <Menu.Label>Executor</Menu.Label>
                <div
                  className="ds-model-executor-row"
                  data-testid="executor-row"
                >
                  {flight?.selected ?? "none detected"}
                </div>
                <Menu.Label>Model</Menu.Label>
                {MODELS.map((m) => (
                  <Menu.Item
                    key={m}
                    className={`ds-model-opt ${selectedModel === m ? "selected" : ""}`}
                    onClick={() => onSelectModel(m)}
                    data-testid={`model-opt-${m.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    {m}
                  </Menu.Item>
                ))}
                <span className="hint">
                  Stored preference — not yet wired to the executor.
                </span>
                <Switch
                  className="ds-bypass-row"
                  label="Bypass permissions"
                  description="Skip approval prompts"
                  labelPosition="left"
                  color="var(--warn)"
                  checked={bypassEnabled}
                  onChange={onToggleBypass}
                  data-testid="bypass-toggle"
                />
              </Menu.Dropdown>
            </Menu>
            <Tooltip
              label={
                flight
                  ? [
                      `executor: ${flight.selected ?? "none"}`,
                      ...flight.warnings,
                    ].join("\n")
                  : "checking…"
              }
              multiline
              styles={{ tooltip: { whiteSpace: "pre-line" } }}
            >
              <button
                className={`ds-icon-btn ${flight?.ready ? "ok" : flight?.selected ? "warn" : "bad"}`}
                onClick={() => api.preflight(true).then(setFlight, fail)}
                data-tauri-drag-region-exclude
                data-testid="preflight-status"
              >
                {flight?.selected === "claude" ? (
                  <span className="ds-preflight-label">
                    <svg
                      viewBox="0 0 256 257"
                      width="12"
                      height="12"
                      aria-hidden="true"
                    >
                      <path
                        fill="#D97757"
                        d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"
                      />
                    </svg>
                    claude
                  </span>
                ) : (
                  (flight?.selected ?? "—")
                )}
              </button>
            </Tooltip>
          </div>
        </header>
        {flight && flight.warnings.length > 0 && (
          <div className="warnings" data-testid="preflight-warnings">
            {flight.warnings.map((warning) => (
              <div key={warning}>⚠ {warning}</div>
            ))}
          </div>
        )}

        {errors.map((e) => (
          <div
            key={e.id}
            className="error"
            onClick={() => dismissError(e.id)}
            data-testid="error"
          >
            {e.message} <span className="dismiss">dismiss</span>
          </div>
        ))}

        <div className="body">
          {centerShell === "editor" ? (
            <div className="ds-shell-contents" data-testid="editor-shell">
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
                {project && (
                  <FileTree
                    projectHash={project.hash}
                    projectName={project.displayName}
                    onSelectFile={selectFile}
                    activePath={selectedFile}
                    refreshToken={fileTreeRefreshToken}
                    onPathRenamed={onTreePathRenamed}
                    onPathDeleted={onTreePathDeleted}
                    onFilesChanged={onTreeFilesChanged}
                  />
                )}
              </nav>

              {!leftRail.collapsed && (
                <div
                  className="ds-resize-handle ds-resize-handle-x"
                  data-testid="resize-left-rail"
                  onPointerDown={bindDrag(leftRail.handleProps, "col-resize")}
                />
              )}

              <main className="main" data-testid="main-pane">
                <Tabs
                  value={centerTab}
                  onChange={(value) =>
                    value && setCenterTab(value as "editor" | "diff")
                  }
                >
                  <Tabs.List
                    className="ds-editor-tabs"
                    data-testid="editor-tabs"
                  >
                    <Tabs.Tab
                      value="editor"
                      className="ds-tab"
                      data-testid="tab-editor"
                    >
                      Editor
                    </Tabs.Tab>
                    <Tabs.Tab
                      value="diff"
                      className="ds-tab diff"
                      data-testid="tab-diff"
                    >
                      Code Change Diff
                    </Tabs.Tab>
                  </Tabs.List>
                </Tabs>
                <div className="ds-breadcrumbs" data-testid="breadcrumbs">
                  <span>{project?.displayName ?? "—"}</span>
                  {selectedFile && (
                    <>
                      <span className="ds-crumb-sep">/</span>
                      <span className="ds-crumb-active">{selectedFile}</span>
                    </>
                  )}
                </div>
                {centerTab === "editor" ? (
                  project ? (
                    <FileEditorPane
                      projectHash={project.hash}
                      path={selectedFile}
                      onSave={handleFileSave}
                      onDirtyChange={setEditorDirty}
                    />
                  ) : (
                    <div
                      className="ds-onboarding-empty"
                      data-testid="onboarding-empty"
                    >
                      <h2>Floo Network</h2>
                      <p>
                        Drive Claude Code or Codex against a real project — file
                        tree, editor, git diff, and a live codebase map, with
                        the agent working alongside you in the same files.
                      </p>
                      <button onClick={onAddProject}>
                        + Add a project to get started
                      </button>
                    </div>
                  )
                ) : (
                  <div className="messages" data-testid="messages">
                    {project && <DiffPane projectHash={project.hash} />}
                    {(() => {
                      const threadEdits = thread
                        ? filterForTab(
                            [
                              ...itemsFromMessages(messages),
                              ...mergeDeltas(live),
                            ],
                            "diff"
                          )
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
                        <section
                          className="diff-section"
                          data-testid="turn-history-section"
                        >
                          <h2 className="ds-section-heading">Turn History</h2>
                          {allEdits.length === 0 && (
                            <p className="empty">No file changes yet.</p>
                          )}
                          <EventList
                            items={allEdits}
                            showThinking={showThinking}
                            executor={flight?.selected ?? null}
                          />
                        </section>
                      );
                    })()}
                  </div>
                )}

                {terminalPlacement === "bottom" && !terminalPanel.collapsed && (
                  <>
                    <div
                      className="ds-resize-handle ds-resize-handle-y"
                      data-testid="resize-terminal-panel"
                      onPointerDown={bindDrag(
                        terminalPanel.handleProps,
                        "row-resize"
                      )}
                    />
                    <div
                      className="ds-terminal-panel"
                      data-testid="terminal-panel"
                      style={
                        {
                          "--terminal-h": `${terminalPanel.size}px`,
                        } as CSSProperties
                      }
                    >
                      {project && (
                        <TerminalPane
                          projectHash={project.hash}
                          placement={terminalPlacement}
                          onTogglePlacement={toggleTerminalPlacement}
                        />
                      )}
                    </div>
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
                <div className="ds-workspace-panel">
                  <div className="ds-rail-section">
                    <div className="ds-rail-label">Workspace</div>
                    <select
                      data-testid="project-picker"
                      value={project?.hash ?? ""}
                      onChange={(event) => {
                        const next = projects.find(
                          (p) => p.hash === event.target.value
                        );
                        if (next) selectProject(next);
                      }}
                    >
                      {projects.length === 0 && (
                        <option value="">No project</option>
                      )}
                      {projects.map((p) => (
                        <option key={p.hash} value={p.hash}>
                          {p.displayName}
                        </option>
                      ))}
                    </select>
                    <div className="ds-rail-actions">
                      <button onClick={onAddProject} data-testid="add-project">
                        Add
                      </button>
                      {project && (
                        <button
                          onClick={onRenameProject}
                          data-testid="rename-project"
                        >
                          Rename
                        </button>
                      )}
                    </div>
                    {project && branches.length > 0 && (
                      <button
                        className="ds-branch-btn"
                        onClick={onOpenBranchPicker}
                        data-testid="branch-indicator"
                      >
                        <BranchIcon />{" "}
                        {branches.find((b) => b.isCurrent)?.name ?? "…"}
                      </button>
                    )}
                  </div>
                </div>
                <div className="ds-right-panes">
                  {rightTab === "terminal" &&
                  terminalPlacement === "sidebar" ? (
                    project && (
                      <TerminalPane
                        projectHash={project.hash}
                        placement={terminalPlacement}
                        onTogglePlacement={toggleTerminalPlacement}
                      />
                    )
                  ) : (
                    <Accordion
                      value={editorRailOpen ? "threads-map" : null}
                      onChange={(value) => setEditorRailOpen(value !== null)}
                      keepMounted={false}
                      transitionDuration={0}
                      chevronPosition="left"
                    >
                      <Accordion.Item value="threads-map">
                        <Accordion.Control
                          className="ds-rail-disclosure"
                          data-testid="rail-disclosure-toggle"
                        >
                          Threads &amp; Codebase Map
                        </Accordion.Control>
                        <Accordion.Panel
                          className="ds-rail-disclosure-body"
                          data-testid="rail-disclosure-body"
                        >
                          <Tabs
                            value={rightTab}
                            onChange={(value) =>
                              value &&
                              setRightTab(value as "threads" | "codemap")
                            }
                          >
                            <Tabs.List className="ds-right-tabs">
                              <Tabs.Tab
                                value="threads"
                                data-testid="tab-threads"
                              >
                                Threads
                              </Tabs.Tab>
                              <Tabs.Tab
                                value="codemap"
                                data-testid="tab-codemap"
                              >
                                Codebase Map
                              </Tabs.Tab>
                            </Tabs.List>
                          </Tabs>
                          {rightTab === "threads" && (
                            <div className="ds-threads-panel">
                              <button
                                className="ds-new-thread"
                                onClick={onNewThread}
                                disabled={!project}
                                data-testid="new-thread"
                              >
                                + New Thread
                              </button>
                              <ul data-testid="thread-list">
                                {threads.map((t) => (
                                  <li
                                    key={t.id}
                                    className={
                                      t.id === thread?.id ? "active" : ""
                                    }
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => {
                                      if (project)
                                        selectThread(project.hash, t);
                                      setEditorRailOpen(false);
                                    }}
                                    onKeyDown={onActivateKey(() => {
                                      if (project)
                                        selectThread(project.hash, t);
                                      setEditorRailOpen(false);
                                    })}
                                  >
                                    <div className="ds-thread-row">
                                      <span className="ds-thread-title">
                                        {t.title}
                                      </span>
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
                                          <RenameIcon />
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
                                          <DeleteIcon />
                                        </button>
                                      </div>
                                    </div>
                                    <span className="ds-thread-meta">
                                      <span
                                        className={`badge ${t.currentMode}`}
                                      >
                                        {t.currentMode}
                                      </span>
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {rightTab === "codemap" && project && (
                            <GraphPane projectHash={project.hash} />
                          )}
                        </Accordion.Panel>
                      </Accordion.Item>
                    </Accordion>
                  )}

                  {!(
                    rightTab === "terminal" && terminalPlacement === "sidebar"
                  ) && (
                    <ChatSurface
                      project={project}
                      thread={thread}
                      messages={messages}
                      live={live}
                      busy={busy}
                      showThinking={showThinking}
                      executor={flight?.selected ?? null}
                      flightSelected={!!flight?.selected}
                      draft={draft}
                      setDraft={setDraft}
                      onSend={onSend}
                      onRenameThread={onRenameThread}
                      onSpec={onSpec}
                      onGo={onGo}
                      dragActive={dragActive}
                      newThreadPicker={newThreadPicker}
                      onPickMode={onPickMode}
                    />
                  )}
                </div>
              </aside>
            </div>
          ) : (
            <div className="ds-shell-contents" data-testid="vibe-shell">
              <section className="ds-vibe-chat" data-testid="vibe-chat-column">
                <ChatSurface
                  project={project}
                  thread={thread}
                  messages={messages}
                  live={live}
                  busy={busy}
                  showThinking={showThinking}
                  executor={flight?.selected ?? null}
                  flightSelected={!!flight?.selected}
                  draft={draft}
                  setDraft={setDraft}
                  onSend={onSend}
                  onRenameThread={onRenameThread}
                  onSpec={onSpec}
                  onGo={onGo}
                  dragActive={dragActive}
                  newThreadPicker={newThreadPicker}
                  onPickMode={onPickMode}
                />
              </section>

              <section className="ds-vibe-files" data-testid="col-files">
                <Tabs
                  value={vibeFileTab}
                  onChange={(value) =>
                    value && setVibeFileTab(value as "changes" | "file")
                  }
                >
                  <Tabs.List className="ds-file-tabs">
                    <Tabs.Tab value="changes" data-testid="vibe-tab-changes">
                      Changes
                    </Tabs.Tab>
                    {selectedFile && (
                      <Tabs.Tab value="file" data-testid="vibe-tab-file">
                        {selectedFile}
                      </Tabs.Tab>
                    )}
                  </Tabs.List>
                </Tabs>
                {vibeFileTab === "file" && selectedFile ? (
                  project && (
                    <FileEditorPane
                      projectHash={project.hash}
                      path={selectedFile}
                      onSave={handleFileSave}
                      onDirtyChange={setEditorDirty}
                    />
                  )
                ) : (
                  <div className="messages" data-testid="vibe-files-content">
                    {project && <DiffPane projectHash={project.hash} />}
                    {(() => {
                      const threadEdits = thread
                        ? filterForTab(
                            [
                              ...itemsFromMessages(messages),
                              ...mergeDeltas(live),
                            ],
                            "diff"
                          )
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
                        <section
                          className="diff-section"
                          data-testid="turn-history-section"
                        >
                          <h2 className="ds-section-heading">Turn History</h2>
                          {allEdits.length === 0 && (
                            <p className="empty">No file changes yet.</p>
                          )}
                          <EventList
                            items={allEdits}
                            showThinking={showThinking}
                            executor={flight?.selected ?? null}
                          />
                        </section>
                      );
                    })()}
                  </div>
                )}
              </section>

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
                <div className="ds-workspace-panel">
                  <div className="ds-rail-section">
                    <div className="ds-rail-label">Workspace</div>
                    <select
                      data-testid="project-picker"
                      value={project?.hash ?? ""}
                      onChange={(event) => {
                        const next = projects.find(
                          (p) => p.hash === event.target.value
                        );
                        if (next) selectProject(next);
                      }}
                    >
                      {projects.length === 0 && (
                        <option value="">No project</option>
                      )}
                      {projects.map((p) => (
                        <option key={p.hash} value={p.hash}>
                          {p.displayName}
                        </option>
                      ))}
                    </select>
                    <div className="ds-rail-actions">
                      <button onClick={onAddProject} data-testid="add-project">
                        Add
                      </button>
                      {project && (
                        <button
                          onClick={onRenameProject}
                          data-testid="rename-project"
                        >
                          Rename
                        </button>
                      )}
                    </div>
                    {project && branches.length > 0 && (
                      <button
                        className="ds-branch-btn"
                        onClick={onOpenBranchPicker}
                        data-testid="branch-indicator"
                      >
                        <BranchIcon />{" "}
                        {branches.find((b) => b.isCurrent)?.name ?? "…"}
                      </button>
                    )}
                  </div>
                </div>
                <div className="ds-threads-panel">
                  <button
                    className="ds-new-thread"
                    onClick={onNewThread}
                    disabled={!project}
                    data-testid="new-thread"
                  >
                    + New Thread
                  </button>
                  <ul data-testid="thread-list">
                    {threads.map((t) => (
                      <li
                        key={t.id}
                        className={t.id === thread?.id ? "active" : ""}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          if (project) selectThread(project.hash, t);
                        }}
                        onKeyDown={onActivateKey(() => {
                          if (project) selectThread(project.hash, t);
                        })}
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
                              <RenameIcon />
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
                              <DeleteIcon />
                            </button>
                          </div>
                        </div>
                        <span className="ds-thread-meta">
                          <span className={`badge ${t.currentMode}`}>
                            {t.currentMode}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="ds-vibe-explorer">
                  <Accordion
                    value={vibeExplorerOpen ? "file-explorer" : null}
                    onChange={(value) => setVibeExplorerOpen(value !== null)}
                    keepMounted={false}
                    transitionDuration={0}
                    chevronPosition="left"
                  >
                    <Accordion.Item value="file-explorer">
                      <Accordion.Control
                        className="ds-rail-disclosure"
                        data-testid="vibe-explorer-toggle"
                      >
                        File Explorer
                      </Accordion.Control>
                      <Accordion.Panel
                        className="ds-rail-disclosure-body"
                        data-testid="vibe-explorer-body"
                      >
                        {project && (
                          <FileTree
                            projectHash={project.hash}
                            projectName={project.displayName}
                            onSelectFile={(path) => {
                              selectFile(path);
                              setVibeFileTab("file");
                            }}
                            activePath={selectedFile}
                            refreshToken={fileTreeRefreshToken}
                            onPathRenamed={onTreePathRenamed}
                            onPathDeleted={onTreePathDeleted}
                            onFilesChanged={onTreeFilesChanged}
                          />
                        )}
                      </Accordion.Panel>
                    </Accordion.Item>
                  </Accordion>
                </div>
              </aside>
            </div>
          )}
        </div>

        {paletteOpen && (
          <FilePalette
            files={paletteFiles}
            onSelect={selectFile}
            onClose={() => setPaletteOpen(false)}
            onCreate={onCreateFile}
            onRename={onRenameFile}
            onDelete={onDeleteFile}
          />
        )}

        {textSearchOpen && (
          <TextSearchPalette
            files={paletteFiles}
            onSearchText={searchProjectText}
            onSelect={selectFile}
            onClose={() => setTextSearchOpen(false)}
          />
        )}

        {settingsOpen && (
          <SettingsPanel
            onOpenProjectSettings={onOpenSettings}
            onClose={() => setSettingsOpen(false)}
          />
        )}

        {bar && bar.kind === "input" && (
          <MantineModal opened onClose={() => setBar(null)} title={bar.label}>
            <input
              id="barInput"
              name="barInput"
              autoFocus
              autoComplete="off"
              defaultValue={bar.value}
              placeholder={bar.value ? undefined : "filename"}
              aria-label={bar.label}
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
          </MantineModal>
        )}

        {bar && bar.kind === "confirm" && (
          <MantineModal opened onClose={() => setBar(null)} title={bar.label}>
            <div className="confirm-actions">
              <button
                onClick={bar.onConfirm}
                className="danger"
                data-testid="confirm-delete"
                autoFocus
              >
                {bar.confirmLabel ?? "Delete"}
              </button>
              <button onClick={() => setBar(null)}>Cancel</button>
            </div>
          </MantineModal>
        )}

        {bar && bar.kind === "select" && (
          <MantineModal opened onClose={() => setBar(null)} title={bar.label}>
            <ul className="ds-branch-list" data-testid="branch-list">
              {(selectQuery.trim()
                ? bar.options.filter(
                    (name) => fuzzyMatch(selectQuery, name) !== null
                  )
                : bar.options
              ).map((name) => (
                <li
                  key={name}
                  role="button"
                  tabIndex={0}
                  onClick={() => bar.submit(name)}
                  onKeyDown={onActivateKey(() => bar.submit(name))}
                  data-testid="branch-option"
                >
                  {name}
                </li>
              ))}
            </ul>
            <input
              id="barSelect"
              name="barSelect"
              autoFocus
              autoComplete="off"
              value={selectQuery}
              onChange={(event) => setSelectQuery(event.target.value)}
              placeholder="new-branch-name"
              aria-label="New branch name"
              data-testid="branch-new-input"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  const value = event.currentTarget.value.trim();
                  if (!value) return;
                  bar.submit(value);
                }
              }}
            />
            <span className="hint">
              Click a branch to switch · Enter a name to create · Esc to cancel
            </span>
          </MantineModal>
        )}
      </div>
    </div>
  );
}
