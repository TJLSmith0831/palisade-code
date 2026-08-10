import {
  useCallback,
  useEffect,
  useMemo,
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
  Button,
  Loader,
  Badge,
  Alert,
  Group,
} from "@mantine/core";
import { IconGitCompare, IconMarkdown } from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

import * as api from "./api";
import type {
  Envelope,
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
import FileEditorPane, {
  evictEditorSession,
  evictProjectSessions,
} from "./FileEditorPane";
import TabBar, { basename } from "./TabBar";
import { isMarkdownPath } from "./openTabs";
import { useOpenTabs } from "./openTabs";
import { loadSession, saveSession, type EditorSession } from "./session";
import CommandPalette from "./CommandPalette";
import { matchesChord, type Command } from "./commands";
import FilePalette from "./FilePalette";
import TextSearchPalette from "./TextSearchPalette";
import FileTree from "./FileTree";
import DiffPane from "./DiffPane";
import GraphPane from "./GraphPane";
import SpecPane from "./SpecPane";
import VerifyPane from "./VerifyPane";
import SettingsPanel, {
  applyAccentHue,
  loadAccentHue,
  applyAppearance,
  loadAppearance,
} from "./SettingsPanel";
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
  showEmptyModePicker?: boolean;
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
  showEmptyModePicker = false,
  onPickMode,
}: ChatSurfaceProps) {
  if (newThreadPicker || showEmptyModePicker) {
    return (
      <>
        {newThreadPicker && (
          <div className="pane-head">
            <strong>New thread</strong>
          </div>
        )}
        <div
          className={`ds-new-thread-picker${showEmptyModePicker ? " ds-vibe-empty-picker" : ""}`}
          data-testid="mode-picker"
        >
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
          <Badge
            size="sm"
            variant="default"
            tt="none"
            data-testid="change-chip"
          >
            {thread.openSpecChangeName}
          </Badge>
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
            <Loader type="dots" size={16} color="var(--muted)" />
          </div>
        )}
      </div>
      <form
        className={`composer ${dragActive ? "drag-active" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          width: "100%",
          padding: 8,
          border: "1px solid var(--border)",
          borderRadius: 14,
          background: "var(--surface)",
          boxSizing: "border-box",
        }}
      >
        {/* Message input */}
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();

              if (!busy && draft.trim()) {
                event.currentTarget.form?.requestSubmit();
              }
            }
          }}
          placeholder={
            flightSelected
              ? "Message, or /propose"
              : "Chat-only — no executor on PATH"
          }
          aria-label="Message"
          data-testid="composer-input"
          minRows={1}
          maxRows={6}
          styles={{
            root: {
              width: "100%",
            },
            input: {
              width: "100%",
              minHeight: 42,
              padding: "10px 12px",
              border: 0,
              background: "transparent",
              boxShadow: "none",
              resize: "none",
              fontSize: 14,
              lineHeight: 1.5,
            },
          }}
        />

        {/* Bottom controls */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 6,
            width: "100%",
            minHeight: 32,
          }}
        >
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
              { label: "Spec", value: "spec" },
              { label: "Go", value: "go" },
            ]}
            size="xs"
            styles={{
              root: {
                width: 190,
                height: 36,

                padding: 2,
                gap: 0,

                background: "transparent",
                border:
                  "1px solid color-mix(in oklab, var(--accent), transparent 80%)",
                borderRadius: 999,

                boxSizing: "border-box",
                overflow: "hidden",
              },

              indicator: {
                background: "var(--accent)",

                borderRadius: 999,

                boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.15)",
              },

              control: {
                flex: "1 1 0",
                width: "50%",
                minWidth: 0,

                height: 32,
                minHeight: 32,

                padding: 0,
                border: 0,
                borderRadius: 999,

                display: "flex",
                alignItems: "center",
                justifyContent: "center",

                background: "transparent",
              },

              label: {
                fontSize: 13,
                fontWeight: 500,
                lineHeight: 1,

                display: "flex",
                alignItems: "center",
                justifyContent: "center",

                width: "100%",
                height: "100%",

                color: "inherit",
              },
            }}
            classNames={{
              control: "mode-selector-control",
              label: "mode-selector-label",
            }}
          />

          <ActionIcon
            type="submit"
            data-testid="composer-send"
            disabled={busy || !draft.trim()}
            aria-label="Send message"
            title="Send message"
            size={30}
            radius="md"
            variant="filled"
            styles={{
              root: {
                flexShrink: 0,
                backgroundColor: "var(--accent)",
                color: "var(--accent-on)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "transform 100ms ease, opacity 100ms ease",
                "&:hover": {
                  backgroundColor: "var(--accent)",
                  opacity: 0.9,
                },
                "&:active": {
                  transform: "scale(0.94)",
                },
                "&:disabled": {
                  opacity: 0.4,
                },
              },
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path stroke="none" d="M0 0h24v24H0z" fill="none" />
              <path d="M15 10l-4 4l6 6l4 -16l-18 7l4 2l2 6l3 -4" />
            </svg>
          </ActionIcon>
        </div>
      </form>
    </>
  );
}

/**
 * An agent's brand glyph, if it has one. Keyed by id because artwork can't
 * come from a backend table — but nothing else in the UI names an agent: the
 * label, the path and the status all come off `Preflight.agents`.
 */
function AgentMark({ id }: { id: string }) {
  if (id !== "claude") return null;
  return (
    <svg viewBox="0 0 256 257" width="12" height="12" aria-hidden="true">
      <path
        fill="#D97757"
        d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z"
      />
    </svg>
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
  // (Vibe's "changes vs file" state used to live here. It said the same
  // thing as the Editor shell's own editor/diff state, and the two could
  // disagree — they're now one `diffOpen`, shared by both shells.)
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
  // Live executor output keyed by the session that produced it. One flat array
  // can't survive concurrent sessions: two agents streaming at once would
  // interleave into one another's transcript, and switching threads mid-turn
  // would fold the session you left into the thread you arrived at.
  const [liveBySession, setLiveBySession] = useState<
    Map<string, { threadId: string; events: ExecutorEvent[] }>
  >(new Map());
  // Busy is per thread, not global: with sessions concurrent, another thread's
  // turn finishing must not unlock this thread's composer, and switching
  // threads must not carry the old thread's spinner across.
  const [busyThreads, setBusyThreads] = useState<Set<string>>(new Set());
  // Set when a propose turn produced more than one change; cleared when the
  // user picks one or dismisses.
  const [specLinkChoice, setSpecLinkChoice] =
    useState<api.SpecLinkAmbiguous | null>(null);
  const setBusyFor = useCallback((threadId: string, value: boolean) => {
    setBusyThreads((previous) => {
      if (previous.has(threadId) === value) return previous;
      const next = new Set(previous);
      if (value) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
  }, []);
  const showThinking = localStorage.getItem(SHOW_THINKING_KEY) === "1";
  // The open files. Shared by both shells, so switching between Vibe and
  // Editor never closes anything or loses where you were in a file.
  const tabs = useOpenTabs();
  const selectedFile = tabs.activePath;
  // Cmd+Shift+V or the IconMarkdown button flips the active Markdown tab
  // between its CodeMirror source and the WYSIWYG editor. No-op for non-md.
  const toggleMdPreview = useCallback(() => {
    if (selectedFile && isMarkdownPath(selectedFile)) {
      tabs.setMdPreview(selectedFile, !tabs.activeMdPreview);
    }
  }, [selectedFile, tabs.activeMdPreview, tabs.setMdPreview]);
  // Set when the filesystem watcher reports an open file changed underneath
  // us; the editor pane decides whether that's a silent reload or a prompt.
  const [externalChange, setExternalChange] = useState<{
    path: string;
    at: number;
  } | null>(null);
  // The saved session for the active project, restored on switch and kept
  // up to date as the editor changes.
  // `session` drives rendering (restored cursors, expanded dirs); the ref is
  // the live copy that accumulates changes between saves. Deliberately NOT
  // re-synced from state on every render — cursor updates are written
  // straight into the ref, and a render-time assignment would erase them.
  const [session, setSession] = useState<EditorSession | null>(null);
  const sessionRef = useRef<EditorSession | null>(null);
  // A search result to scroll to once its file is open.
  const [revealLine, setRevealLine] = useState<{
    path: string;
    line: number;
    at: number;
  } | null>(null);
  // Mirrors the open paths for the fs-changed listener, which is registered
  // once — same reason `current` exists for project/thread.
  const openPathsRef = useRef<string[]>([]);
  openPathsRef.current = tabs.tabs.map((tab) => tab.path);
  // Read through a ref by `selectProject`, whose identity has to stay stable
  // — the launch-restore effect depends on it, and re-running that would
  // re-select the first project on every render.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Which project's editing sessions are currently cached.
  const currentProjectRef = useRef<string | null>(null);
  // The keyboard handler is registered once; these keep it pointed at the
  // live tab list without re-binding on every tab change.
  const activePathRef = useRef<string | null>(null);
  activePathRef.current = tabs.activePath;
  // Whether the centre pane is showing the diff instead of a file. One state
  // for both shells — it used to be `centerTab` in one and `vibeFileTab` in
  // the other, two names for the same idea that could disagree.
  const [diffOpen, setDiffOpen] = useState(false);
  // Which workspace shell is rendered — layout only, independent of a thread's
  // own Spec/Go mode (see openspec/changes/vibe-editor-shell-redesign).
  // Defaults to "editor" (today's layout) so existing users see no change
  // until they opt into "vibe" via the toggle.
  const [centerShell, setCenterShellState] = useState<"vibe" | "editor">(
    "editor"
  );
  // Set once the user picks a shell themselves. The launch restore runs
  // asynchronously, and without this it would undo a choice made while the
  // project was still loading.
  const shellChosenRef = useRef(false);
  const setCenterShell = useCallback((shell: "vibe" | "editor") => {
    shellChosenRef.current = true;
    setCenterShellState(shell);
  }, []);
  const [rightTab, setRightTab] = useState<
    "threads" | "codemap" | "specs" | "verify" | "terminal"
  >("threads");
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
  const vibeChat = useResizable({
    storageKey: `floo:layout:${layoutHash}:vibe-chat`,
    defaultSize: 520,
    min: 380,
    max: 900,
    axis: "horizontal",
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
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // The terminal is spawned lazily — a shell per project on launch is not
  // what anyone wants. Once opened it stays mounted, so collapsing the
  // panel keeps the scrollback instead of disposing the instance.
  const terminalEverOpened = useRef(false);
  if (terminalPlacement === "bottom" && !terminalPanel.collapsed) {
    terminalEverOpened.current = true;
  }
  const [paletteFiles, setPaletteFiles] = useState<string[]>([]);
  const filesCache = useRef<Map<string, string[]>>(new Map());
  const [fileTreeRefreshToken, setFileTreeRefreshToken] = useState(0);
  // Bumped when the working tree changes under the diff — an agent turn
  // ending, or a save. The pane used to fetch once on mount and then show
  // that forever.
  const [diffRefreshToken, setDiffRefreshToken] = useState(0);

  const handleFileSave = useCallback(
    (edit: { path: string; before: string; after: string }) => {
      setFileEdits((prev) => [...prev, edit]);
      // A save changes the working tree, so the diff behind the toggle is
      // now out of date.
      setDiffRefreshToken((t) => t + 1);
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

  // Restore project-scoped appearance (shell/comment/text colors) whenever a
  // project loads or switches. SettingsPanel only loads while open, so this
  // effect keeps the CSS overrides in sync when the panel is closed.
  useEffect(() => {
    if (!project) {
      applyAppearance({});
      return;
    }
    let cancelled = false;
    loadAppearance(project.hash).then((a) => {
      if (!cancelled) applyAppearance(a);
    });
    return () => {
      cancelled = true;
    };
  }, [project?.hash]);

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
      // Leaving a thread releases its idle sessions (closed `done`, D20);
      // anything mid-turn keeps running and keeps streaming into its own key.
      const leaving = current.current.thread?.id;
      if (leaving && leaving !== next?.id) api.leaveThread(leaving).catch(fail);
      setThread(next);
      setNewThreadPicker(false);
      if (!next) {
        setMessages([]);
        return;
      }
      localStorage.setItem(lastThreadKey(projectHash), next.id);
      clearLiveFor(next.id);
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

  const selectProjectNow = useCallback(
    async (next: Project) => {
      try {
        const previous = currentProjectRef.current;
        // Applied before the awaits below: anything the user clicks while
        // the project is still loading has to win, not be undone by a
        // restore landing a moment later.
        const saved = loadSession(next.hash);
        sessionRef.current = saved;
        setSession(saved);
        if (!shellChosenRef.current) setCenterShellState(saved.centerShell);
        setDiffOpen(saved.diffOpen);

        const refreshed = await api.switchProject(next.hash);
        setProject(refreshed);
        // Editing sessions are per-project; keeping them would leak memory
        // and let a stale document reappear if the project came back.
        if (previous && previous !== refreshed.hash)
          evictProjectSessions(previous);
        currentProjectRef.current = refreshed.hash;
        tabsRef.current.closeAll();
        setFileEdits([]);

        // Reopen what was on screen last time. Files that have since gone
        // are dropped silently — an agent deleting one between sessions is
        // routine here.
        const alive = await Promise.all(
          saved.openPaths.map(async (path) => {
            try {
              await api.readFileContent(refreshed.hash, path);
              return path;
            } catch (err) {
              // A binary or oversized file is still a legitimate tab; only
              // a genuinely missing one gets dropped.
              return api.isBinaryError(err) || api.tooLargeBytes(err) !== null
                ? path
                : null;
            }
          })
        );
        for (const path of alive) if (path) tabsRef.current.open(path);
        if (saved.activePath && alive.includes(saved.activePath)) {
          tabsRef.current.open(saved.activePath);
        }
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

  const selectProject = useCallback(
    async (next: Project) => {
      // Switching projects closes every tab, so unsaved work would go with
      // it. Opening a file has been guarded for a while; this path never
      // was, and it is the one that discards every dirty buffer at once.
      const open = tabsRef.current;
      if (!open.anyDirty) {
        await selectProjectNow(next);
        return;
      }
      const dirty = open.tabs.filter((tab) => tab.dirty);
      setBar({
        kind: "confirm",
        label:
          dirty.length === 1
            ? `Discard unsaved changes to "${dirty[0].path}"?`
            : `Discard unsaved changes to ${dirty.length} files?`,
        confirmLabel: "Discard",
        onConfirm: () => {
          setBar(null);
          void selectProjectNow(next);
        },
      });
    },
    [selectProjectNow]
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

  // Opening a file now adds a tab rather than replacing the one open file,
  // so switching away no longer risks anything and needs no confirmation.
  // The discard guard moved to closing a tab, which is where work actually
  // gets thrown away.
  const selectFile = useCallback(
    (path: string, line?: number) => {
      setDiffOpen(false);
      tabs.open(path);
      // Consumed once by the editor pane; the timestamp makes a repeat jump
      // to the same line a new instruction rather than a no-op.
      if (line !== undefined) setRevealLine({ path, line, at: Date.now() });
    },
    [tabs]
  );

  const closeTab = useCallback(
    (path: string) => {
      const tab = tabs.tabs.find((t) => t.path === path);
      const forget = () => {
        if (project) evictEditorSession(project.hash, path);
        tabs.close(path);
      };
      if (!tab?.dirty) {
        forget();
        return;
      }
      setBar({
        kind: "confirm",
        label: `Discard unsaved changes to "${path}"?`,
        confirmLabel: "Discard",
        onConfirm: () => {
          setBar(null);
          forget();
        },
      });
    },
    [tabs, project]
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
    setDiffOpen(false);
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

  const busy = thread ? busyThreads.has(thread.id) : false;
  /** Busy for whichever thread is on screen — what the composer's callers mean. */
  const setBusy = useCallback(
    (value: boolean) => {
      const id = current.current.thread?.id;
      if (id) setBusyFor(id, value);
    },
    [setBusyFor]
  );

  // What the chat surface renders: only the sessions belonging to the thread
  // on screen. Sessions on other threads keep streaming into their own keys.
  const live = useMemo(
    () =>
      [...liveBySession.values()]
        .filter((entry) => entry.threadId === thread?.id)
        .flatMap((entry) => entry.events),
    [liveBySession, thread?.id]
  );

  // A thread's live buffer is dropped once its history is re-read from disk —
  // every event was already persisted as it arrived, so keeping it would
  // render each one twice. Scoped to one thread so another thread's in-flight
  // session isn't wiped along with it.
  const clearLiveFor = useCallback((threadId: string) => {
    setLiveBySession((previous) => {
      const next = new Map(previous);
      for (const [id, entry] of next) {
        if (entry.threadId === threadId) next.delete(id);
      }
      return next;
    });
  }, []);

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
    clearLiveFor(thread.id);
  }, []);

  useEffect(() => {
    api.preflight().then(setFlight, fail);
  }, []);

  // Executor output streams in live; once the turn ends, the persisted log
  // becomes the source of truth again so both paths can't drift.
  useEffect(() => {
    const streaming = listen<Envelope>(
      "executor-event",
      async ({ payload: { sessionId, threadId, event } }) => {
        if (event.kind === "done" || event.kind === "crashed") {
          setLiveBySession((previous) => {
            const next = new Map(previous);
            next.delete(sessionId);
            return next;
          });
          // Each thread's own composer unlocks when its own turn ends.
          setBusyFor(threadId, false);
          // But a session finishing on some other thread must not drag the
          // thread on screen back to its own log.
          if (threadId !== current.current.thread?.id) return;
          setDiffRefreshToken((t) => t + 1);
          await refresh().catch(fail);
          return;
        }
        setLiveBySession((previous) => {
          const next = new Map(previous);
          const entry = next.get(sessionId);
          next.set(sessionId, {
            threadId,
            events: [...(entry?.events ?? []), event],
          });
          return next;
        });
      }
    );
    const updated = listen<string>("thread-updated", () => {
      refresh().catch(fail);
    });
    // A propose turn that produced more than one change can't be guessed at;
    // the thread's spec link is durable, so the user picks (D12).
    const ambiguous = listen<api.SpecLinkAmbiguous>(
      "spec-link-ambiguous",
      ({ payload }) => setSpecLinkChoice(payload)
    );
    // A graphify watch spawn failure or crash — the routine "not on PATH"
    // case is already covered by the persistent preflight warning banner.
    const warned = listen<string>("harness-warning", ({ payload }) =>
      fail(payload)
    );
    return () => {
      streaming.then((un) => un());
      updated.then((un) => un());
      ambiguous.then((un) => un());
      warned.then((un) => un());
    };
  }, [refresh, setBusyFor]);

  // Files changing for a reason that wasn't us — an agent turn writing
  // directly to disk, a branch switch, another editor. Kept as its own
  // effect (rather than folded into the executor stream above) because the
  // executor's own FileEdit events only describe what the agent *says* it
  // wrote, and say nothing about git or anything outside Floo.
  useEffect(() => {
    const changed = listen<api.FsChanged>("fs-changed", ({ payload }) => {
      // A late event from the project the user just left would otherwise
      // refresh the new project's tree.
      if (payload.projectHash !== current.current.project?.hash) return;
      // The tree and the ⌘P palette both cache; without this they keep
      // showing files the agent already renamed or deleted.
      filesCache.current.delete(payload.projectHash);
      setFileTreeRefreshToken((t) => t + 1);

      for (const open of openPathsRef.current) {
        if (payload.paths.includes(open)) {
          setExternalChange({ path: open, at: Date.now() });
        }
      }
    });
    return () => {
      changed.then((un) => un());
    };
  }, []);

  // Persist the editor's shape as it changes. Cheap enough to do on every
  // change (localStorage, one small object) that it doesn't need debouncing,
  // and it means a crash doesn't cost the layout.
  useEffect(() => {
    const hash = project?.hash;
    if (!hash || !sessionRef.current) return;
    const next: EditorSession = {
      ...sessionRef.current,
      openPaths: tabs.tabs.map((tab) => tab.path),
      activePath: tabs.activePath,
      centerShell,
      diffOpen,
    };
    sessionRef.current = next;
    saveSession(hash, next);
  }, [project?.hash, tabs.tabs, tabs.activePath, centerShell, diffOpen]);

  const rememberCursor = useCallback((path: string, offset: number) => {
    const current = sessionRef.current;
    if (!current || current.cursors[path] === offset) return;
    sessionRef.current = {
      ...current,
      cursors: { ...current.cursors, [path]: offset },
    };
  }, []);

  // Cursor moves constantly, so it rides along with the next save rather
  // than writing to storage on every keystroke. Flushed when you leave a
  // file (its cursor is now final) and when the window goes away.
  //
  // Deliberately not flushed on unmount: React unmounts during teardown,
  // and a write there outlives whatever cleared storage before it.
  useEffect(() => {
    const flush = () => {
      const hash = currentProjectRef.current;
      if (hash && sessionRef.current) saveSession(hash, sessionRef.current);
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  useEffect(() => {
    const hash = currentProjectRef.current;
    if (hash && sessionRef.current) saveSession(hash, sessionRef.current);
  }, [tabs.activePath]);

  const rememberExpandedDirs = useCallback((dirs: string[]) => {
    const current = sessionRef.current;
    if (!current) return;
    sessionRef.current = { ...current, expandedDirs: dirs };
  }, []);

  const rememberIncludeHidden = useCallback((includeHidden: boolean) => {
    const current = sessionRef.current;
    if (!current) return;
    sessionRef.current = { ...current, includeHidden };
  }, []);

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
    (query: string, options: api.SearchOptions) => {
      if (!project) return Promise.resolve({ matches: [], truncated: false });
      return api.searchText(project.hash, query, options);
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
      tabs.rename(from, to);
    },
    [project, refreshPaletteFiles]
  );

  const onDeleteFile = useCallback(
    async (path: string) => {
      if (!project) return;
      await api.deletePath(project.hash, path);
      await refreshPaletteFiles();
      setFileTreeRefreshToken((t) => t + 1);
      tabs.dropPath(path);
    },
    [project, refreshPaletteFiles]
  );

  // The file tree performs its own create/rename/delete/move (surgical
  // per-directory refresh, no full-tree collapse) — these just keep the
  // open editor tab and the file-palette cache in sync afterward.
  const onTreePathRenamed = useCallback(
    (from: string, to: string) => tabs.rename(from, to),
    [tabs]
  );

  const onTreePathDeleted = useCallback(
    (path: string) => tabs.dropPath(path),
    [tabs]
  );

  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;

  const onTreeFilesChanged = useCallback(() => {
    if (project) filesCache.current.delete(project.hash);
  }, [project]);

  // Every action, declared once. The palette lists these and the keyboard
  // handler below dispatches them, so a shortcut can't be bound in one
  // place and described differently in another.
  const commands = useMemo<Command[]>(
    () => [
      {
        id: "file.open",
        group: "Go",
        label: "Go to file…",
        chord: "Mod+P",
        keywords: "open quick jump",
        enabled: !!project,
        run: () => void openFilePalette(),
      },
      {
        id: "file.search",
        group: "Go",
        label: "Find in files…",
        chord: "Mod+Shift+F",
        keywords: "search grep text",
        enabled: !!project,
        run: () => void openTextSearch(),
      },
      {
        id: "tab.close",
        group: "Tabs",
        label: "Close tab",
        chord: "Mod+W",
        enabled: !!activePathRef.current,
        run: () => {
          const path = activePathRef.current;
          if (path) closeTabRef.current(path);
        },
      },
      {
        id: "tab.reopen",
        group: "Tabs",
        label: "Reopen closed tab",
        chord: "Mod+Shift+T",
        run: () => tabsRef.current.reopenLast(),
      },
      {
        id: "tab.next",
        group: "Tabs",
        label: "Next tab",
        chord: "Ctrl+Tab",
        run: () => tabsRef.current.cycle(1),
      },
      {
        id: "tab.previous",
        group: "Tabs",
        label: "Previous tab",
        chord: "Ctrl+Shift+Tab",
        run: () => tabsRef.current.cycle(-1),
      },
      {
        id: "view.diff",
        group: "View",
        label: "Toggle changes view",
        keywords: "diff git review",
        run: () => setDiffOpen((open) => !open),
      },
      {
        id: "view.shell",
        group: "View",
        label: "Switch between Vibe and Editor",
        keywords: "shell layout agent",
        run: () => setCenterShell(centerShell === "vibe" ? "editor" : "vibe"),
      },
      {
        id: "view.rightPanel",
        group: "View",
        label: "Toggle right panel",
        chord: "Mod+J",
        run: () => rightPanel.toggleCollapsed(),
      },
      {
        id: "view.leftRail",
        group: "View",
        label: "Toggle file tree",
        chord: "Mod+Backslash",
        keywords: "explorer sidebar",
        run: () => leftRail.toggleCollapsed(),
      },
      {
        id: "view.terminal",
        group: "View",
        label: "Toggle terminal",
        chord: "Mod+Backtick",
        run: () => toggleTerminal(),
      },
      {
        id: "app.settings",
        group: "App",
        label: "Open settings",
        keywords: "preferences font theme wrap",
        run: () => setSettingsOpen(true),
      },
      {
        id: "app.projectSettings",
        group: "App",
        label: "Edit .project-settings.json",
        keywords: "format on save executor",
        enabled: !!project,
        run: () => void onOpenSettings(),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      project,
      centerShell,
      // Recomputed as tabs come and go: "Close tab" is only offered when
      // there is one, and a stale memo would keep hiding it.
      tabs.activePath,
      openFilePalette,
      openTextSearch,
      rightPanel.toggleCollapsed,
      leftRail.toggleCollapsed,
      toggleTerminal,
      setCenterShell,
    ]
  );
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBar(null);
      if (matchesChord(event, "Mod+Shift+P")) {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      const command = commandsRef.current.find(
        (candidate) => candidate.chord && matchesChord(event, candidate.chord)
      );
      if (!command) return;
      event.preventDefault();
      command.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
                {flight?.selected ? (
                  <span className="ds-preflight-label">
                    <AgentMark id={flight.selected} />
                    {flight.agents.find((a) => a.id === flight.selected)
                      ?.label ?? flight.selected}
                  </span>
                ) : (
                  "—"
                )}
              </button>
            </Tooltip>
          </div>
        </header>
        {flight && flight.warnings.length > 0 && (
          <Alert
            color="var(--warn)"
            variant="light"
            radius={0}
            data-testid="preflight-warnings"
          >
            {flight.warnings.map((warning) => (
              <div key={warning}>⚠ {warning}</div>
            ))}
          </Alert>
        )}

        {specLinkChoice && (
          <Alert
            color="var(--warn)"
            variant="light"
            radius={0}
            withCloseButton
            onClose={() => setSpecLinkChoice(null)}
            title="Which change is this thread working on?"
            data-testid="spec-link-ambiguous"
          >
            That propose turn created more than one change, so the link can't be
            inferred. Pick one, or dismiss to leave the thread unlinked.
            <Group gap="xs" mt="xs">
              {specLinkChoice.names.map((name) => (
                <Button
                  key={name}
                  size="compact-xs"
                  variant="light"
                  onClick={() => {
                    if (!project) return;
                    api
                      .setSpecChange(
                        project.hash,
                        specLinkChoice.threadId,
                        name
                      )
                      .then(() => {
                        setSpecLinkChoice(null);
                        return refresh();
                      })
                      .catch(fail);
                  }}
                >
                  {name}
                </Button>
              ))}
            </Group>
          </Alert>
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
                    initialExpanded={session?.expandedDirs}
                    onExpandedChange={rememberExpandedDirs}
                    initialIncludeHidden={session?.includeHidden}
                    onIncludeHiddenChange={rememberIncludeHidden}
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
                <TabBar
                  tabs={tabs.tabs}
                  activePath={selectedFile}
                  onSelect={(path) => {
                    setDiffOpen(false);
                    tabs.open(path);
                  }}
                  onClose={closeTab}
                  diffOpen={diffOpen}
                  onToggleDiff={() => setDiffOpen((open) => !open)}
                  activeMdPreview={tabs.activeMdPreview}
                  onToggleMdPreview={toggleMdPreview}
                />
                <div className="ds-breadcrumbs" data-testid="breadcrumbs">
                  <span>{project?.displayName ?? "—"}</span>
                  {selectedFile && (
                    <>
                      <span className="ds-crumb-sep">/</span>
                      <span className="ds-crumb-active">{selectedFile}</span>
                    </>
                  )}
                </div>
                {!diffOpen ? (
                  project ? (
                    <FileEditorPane
                      projectHash={project.hash}
                      path={selectedFile}
                      onSave={handleFileSave}
                      onDirtyChange={tabs.setDirty}
                      externalChange={externalChange}
                      revealLine={revealLine}
                      initialCursor={
                        selectedFile
                          ? session?.cursors[selectedFile]
                          : undefined
                      }
                      onCursorChange={rememberCursor}
                      mdPreview={tabs.activeMdPreview}
                      onToggleMdPreview={toggleMdPreview}
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
                    {project && (
                      <DiffPane
                        projectHash={project.hash}
                        refreshToken={diffRefreshToken}
                      />
                    )}
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
                  <div
                    className="ds-resize-handle ds-resize-handle-y"
                    data-testid="resize-terminal-panel"
                    onPointerDown={bindDrag(
                      terminalPanel.handleProps,
                      "row-resize"
                    )}
                  />
                )}
                {/* Hidden rather than unmounted while collapsed: unmounting
                    disposes the xterm instance, so every collapse threw away
                    the scrollback and re-spawned the shell on reopen. */}
                {terminalPlacement === "bottom" &&
                  terminalEverOpened.current && (
                    <div
                      className="ds-terminal-panel"
                      data-testid="terminal-panel"
                      hidden={terminalPanel.collapsed}
                      style={
                        {
                          "--terminal-h": `${terminalPanel.size}px`,
                          display: terminalPanel.collapsed ? "none" : undefined,
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
                              setRightTab(
                                value as
                                  "threads" | "codemap" | "specs" | "verify"
                              )
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
                              <Tabs.Tab value="specs" data-testid="tab-specs">
                                Specs
                              </Tabs.Tab>
                              <Tabs.Tab value="verify" data-testid="tab-verify">
                                Verify
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
                                      <Badge
                                        size="xs"
                                        variant={
                                          t.currentMode === "spec"
                                            ? "light"
                                            : "default"
                                        }
                                      >
                                        {t.currentMode}
                                      </Badge>
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {rightTab === "codemap" && project && (
                            <GraphPane projectHash={project.hash} />
                          )}
                          {rightTab === "specs" && project && (
                            <SpecPane
                              projectHash={project.hash}
                              linkedChange={thread?.openSpecChangeName}
                            />
                          )}
                          {rightTab === "verify" && project && (
                            <VerifyPane
                              projectHash={project.hash}
                              threadId={thread?.id}
                            />
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
              <section
                className="ds-vibe-chat"
                data-testid="vibe-chat-column"
                style={
                  {
                    "--vibe-chat-w": `${vibeChat.size}px`,
                  } as CSSProperties
                }
              >
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
                  showEmptyModePicker={threads.length === 0 && !thread}
                  onPickMode={onPickMode}
                />
              </section>

              <div
                className="ds-resize-handle ds-resize-handle-x"
                data-testid="resize-vibe-chat"
                onPointerDown={bindDrag(vibeChat.handleProps, "col-resize")}
              />

              <section className="ds-vibe-files" data-testid="col-files">
                {/* Vibe is chat-first and shares its width with the
                    conversation, so it shows the active file rather than a
                    full tab strip. Tab state is shared, so switching to the
                    Editor shell finds everything still open. */}
                <div className="ds-file-tabs" data-testid="vibe-file-tabs">
                  {selectedFile ? (
                    <span
                      className="ds-tab active"
                      data-testid="vibe-active-file"
                    >
                      {tabs.activeIsDirty && (
                        <span className="ds-tab-dirty">●</span>
                      )}
                      {basename(selectedFile)}
                    </span>
                  ) : (
                    <span className="hint">No file open</span>
                  )}
                  {tabs.tabs.length > 1 && (
                    <Tooltip
                      label={`${tabs.tabs.length - 1} more open — open the Editor shell`}
                      withinPortal
                    >
                      <Button
                        variant="subtle"
                        size="compact-xs"
                        onClick={() => setCenterShell("editor")}
                        data-testid="vibe-more-tabs"
                      >
                        +{tabs.tabs.length - 1}
                      </Button>
                    </Tooltip>
                  )}
                  {isMarkdownPath(selectedFile) && (
                    <Tooltip
                      label={
                        tabs.activeMdPreview ? "Hide preview" : "Show preview"
                      }
                      withinPortal
                    >
                      <ActionIcon
                        variant={tabs.activeMdPreview ? "filled" : "subtle"}
                        aria-label={
                          tabs.activeMdPreview ? "Hide preview" : "Show preview"
                        }
                        aria-pressed={tabs.activeMdPreview}
                        onClick={toggleMdPreview}
                        data-testid="vibe-toggle-md-preview"
                        ml="auto"
                      >
                        <IconMarkdown size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  <Tooltip
                    label={diffOpen ? "Back to editor" : "Review changes"}
                    withinPortal
                  >
                    <ActionIcon
                      variant={diffOpen ? "filled" : "subtle"}
                      aria-label={
                        diffOpen ? "Back to editor" : "Review changes"
                      }
                      aria-pressed={diffOpen}
                      onClick={() => setDiffOpen((open) => !open)}
                      data-testid="vibe-toggle-diff"
                      ml={isMarkdownPath(selectedFile) ? undefined : "auto"}
                    >
                      <IconGitCompare size={16} />
                    </ActionIcon>
                  </Tooltip>
                </div>
                {!diffOpen && selectedFile ? (
                  project && (
                    <FileEditorPane
                      projectHash={project.hash}
                      path={selectedFile}
                      onSave={handleFileSave}
                      onDirtyChange={tabs.setDirty}
                      externalChange={externalChange}
                      revealLine={revealLine}
                      initialCursor={
                        selectedFile
                          ? session?.cursors[selectedFile]
                          : undefined
                      }
                      onCursorChange={rememberCursor}
                      mdPreview={tabs.activeMdPreview}
                      onToggleMdPreview={toggleMdPreview}
                    />
                  )
                ) : (
                  <div className="messages" data-testid="vibe-files-content">
                    {project && (
                      <DiffPane
                        projectHash={project.hash}
                        refreshToken={diffRefreshToken}
                      />
                    )}
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
                          <Badge
                            size="xs"
                            variant={
                              t.currentMode === "spec" ? "light" : "default"
                            }
                          >
                            {t.currentMode}
                          </Badge>
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
                            // `selectFile` already leaves the diff, so
                            // picking a file in Vibe lands on that file.
                            onSelectFile={selectFile}
                            activePath={selectedFile}
                            refreshToken={fileTreeRefreshToken}
                            initialExpanded={session?.expandedDirs}
                            onExpandedChange={rememberExpandedDirs}
                            initialIncludeHidden={session?.includeHidden}
                            onIncludeHiddenChange={rememberIncludeHidden}
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
            projectHash={project?.hash ?? ""}
            onOpenProjectSettings={onOpenSettings}
            onClose={() => setSettingsOpen(false)}
          />
        )}

        {commandPaletteOpen && (
          <CommandPalette
            commands={commands}
            onClose={() => setCommandPaletteOpen(false)}
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
