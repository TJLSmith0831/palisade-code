import {
  lazy,
  memo,
  Suspense,
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
  Textarea,
  TextInput,
  Box,
  SegmentedControl,
  ActionIcon,
  Button,
  Loader,
  Badge,
  Alert,
  Group,
  UnstyledButton,
} from "@mantine/core";
import {
  IconGitBranch,
  IconGitCompare,
  IconLayoutSidebarFilled,
  IconLayoutSidebarRightFilled,
  IconMarkdown,
  IconSettings,
  IconTerminal2,
} from "@tabler/icons-react";
import { useDebouncedCallback } from "@mantine/hooks";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

import * as api from "./api";
import { useAppShell } from "./hooks/useAppShell";
import { useProjectManager } from "./hooks/useProjectManager";
import { useExecutor } from "./hooks/useExecutor";
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
import { deriveStage, type SpecStage } from "./stage";
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
import { isMarkdownPath, tabKey, useOpenTabs } from "./openTabs";
import { loadSession, saveSession, type EditorSession } from "./session";
import CommandPalette from "./CommandPalette";
import { matchesChord, type Command } from "./commands";
import FilePalette from "./FilePalette";
import TextSearchPalette from "./TextSearchPalette";
import FileTree from "./FileTree";
import { useFileTreeCache } from "./FileTreeCache";
import DiffPane from "./DiffPane";
const GraphPane = lazy(() => import("./GraphPane"));
import SpecPane from "./SpecPane";
import SpecChangeTab from "./SpecChangeTab";
import VibeSpecLauncher from "./VibeSpecLauncher";
import VerifyPane from "./VerifyPane";
import SettingsPanel, {
  applyAccentHue,
  loadAccentHue,
  applyAppearance,
  loadAppearance,
} from "./SettingsPanel";
import TerminalPane from "./TerminalPane";
import { enableModernWindowStyle } from "./macRoundedCorners";
import { type UseResizableResult } from "./useResizable";
import "./App.css";

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
  flight: Preflight | null;
  flightSelected: boolean;
  /** Probed model selector for the effective provider, or its load state. */
  models: api.ModelState | "loading" | { error: string } | null;
  onPickExecutor: (agentId: string) => void;
  onPickModel: (modelId: string) => void;
  /** The model menu was opened — probe the provider if not yet cached. */
  onProbeModels: () => void;
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void;
  /** Stop the live session for this thread. */
  onStop: () => void;
  onRenameThread: (target: ThreadMeta) => void;
  onSpec: () => void;
  onGo: () => void;
  /** "Apply" — fires grill-apply one-shot in ready_to_apply stage. */
  onApply: () => void;
  /** Spec-mode stage derivation (amended D19). */
  stage: SpecStage;
  dragActive: boolean;
  newThreadPicker: boolean;
  showEmptyModePicker?: boolean;
  /** D19/D20: deferred mode — "go" shows an empty composer, "spec" shows the framing menu. */
  pendingMode?: api.Mode | null;
  /** D1: spec-type framing menu is visible (Feature/Bugfix/Other cards). */
  specTypePicker?: boolean;
  /** D13: Back button on the framing menu returns to the Vibe/Spec picker. */
  onSpecTypeBack?: () => void;
  /** D5: spec-type selection starts grill-explore with the spec type as body. */
  onPickSpecType?: (specType: string) => void;
  /** D9: composer-toggle framing menu — shown when toggling an existing thread to spec mode. */
  composerSpecTypePicker?: boolean;
  /** D19/D20: true during async thread creation — prevents mode picker flash. */
  transitioning?: boolean;
  /** D21: executor selected in the framing menu (before thread exists). */
  framingExecutor?: string | null;
  /** D21: model selected in the framing menu (before thread exists). */
  framingModel?: string | null;
  /** D21: set the framing-menu executor (stored locally, persisted on thread creation). */
  onPickFramingExecutor?: (agentId: string) => void;
  /** D21: set the framing-menu model (stored locally, persisted on thread creation). */
  onPickFramingModel?: (modelId: string) => void;
  /** D9: spec-type selection from the composer-toggle framing menu. */
  onPickComposerSpecType?: (specType: string) => void;
  /** D13: Back button on the composer-toggle framing menu returns to the chat. */
  onComposerSpecTypeBack?: () => void;
  onPickMode: (mode: api.Mode) => void;
  onOpenSpec?: (specName: string) => void;
  threadBypass: boolean;
  onToggleBypass: () => void;
  prefsMenuOpen: boolean;
  setPrefsMenuOpen: (open: boolean) => void;
  hasLiveSession: boolean;
};

export const ChatSurface = memo(
  function ChatSurface({
    project,
    thread,
    messages,
    live,
    busy,
    showThinking,
    executor,
    flight,
    flightSelected,
    models,
    onPickExecutor,
    onPickModel,
    onProbeModels,
    draft,
    setDraft,
    onSend,
    onStop,
    onRenameThread,
    onSpec,
    onGo,
    onApply,
    stage,
    dragActive,
    newThreadPicker,
    showEmptyModePicker = false,
    pendingMode = null,
    specTypePicker = false,
    onSpecTypeBack,
    onPickSpecType,
    composerSpecTypePicker = false,
    transitioning = false,
    framingExecutor = null,
    framingModel = null,
    onPickFramingExecutor,
    onPickFramingModel,
    onPickComposerSpecType,
    onComposerSpecTypeBack,
    onPickMode,
    onOpenSpec,
    threadBypass,
    onToggleBypass,
    prefsMenuOpen,
    setPrefsMenuOpen,
    hasLiveSession,
  }: ChatSurfaceProps) {
    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const [modelQuery, setModelQuery] = useState("");
    // D6/D15: "Other" spec-type text input state — local to the framing menu.
    const [otherSpecText, setOtherSpecText] = useState("");
    const [showOtherInput, setShowOtherInput] = useState(false);
    // Auto-scroll: stick to the bottom as messages stream in, but yield if the
    // user scrolls up to read. Sending a new message re-arms it. ChatSurface
    // isn't remounted on thread switch, so scrolling up in one thread would
    // otherwise leave the next thread opened mid-scroll instead of at the
    // bottom — re-arm on thread switch too.
    const messagesRef = useRef<HTMLDivElement>(null);
    const [autoScroll, setAutoScroll] = useState(true);
    useEffect(() => {
      setAutoScroll(true);
    }, [thread?.id]);
    const executorLabel = executor
      ? (flight?.agents.find((a) => a.id === executor)?.name ?? executor)
      : null;
    const modelError =
      models && typeof models === "object" && "error" in models
        ? models.error
        : null;
    const modelState =
      models && typeof models === "object" && !("error" in models)
        ? models
        : null;
    const filteredModels = useMemo(() => {
      if (!modelState) return [];
      if (!modelQuery) return modelState.models;
      return modelState.models
        .map((m) => ({ model: m, score: fuzzyMatch(modelQuery, m.name) }))
        .filter((x) => x.score !== null)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .map((x) => x.model);
    }, [modelState, modelQuery]);
    const items = useMemo(
      () =>
        filterForTab(
          [...itemsFromMessages(messages), ...mergeDeltas(live)],
          "chat"
        ),
      [messages, live]
    );
    // Re-arm auto-scroll on send, then let the effect below pin to bottom.
    const handleSend = () => {
      setAutoScroll(true);
      onSend();
    };
    const handleScroll = () => {
      const el = messagesRef.current;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      setAutoScroll(nearBottom);
    };
    useEffect(() => {
      if (!autoScroll) return;
      const el = messagesRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    }, [items, busy, autoScroll]);
    useEffect(() => {
      if (!modelMenuOpen) setModelQuery("");
    }, [modelMenuOpen]);
    const currentModelId = thread?.model ?? modelState?.current ?? null;
    const modelLabel =
      models === "loading"
        ? "…"
        : modelError
          ? "models unavailable"
          : currentModelId
            ? (modelState?.models.find((m) => m.id === currentModelId)?.name ??
              currentModelId)
            : "default";
    // Provider/model picker row — shared between the spec-type framing menu
    // (new thread) and the composer-toggle framing menu (existing thread).
    // Renders the same executor + model dropdowns as the chat composer's
    // bottom controls, but without the mode selector and send button.
    // The spec type cards are disabled until a provider is selected.
    // When no thread exists (new-thread framing menu), the executor/model
    // selection is stored in framingExecutor/framingModel and persisted on
    // the thread when it's created. When a thread exists (composer-toggle),
    // the normal executor/onPickExecutor path is used.
    // specTypePicker means the new-thread framing menu is up — no thread
    // has been created yet. `thread` may still hold the previously selected
    // thread (onNewThread doesn't clear it, since the sidebar keeps showing
    // it underneath), so it must not be used as the "does a thread exist"
    // signal here — that would silently read/mutate the old thread's
    // executor/model instead of the framingExecutor/framingModel scratch
    // state meant for the thread about to be created.
    const framingThread = specTypePicker ? null : thread;
    const framingExecutorId = framingThread
      ? executor
      : (framingExecutor ?? flight?.selected ?? null);
    const framingModelId = framingThread ? currentModelId : framingModel;
    const framingExecutorLabel = framingExecutorId
      ? (flight?.agents.find((a) => a.id === framingExecutorId)?.name ??
        framingExecutorId)
      : null;
    const framingModelLabel = framingModelId
      ? (modelState?.models.find((m) => m.id === framingModelId)?.name ??
        framingModelId)
      : "default";
    const handleFramingExecutor = (agentId: string) => {
      if (framingThread) {
        onPickExecutor(agentId);
      } else {
        onPickFramingExecutor?.(agentId);
      }
    };
    const handleFramingModel = (modelId: string) => {
      if (framingThread) {
        onPickModel(modelId);
      } else {
        onPickFramingModel?.(modelId);
      }
    };
    const providerSelected = !!framingExecutorId;
    const framingPickerRow = (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 12,
        }}
        data-testid="framing-picker-row"
      >
        <Menu opened={prefsMenuOpen} onChange={setPrefsMenuOpen}>
          <Menu.Target>
            <button
              className="ds-icon-btn"
              data-testid="framing-executor-btn"
              style={{ fontSize: 12, padding: "4px 8px" }}
            >
              {framingExecutorLabel ?? "select provider"}
            </button>
          </Menu.Target>
          <Menu.Dropdown
            className="ds-model-menu"
            data-testid="framing-executor-menu"
          >
            <Menu.Label>Provider</Menu.Label>
            {flight?.agents.map((a) => (
              <Menu.Item
                key={a.id}
                className={`ds-model-opt ${framingExecutorId === a.id ? "selected" : ""}`}
                data-testid={`framing-executor-opt-${a.id}`}
                onClick={() => {
                  if (a.id !== framingExecutorId) {
                    handleFramingExecutor(a.id);
                  }
                  setPrefsMenuOpen(false);
                }}
              >
                {a.name}
              </Menu.Item>
            )) ?? (
              <span className="hint" data-testid="framing-no-executors-hint">
                No ACP agents installed.
              </span>
            )}
          </Menu.Dropdown>
        </Menu>
        <Menu
          opened={modelMenuOpen}
          onChange={(open) => {
            setModelMenuOpen(open);
            if (open) onProbeModels();
          }}
          position="bottom"
          withinPortal
        >
          <Menu.Target>
            <button
              className="ds-icon-btn"
              data-testid="framing-model-btn"
              disabled={!framingExecutorId}
              style={{ fontSize: 12, padding: "4px 8px" }}
            >
              {framingModelLabel}
            </button>
          </Menu.Target>
          <Menu.Dropdown
            className="ds-model-menu"
            data-testid="framing-model-menu"
          >
            <Menu.Label>Model</Menu.Label>
            <TextInput
              placeholder="Search models…"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.currentTarget.value)}
              size="xs"
              style={{ margin: "0 8px 8px" }}
              data-testid="framing-model-search"
            />
            <Box style={{ maxHeight: 210, overflowY: "auto" }}>
              {models === "loading" && (
                <span className="hint" data-testid="framing-models-loading">
                  Asking {framingExecutorLabel ?? "the agent"}…
                </span>
              )}
              {modelError && (
                <span className="hint" data-testid="framing-models-error">
                  {modelError}
                </span>
              )}
              {modelState && modelState.models.length === 0 && (
                <span className="hint" data-testid="framing-models-none">
                  {framingExecutorLabel ?? "This provider"} manages its own
                  model.
                </span>
              )}
              {filteredModels.map((m) => (
                <Menu.Item
                  key={m.id}
                  className={`ds-model-opt ${framingModelId === m.id ? "selected" : ""}`}
                  data-testid={`framing-model-opt-${m.id}`}
                  onClick={() => {
                    handleFramingModel(m.id);
                    setModelMenuOpen(false);
                  }}
                >
                  {m.name}
                </Menu.Item>
              ))}
              {filteredModels.length === 0 &&
                modelQuery &&
                !modelError &&
                models !== "loading" && (
                  <span
                    className="hint"
                    data-testid="framing-models-no-matches"
                  >
                    No models match.
                  </span>
                )}
            </Box>
          </Menu.Dropdown>
        </Menu>
      </div>
    );
    // D19/D20: pendingMode and specTypePicker take priority over the empty
    // mode picker — once the user has picked a mode, show the deferred state
    // (empty go composer or spec-type framing menu), not the picker again.
    // `transitioning` covers the async gap between clearing picker state and
    // the thread being selected — without it, showEmptyModePicker re-renders
    // the mode picker mid-transition (Vibe shell bug).
    if (
      (newThreadPicker || showEmptyModePicker) &&
      !pendingMode &&
      !specTypePicker &&
      !composerSpecTypePicker &&
      !transitioning
    ) {
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
                data-testid="pick-go"
                autoFocus
              >
                <strong>Go</strong>
                <span>
                  Start building — the agent can edit code right away.
                </span>
              </button>
              <button
                className="ds-mode-card"
                onClick={() => onPickMode("spec")}
                data-testid="pick-spec"
              >
                <strong>Spec</strong>
                <span>
                  Plan first — reach shared understanding with the agent before
                  it writes any code.
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

    // D1: spec-type framing menu — shown after picking "Spec" from the
    // Vibe/Spec picker. Three Mantine cards (Feature/Bugfix/Other) with a
    // Back button (D13). The agent does NOT run until a spec type is picked.
    if (specTypePicker) {
      return (
        <>
          <div className="pane-head">
            <strong>New thread</strong>
          </div>
          <div className="ds-new-thread-picker" data-testid="spec-type-picker">
            <p className="hint" style={{ marginBottom: 12 }}>
              What would you like to spec out today?
            </p>
            {framingPickerRow}
            {!providerSelected && (
              <p
                className="hint"
                style={{ marginBottom: 12, fontSize: 12, color: "var(--warn)" }}
              >
                Select a provider to continue.
              </p>
            )}
            {!showOtherInput && (
              <div className="ds-mode-picker">
                <UnstyledButton
                  className="ds-mode-card"
                  data-testid="spec-type-feature"
                  disabled={!providerSelected}
                  onClick={() =>
                    providerSelected && onPickSpecType?.("Feature")
                  }
                >
                  <strong>Feature</strong>
                  <span>
                    Build something new — a capability, screen, or integration
                    that doesn't exist yet.
                  </span>
                </UnstyledButton>
                <UnstyledButton
                  className="ds-mode-card"
                  data-testid="spec-type-bugfix"
                  disabled={!providerSelected}
                  onClick={() => providerSelected && onPickSpecType?.("Bugfix")}
                >
                  <strong>Bugfix</strong>
                  <span>
                    Diagnose and fix — trace a broken behavior to its root cause
                    before changing code.
                  </span>
                </UnstyledButton>
                <UnstyledButton
                  className="ds-mode-card"
                  data-testid="spec-type-other"
                  disabled={!providerSelected}
                  onClick={() => providerSelected && setShowOtherInput(true)}
                >
                  <strong>Other</strong>
                  <span>
                    Open-ended — describe your own framing and the agent will
                    explore from there.
                  </span>
                </UnstyledButton>
              </div>
            )}
            {showOtherInput && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <TextInput
                  value={otherSpecText}
                  onChange={(event) =>
                    setOtherSpecText(event.currentTarget.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      // D17: empty/whitespace submission is disabled.
                      const trimmed = otherSpecText.trim();
                      if (trimmed) {
                        onPickSpecType?.(trimmed);
                      }
                    }
                  }}
                  placeholder="Describe what you'd like to spec out..."
                  aria-label="Custom spec type"
                  data-testid="other-spec-input"
                  autoFocus
                />
                <button
                  className="ds-icon-btn"
                  data-testid="other-spec-escape"
                  onClick={() => {
                    setShowOtherInput(false);
                    setOtherSpecText("");
                  }}
                  style={{ fontSize: 12, alignSelf: "flex-start" }}
                >
                  ← or pick a different type
                </button>
              </div>
            )}
            <button
              className="ds-icon-btn"
              data-testid="spec-type-back"
              onClick={onSpecTypeBack}
              style={{ marginTop: 8, fontSize: 12 }}
            >
              ← Back
            </button>
          </div>
        </>
      );
    }

    // D9: composer-toggle spec-type framing menu — shown when toggling an
    // existing thread to spec mode with no open change and no stored spec_type.
    // The thread already exists; picking a spec type calls specMode directly.
    if (composerSpecTypePicker && thread) {
      return (
        <>
          <div className="pane-head">
            <strong data-testid="thread-title">{thread.title}</strong>
          </div>
          <div className="ds-new-thread-picker" data-testid="spec-type-picker">
            <p className="hint" style={{ marginBottom: 12 }}>
              What would you like to spec out today?
            </p>
            {framingPickerRow}
            {!providerSelected && (
              <p
                className="hint"
                style={{ marginBottom: 12, fontSize: 12, color: "var(--warn)" }}
              >
                Select a provider to continue.
              </p>
            )}
            {!showOtherInput && (
              <div className="ds-mode-picker">
                <UnstyledButton
                  className="ds-mode-card"
                  data-testid="spec-type-feature"
                  disabled={!providerSelected}
                  onClick={() =>
                    providerSelected && onPickComposerSpecType?.("Feature")
                  }
                >
                  <strong>Feature</strong>
                  <span>
                    Build something new — a capability, screen, or integration
                    that doesn't exist yet.
                  </span>
                </UnstyledButton>
                <UnstyledButton
                  className="ds-mode-card"
                  data-testid="spec-type-bugfix"
                  disabled={!providerSelected}
                  onClick={() =>
                    providerSelected && onPickComposerSpecType?.("Bugfix")
                  }
                >
                  <strong>Bugfix</strong>
                  <span>
                    Diagnose and fix — trace a broken behavior to its root cause
                    before changing code.
                  </span>
                </UnstyledButton>
                <UnstyledButton
                  className="ds-mode-card"
                  data-testid="spec-type-other"
                  disabled={!providerSelected}
                  onClick={() => providerSelected && setShowOtherInput(true)}
                >
                  <strong>Other</strong>
                  <span>
                    Open-ended — describe your own framing and the agent will
                    explore from there.
                  </span>
                </UnstyledButton>
              </div>
            )}
            {showOtherInput && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <TextInput
                  value={otherSpecText}
                  onChange={(event) =>
                    setOtherSpecText(event.currentTarget.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      const trimmed = otherSpecText.trim();
                      if (trimmed) {
                        onPickComposerSpecType?.(trimmed);
                      }
                    }
                  }}
                  placeholder="Describe what you'd like to spec out..."
                  aria-label="Custom spec type"
                  data-testid="other-spec-input"
                  autoFocus
                />
                <button
                  className="ds-icon-btn"
                  data-testid="other-spec-escape"
                  onClick={() => {
                    setShowOtherInput(false);
                    setOtherSpecText("");
                  }}
                  style={{ fontSize: 12, alignSelf: "flex-start" }}
                >
                  ← or pick a different type
                </button>
              </div>
            )}
            <button
              className="ds-icon-btn"
              data-testid="spec-type-back"
              onClick={onComposerSpecTypeBack}
              style={{ marginTop: 8, fontSize: 12 }}
            >
              ← Back
            </button>
          </div>
        </>
      );
    }

    // D20: pendingMode "go" is the deferred empty composer — no thread
    // exists yet, but the composer below must still render so the user can
    // type their first message (which creates the thread on send).
    // Entice the user to create a new thread only if threads are focused
    // and no mode is pending.
    if (!thread && pendingMode !== "go") {
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
          <strong data-testid="thread-title">
            {thread?.title ?? "New thread"}
          </strong>
          {thread && (
            <button
              onClick={() => onRenameThread(thread)}
              data-testid="rename-thread"
            >
              Rename
            </button>
          )}
          {thread?.openSpecChangeName && (
            <Badge
              size="sm"
              variant="default"
              tt="none"
              data-testid="change-chip"
              onClick={() => onOpenSpec?.(thread.openSpecChangeName!)}
              style={onOpenSpec ? { cursor: "pointer" } : undefined}
            >
              {thread.openSpecChangeName}
            </Badge>
          )}
          <div className="spacer" />
        </div>
        <div
          className="messages"
          data-testid="messages"
          ref={messagesRef}
          onScroll={handleScroll}
          data-autoscroll={autoScroll}
        >
          <>
            {items.length === 0 && <p className="empty">No messages yet.</p>}
            <EventList
              items={items}
              showThinking={showThinking}
              executor={executor}
            />
          </>
          {busy && (
            <div className="working" data-testid="working">
              executor working
              <Loader type="dots" size={16} color="var(--muted)" />
            </div>
          )}
        </div>
        {stage === "ready_to_apply" && !busy && flightSelected && (
          <div style={{ display: "flex", gap: 8, padding: "0 8px 4px" }}>
            <Button
              data-testid="apply-skill"
              size="xs"
              variant="filled"
              onClick={onApply}
            >
              Apply
            </Button>
          </div>
        )}
        <form
          className={`composer ${dragActive ? "drag-active" : ""}`}
          onSubmit={(event) => {
            event.preventDefault();
            handleSend();
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
              justifyContent: "space-between",
              gap: 6,
              width: "100%",
              minHeight: 32,
            }}
          >
            <Menu opened={prefsMenuOpen} onChange={setPrefsMenuOpen}>
              <Menu.Target>
                <button
                  className="ds-icon-btn"
                  data-testid="executor-btn"
                  data-tauri-drag-region-exclude
                  style={{ fontSize: 12, padding: "4px 8px" }}
                >
                  {executorLabel ?? "none detected"}
                  {threadBypass ? " · bypass" : ""}
                </button>
              </Menu.Target>
              <Menu.Dropdown
                className="ds-model-menu"
                data-testid="executor-menu"
              >
                <Menu.Label>Provider</Menu.Label>
                {flight?.agents.map((a) => (
                  <Menu.Item
                    key={a.id}
                    className={`ds-model-opt ${executor === a.id ? "selected" : ""}`}
                    data-testid={`executor-opt-${a.id}`}
                    onClick={() => {
                      if (a.id !== executor) {
                        onPickExecutor(a.id);
                      }
                      setPrefsMenuOpen(false);
                    }}
                  >
                    {a.name}
                  </Menu.Item>
                )) ?? (
                  <span className="hint" data-testid="no-executors-hint">
                    No ACP agents installed.
                  </span>
                )}
                {hasLiveSession && (
                  <span className="hint" data-testid="next-session-hint">
                    Next session will use {executorLabel ?? "auto-detected"}
                    {threadBypass ? " · bypass on" : ""}. Switching hands the
                    conversation off as text context.
                  </span>
                )}
                <Switch
                  className="ds-bypass-row"
                  label="Bypass permissions"
                  description="Skip approval prompts"
                  labelPosition="left"
                  color="var(--warn)"
                  checked={threadBypass}
                  onChange={onToggleBypass}
                  data-testid="bypass-toggle"
                />
              </Menu.Dropdown>
            </Menu>
            <Menu
              opened={modelMenuOpen}
              onChange={(open) => {
                setModelMenuOpen(open);
                if (open) onProbeModels();
              }}
              position="top"
              withinPortal
            >
              <Menu.Target>
                <button
                  className="ds-icon-btn"
                  data-testid="model-btn"
                  data-tauri-drag-region-exclude
                  disabled={!executor}
                  style={{ fontSize: 12, padding: "4px 8px" }}
                >
                  {modelLabel}
                </button>
              </Menu.Target>
              <Menu.Dropdown className="ds-model-menu" data-testid="model-menu">
                <Menu.Label>Model</Menu.Label>
                <TextInput
                  placeholder="Search models…"
                  value={modelQuery}
                  onChange={(event) => setModelQuery(event.currentTarget.value)}
                  size="xs"
                  style={{ margin: "0 8px 8px" }}
                  data-testid="model-search"
                />
                <Box style={{ maxHeight: 210, overflowY: "auto" }}>
                  {models === "loading" && (
                    <span className="hint" data-testid="models-loading">
                      Asking {executorLabel ?? "the agent"}…
                    </span>
                  )}
                  {modelError && (
                    <span className="hint" data-testid="models-error">
                      {modelError}
                    </span>
                  )}
                  {modelState && modelState.models.length === 0 && (
                    <span className="hint" data-testid="models-none">
                      {executorLabel ?? "This provider"} manages its own model.
                    </span>
                  )}
                  {filteredModels.map((m) => (
                    <Menu.Item
                      key={m.id}
                      className={`ds-model-opt ${currentModelId === m.id ? "selected" : ""}`}
                      data-testid={`model-opt-${m.id}`}
                      onClick={() => {
                        onPickModel(m.id);
                        setModelMenuOpen(false);
                      }}
                    >
                      {m.name}
                    </Menu.Item>
                  ))}
                  {filteredModels.length === 0 &&
                    modelQuery &&
                    !modelError &&
                    models !== "loading" && (
                      <span className="hint" data-testid="models-no-matches">
                        No models match.
                      </span>
                    )}
                </Box>
              </Menu.Dropdown>
            </Menu>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <SegmentedControl
                data-testid="mode-selector"
                value={thread?.currentMode ?? "go"}
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

              {busy ? (
                <ActionIcon
                  data-testid="composer-stop"
                  onClick={onStop}
                  aria-label="Stop"
                  title="Stop"
                  size={30}
                  radius="md"
                  variant="filled"
                  styles={{
                    root: {
                      flexShrink: 0,
                      backgroundColor: "var(--danger, #e5484d)",
                      color: "var(--danger-on, #fff)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      transition: "transform 100ms ease, opacity 100ms ease",
                      "&:hover": {
                        opacity: 0.9,
                      },
                      "&:active": {
                        transform: "scale(0.94)",
                      },
                    },
                  }}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </ActionIcon>
              ) : (
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
              )}
            </div>
          </div>
        </form>
      </>
    );
  },
  (prev, next) => {
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    return (
      prevKeys.length === nextKeys.length &&
      prevKeys.every(
        (k) =>
          (prev as Record<string, unknown>)[k] ===
          (next as Record<string, unknown>)[k]
      )
    );
  }
);

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
const DEFAULT_BYPASS_KEY = "floo:default-bypass";
const threadPrefsKey = (hash: string, threadId: string) =>
  `floo:thread-prefs:${hash}:${threadId}`;

type ThreadPrefs = { bypass: boolean };

const getThreadPrefs = (hash: string, threadId: string): ThreadPrefs | null => {
  const raw = localStorage.getItem(threadPrefsKey(hash, threadId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ThreadPrefs>;
    if (typeof parsed.bypass === "boolean") {
      return { bypass: parsed.bypass };
    }
  } catch {
    // fall through to default
  }
  return null;
};

const setThreadPrefs = (hash: string, threadId: string, prefs: ThreadPrefs) => {
  localStorage.setItem(threadPrefsKey(hash, threadId), JSON.stringify(prefs));
};

const getDefaultBypass = () => localStorage.getItem(DEFAULT_BYPASS_KEY) === "1";
const setDefaultBypass = (bypass: boolean) =>
  localStorage.setItem(DEFAULT_BYPASS_KEY, bypass ? "1" : "0");

const resolvePrefs = (hash: string, threadId: string): ThreadPrefs =>
  getThreadPrefs(hash, threadId) ?? {
    bypass: getDefaultBypass(),
  };
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
type ThreadRowProps = {
  thread: ThreadMeta;
  active: boolean;
  onSelect: (thread: ThreadMeta) => void;
  onRename: (thread: ThreadMeta) => void;
  onDelete: (thread: ThreadMeta) => void;
};

const ThreadRow = memo(function ThreadRow({
  thread,
  active,
  onSelect,
  onRename,
  onDelete,
}: ThreadRowProps) {
  const handleSelect = useCallback(() => onSelect(thread), [onSelect, thread]);
  return (
    <li
      className={active ? "active" : ""}
      role="button"
      tabIndex={0}
      onClick={handleSelect}
      onKeyDown={onActivateKey(handleSelect)}
    >
      <div className="ds-thread-row">
        <span className="ds-thread-title">{thread.title}</span>
        <div className="ds-thread-actions">
          <button
            className="ds-thread-action"
            onClick={(event) => {
              event.stopPropagation();
              onRename(thread);
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
              onDelete(thread);
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
          variant={thread.currentMode === "spec" ? "light" : "default"}
        >
          {thread.currentMode}
        </Badge>
      </span>
    </li>
  );
});

type ThreadListProps = {
  variant: "editor" | "vibe";
  threads: ThreadMeta[];
  activeThread: ThreadMeta | null;
  project: Project | null;
  onNewThread: () => void;
  onSelect: (thread: ThreadMeta) => void;
  onRename: (thread: ThreadMeta) => void;
  onDelete: (thread: ThreadMeta) => void;
};

const ThreadList = memo(function ThreadList({
  variant,
  threads,
  activeThread,
  project,
  onNewThread,
  onSelect,
  onRename,
  onDelete,
}: ThreadListProps) {
  void variant;
  return (
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
          <ThreadRow
            key={t.id}
            thread={t}
            active={t.id === activeThread?.id}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </ul>
    </div>
  );
});

type WorkspacePickerProps = {
  variant: "editor" | "vibe";
  project: Project | null;
  projects: Project[];
  branches: api.BranchInfo[];
  onSelectProject: (project: Project) => void;
  onAddProject: () => void;
  onRenameProject: () => void;
  onOpenBranchPicker: () => void;
};

const WorkspacePicker = memo(function WorkspacePicker({
  variant,
  project,
  projects,
  branches,
  onSelectProject,
  onAddProject,
  onRenameProject,
  onOpenBranchPicker,
}: WorkspacePickerProps) {
  void variant;
  return (
    <div className="ds-workspace-panel">
      <div className="ds-rail-section">
        <div className="ds-rail-label">Workspace</div>
        <select
          data-testid="project-picker"
          value={project?.hash ?? ""}
          onChange={(event) => {
            const next = projects.find((p) => p.hash === event.target.value);
            if (next) onSelectProject(next);
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
          <button onClick={onAddProject} data-testid="add-project">
            Add
          </button>
          {project && (
            <button onClick={onRenameProject} data-testid="rename-project">
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
            <IconGitBranch size={14} />{" "}
            {branches.find((b) => b.isCurrent)?.name ?? "…"}
          </button>
        )}
      </div>
    </div>
  );
});

// The executor (Claude Code / Codex) has its own file-read tooling, so we
// hand it a path rather than threading image bytes through the IPC channel.
export const imagePathsFrom = (paths: string[]): string[] =>
  paths.filter((p) => IMAGE_PATH.test(p));

export default function App() {
  const pm = useProjectManager();
  const project = pm.project;
  const setProject = pm.setProject;
  const projects = pm.projects;
  const setProjects = pm.setProjects;
  const thread = pm.thread;
  const setThread = pm.setThread;
  const threads = pm.threads;
  const setThreads = pm.setThreads;
  const branches = pm.branches;
  const setBranches = pm.setBranches;
  const changeComplete = pm.changeComplete;
  const setChangeComplete = pm.setChangeComplete;
  const specLinkChoice = pm.specLinkChoice;
  const setSpecLinkChoice = pm.setSpecLinkChoice;
  const ex = useExecutor();
  const messages = ex.messages;
  const setMessages = ex.setMessages;
  const draft = ex.draft;
  const setDraft = ex.setDraft;
  const errors = ex.errors;
  const setErrors = ex.setErrors;
  const flight = ex.flight;
  const setFlight = ex.setFlight;
  const liveBySession = ex.liveBySession;
  const setLiveBySession = ex.setLiveBySession;
  const busyThreads = ex.busyThreads;
  const setBusyFor = ex.setBusyFor;
  const modelsRef = ex.modelsRef;
  const modelsByAgent = ex.modelsByAgent;
  const setModelsByAgent = ex.setModelsByAgent;
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
  // D19/D20: deferred thread creation — picking a mode from the Vibe/Spec
  // picker no longer creates a thread immediately. For "go", an empty composer
  // appears; the thread is created on first send. For "spec", the framing menu
  // appears (Group 7); the thread is created on spec-type commit (Group 8).
  const [pendingMode, setPendingMode] = useState<api.Mode | null>(null);
  // D21: executor/model selected in the framing menu — stored before the
  // thread exists, then persisted on the thread when it's created.
  const [framingExecutor, setFramingExecutor] = useState<string | null>(null);
  const [framingModel, setFramingModel] = useState<string | null>(null);
  // D1: spec-type framing menu — shown after picking "Spec" from the Vibe/Spec
  // picker. The user picks Feature/Bugfix/Other before the agent runs (D2/D3).
  const [specTypePicker, setSpecTypePicker] = useState(false);
  // D9: composer-toggle spec-type framing menu — shown when toggling an
  // existing thread to spec mode with no open change and no stored spec_type.
  // Separate from `specTypePicker` because the thread already exists — the
  // spec-type handler calls specMode(thread.id, specType) directly.
  const [composerSpecTypePicker, setComposerSpecTypePicker] = useState(false);
  // D19/D20: transitioning — true during the async gap between clearing
  // picker state and the thread being selected. Prevents the Vibe shell's
  // showEmptyModePicker from re-rendering the mode picker mid-transition.
  const [transitioning, setTransitioning] = useState(false);
  const [selectQuery, setSelectQuery] = useState("");
  useEffect(() => {
    if (!bar) setSelectQuery("");
  }, [bar]);
  // Executor/live state lives in useExecutor and is aliased here.
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
  const persistSession = useCallback((hash: string) => {
    const s = sessionRef.current;
    if (hash && s) saveSession(hash, s);
  }, []);
  const saveSessionDebounced = useDebouncedCallback(persistSession, 500);
  // A search result to scroll to once its file is open.
  const [revealLine, setRevealLine] = useState<{
    path: string;
    line: number;
    at: number;
  } | null>(null);
  // Mirrors the open paths for the fs-changed listener, which is registered
  // once — same reason `current` exists for project/thread.
  const openPathsRef = useRef<string[]>([]);
  openPathsRef.current = tabs.tabs.map((tab) => tabKey(tab));
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
  const shell = useAppShell(project?.hash);
  // Thread-level model/bypass preferences. The composer control reads and
  // writes these; the effective values are resolved before each session-starting
  // call so a live session keeps its original flags (design.md Decision 2).
  const [threadPrefs, setThreadPrefsState] = useState<ThreadPrefs>(() => ({
    bypass: getDefaultBypass(),
  }));
  const [prefsMenuOpen, setPrefsMenuOpen] = useState(false);
  const [hasLiveSession, setHasLiveSession] = useState(false);
  const onToggleBypass = () => {
    if (!project || !thread) return;
    const prefs = { bypass: !threadPrefs.bypass };
    setThreadPrefs(project.hash, thread.id, prefs);
    setThreadPrefsState(prefs);
  };
  const onToggleBypassDefault = () => {
    if (!project || !thread) return;
    if (!getThreadPrefs(project.hash, thread.id)) {
      setDefaultBypass(!threadPrefs.bypass);
    }
    onToggleBypass();
  };
  // Check whether a live session exists for this thread when the prefs menu
  // opens, so the "Next session will use X" hint can show. A live session
  // keeps its original flags; only the next new session picks up the change.
  const openPrefsMenu = (open: boolean) => {
    setPrefsMenuOpen(open);
    if (open && project && thread) {
      api
        .executorStatus()
        .then((statuses) => {
          setHasLiveSession(statuses.some((s) => s.threadId === thread.id));
        })
        .catch(() => setHasLiveSession(false));
    }
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
  if (shell.terminalPlacement === "bottom" && !shell.terminalPanel.collapsed) {
    terminalEverOpened.current = true;
  }
  const [paletteFiles, setPaletteFiles] = useState<string[]>([]);
  const filesCache = useRef<Map<string, string[]>>(new Map());
  const { refreshToken: fileTreeRefreshToken, invalidate: invalidateFileTree } =
    useFileTreeCache();
  // Verify pins from `.project-settings.json` (D8): spec change name → list
  // of pinned verify command names. Machine-local UI state, loaded on project
  // switch and after a pin is added/removed.
  const [verifyPins, setVerifyPins] = useState<Record<string, string[]>>({});

  const reloadVerifyPins = useCallback(async (hash: string) => {
    try {
      const raw = JSON.parse(
        await api.readFileContent(hash, PROJECT_SETTINGS_FILE)
      );
      setVerifyPins(raw.verifyPins ?? {});
    } catch {
      setVerifyPins({});
    }
  }, []);

  useEffect(() => {
    if (project) reloadVerifyPins(project.hash);
  }, [project?.hash, reloadVerifyPins]);

  const addVerifyPin = useCallback(
    async (specName: string, commandName: string) => {
      if (!project) return;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(
          await api.readFileContent(project.hash, PROJECT_SETTINGS_FILE)
        );
      } catch {
        // File missing or malformed — start fresh.
      }
      const pins = (parsed.verifyPins ?? {}) as Record<string, string[]>;
      const current = pins[specName] ?? [];
      if (!current.includes(commandName)) {
        pins[specName] = [...current, commandName];
      }
      parsed.verifyPins = pins;
      await api.writeFileContent(
        project.hash,
        PROJECT_SETTINGS_FILE,
        JSON.stringify(parsed, null, 2) + "\n"
      );
      setVerifyPins(pins);
    },
    [project]
  );

  const removeVerifyPin = useCallback(
    async (specName: string, commandName: string) => {
      if (!project) return;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(
          await api.readFileContent(project.hash, PROJECT_SETTINGS_FILE)
        );
      } catch {
        return;
      }
      const pins = (parsed.verifyPins ?? {}) as Record<string, string[]>;
      const current = pins[specName] ?? [];
      pins[specName] = current.filter((c) => c !== commandName);
      if (pins[specName].length === 0) delete pins[specName];
      parsed.verifyPins = pins;
      await api.writeFileContent(
        project.hash,
        PROJECT_SETTINGS_FILE,
        JSON.stringify(parsed, null, 2) + "\n"
      );
      setVerifyPins(pins);
    },
    [project]
  );
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
    if (shell.theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = shell.theme;
  }, [shell.theme]);

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
      // Load this thread's model/bypass preferences (per-thread override or
      // global default) so the composer control shows the right values.
      setThreadPrefsState(resolvePrefs(projectHash, next.id));
      setPrefsMenuOpen(false);
    },
    []
  );

  const onSelectEditorThread = useCallback(
    (t: ThreadMeta) => {
      if (project) selectThread(project.hash, t);
      shell.setEditorRailOpen(false);
    },
    [project, selectThread]
  );

  const onSelectVibeThread = useCallback(
    (t: ThreadMeta) => {
      if (project) selectThread(project.hash, t);
    },
    [project, selectThread]
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
        if (!shell.shellChosenRef.current)
          shell.setCenterShell(saved.centerShell);
        shell.setDiffOpen(saved.diffOpen);

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
        // routine here. Spec tabs (keyed `spec:<name>`) are reopened without
        // a filesystem check — they're read from `openspec/changes/` on
        // render, and a missing change directory just renders an error
        // inside the tab rather than blocking restore.
        const alive = await Promise.all(
          saved.openPaths.map(async (path) => {
            if (path.startsWith("spec:")) return path;
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
        for (const path of alive) {
          if (!path) continue;
          if (path.startsWith("spec:")) {
            tabsRef.current.openSpec(path.slice("spec:".length));
          } else {
            tabsRef.current.open(path);
          }
        }
        if (saved.activePath && alive.includes(saved.activePath)) {
          if (saved.activePath.startsWith("spec:")) {
            tabsRef.current.openSpec(saved.activePath.slice("spec:".length));
          } else {
            tabsRef.current.open(saved.activePath);
          }
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
            ? `Discard unsaved changes to "${tabKey(dirty[0])}"?`
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
      shell.setDiffOpen(false);
      tabs.open(path);
      // Consumed once by the editor pane; the timestamp makes a repeat jump
      // to the same line a new instruction rather than a no-op.
      if (line !== undefined) setRevealLine({ path, line, at: Date.now() });
    },
    [tabs]
  );

  const closeTab = useCallback(
    (path: string) => {
      const tab = tabs.tabs.find((t) => tabKey(t) === path);
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
    shell.setDiffOpen(false);
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
    shell.setEditorRailOpen(false);
  };

  // Vibe/Spec is a friendlier front door onto the two modes that already
  // exist — Vibe seeds go (chat first, build immediately), Spec seeds spec
  // (today's read-only grill/plan flow). No third mode.
  const onPickMode = async (mode: api.Mode) => {
    if (!project) return;
    setNewThreadPicker(false);
    // D20: defer thread creation for BOTH modes until the first meaningful
    // interaction. Go shows an empty composer; the thread is created on
    // first send (onSend). Spec shows the framing menu; the thread is
    // created on spec-type commit (onPickSpecType).
    if (mode === "go") {
      setPendingMode("go");
      return;
    }
    // spec: show the framing menu (Feature/Bugfix/Other) — no thread yet.
    setSpecTypePicker(true);
  };

  // D13: Back button on the framing menu returns to the Vibe/Spec picker.
  const onSpecTypeBack = () => {
    setSpecTypePicker(false);
    setNewThreadPicker(true);
  };

  // D5/D19: spec-type selection creates the thread + fires grill-explore with
  // the spec type as the user turn body. "Other" is handled separately (D6,
  // Group 9) — this handler covers Feature and Bugfix.
  const onPickSpecType = async (specType: string) => {
    if (!project) return;
    // Optimistic: create the thread, swap to chat immediately, then fire
    // specMode in the background. The agent's response streams in via events.
    setSpecTypePicker(false);
    setTransitioning(true);
    setBusy(true);
    // Capture the framing-menu executor/model before clearing them. The
    // executor button displays flight.selected as a fallback even when the
    // user never explicitly opened it (D21) — if they picked a model without
    // touching the executor dropdown, fall back the same way here, or the
    // model pick is silently dropped along with the executor (never persisted).
    // The executor button displays flight.selected as a fallback even when
    // the user never explicitly opened it (D21) — if they picked a model
    // without touching the executor dropdown, fall back the same way here,
    // or the model pick is silently dropped along with the executor (never
    // persisted, since setThreadExecutor is skipped when pickedExecutor is null).
    const pickedExecutor =
      framingExecutor ?? (framingModel ? flight?.selected : null) ?? null;
    const pickedModel = framingModel;
    try {
      const created = await api.createThread(project.hash, "New thread");
      // Persist the framing-menu executor/model on the thread before
      // specMode fires — ensure_session reads the thread's stored executor
      // to decide which agent to start. Without this, it falls back to
      // auto-detection and ignores the user's framing-menu choice.
      if (pickedExecutor) {
        await api.setThreadExecutor(
          project.hash,
          created.id,
          pickedExecutor,
          pickedModel ?? null
        );
      }
      // Re-read the thread metadata so the executor/model is reflected.
      const threads = await api.listThreads(project.hash);
      const updated = threads.find((t) => t.id === created.id) ?? created;
      await selectThread(project.hash, updated);
      setThreads(threads);
      // Fire specMode without awaiting — don't block the UI. The busy state
      // stays true until the agent's turn ends (ExecutorEvent::Done clears it).
      api
        .specMode(project.hash, updated.id, specType, false)
        .then((meta) => {
          setThreads((prev) => prev.map((t) => (t.id === meta.id ? meta : t)));
          setThread(meta);
        })
        .catch((err) => {
          setBusy(false);
          fail(err);
        });
    } catch (err) {
      setBusy(false);
      fail(err);
    } finally {
      setTransitioning(false);
      setFramingExecutor(null);
      setFramingModel(null);
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

  // The session id for the live session on this thread, if any. Used by the
  // stop button to cancel the in-flight turn.
  const liveSessionId = useMemo(() => {
    for (const [id, entry] of liveBySession) {
      if (entry.threadId === thread?.id) return id;
    }
    return null;
  }, [liveBySession, thread?.id]);

  const onStop = useCallback(() => {
    // Stop the live session for this thread, or all sessions if we can't
    // identify the specific one (e.g. events haven't started streaming yet).
    void api.stopExecutor(liveSessionId ?? undefined);
  }, [liveSessionId]);

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
    const updated = found.find((t) => t.id === thread.id) ?? thread;
    setThreads(found);
    setThread(updated);
    setMessages(history);
    clearLiveFor(thread.id);
    // Fetch change status when the thread has an open spec change.
    if (updated.openSpecChangeName) {
      api
        .changeStatus(project.hash, updated.openSpecChangeName)
        .then(setChangeComplete, () => setChangeComplete(null));
    } else {
      setChangeComplete(null);
    }
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
      for (const path of payload.paths) {
        invalidateFileTree(path);
      }

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

  // Persist the editor's shape as it changes. Debounced to avoid repeated
  // localStorage writes while switching tabs or toggling panels.
  useEffect(() => {
    const hash = project?.hash;
    if (!hash || !sessionRef.current) return;
    const next: EditorSession = {
      ...sessionRef.current,
      openPaths: tabs.tabs.map((tab) => tabKey(tab)),
      activePath: tabs.activePath,
      centerShell: shell.centerShell,
      diffOpen: shell.diffOpen,
    };
    sessionRef.current = next;
    saveSessionDebounced(hash);
  }, [
    project?.hash,
    tabs.tabs,
    tabs.activePath,
    shell.centerShell,
    shell.diffOpen,
  ]);

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
      if (hash) saveSessionDebounced.flush();
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  useEffect(() => {
    const hash = currentProjectRef.current;
    if (hash) saveSessionDebounced(hash);
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
      const prefs = resolvePrefs(project.hash, thread.id);
      const meta = await api.goMode(project.hash, thread.id, prefs.bypass);
      await refresh();
      // A linked change means /grill-apply was just sent; otherwise we're idle.
      if (!meta.openSpecChangeName) setBusy(false);
    } catch (err) {
      setBusy(false);
      fail(err);
    }
  };

  // Probed model selectors, keyed by agent id. The ref is the guard against
  // double-probing (state updaters can run twice); the state mirror is what
  // re-renders the model menu.

  const probeAgentModels = useCallback(async (agentId: string) => {
    const { project } = current.current;
    if (!project) return;
    const existing = modelsRef.current[agentId];
    // Cached success or in-flight probe: don't re-probe. Errors retry —
    // the agent may just have been authed.
    if (existing === "loading" || (existing && "error" in existing === false))
      return;
    modelsRef.current = { ...modelsRef.current, [agentId]: "loading" };
    setModelsByAgent(modelsRef.current);
    try {
      const state = await api.listModels(project.hash, agentId);
      modelsRef.current = { ...modelsRef.current, [agentId]: state };
    } catch (err) {
      modelsRef.current = {
        ...modelsRef.current,
        [agentId]: { error: describeError(err) },
      };
    }
    setModelsByAgent(modelsRef.current);
  }, []);

  // D21: framing-menu executor/model callbacks — store locally before the
  // thread exists; persisted on the thread when it's created in onPickSpecType.
  const onPickFramingExecutor = useCallback(
    (agentId: string) => {
      setFramingExecutor(agentId);
      setFramingModel(null);
      probeAgentModels(agentId);
    },
    [probeAgentModels]
  );
  const onPickFramingModel = useCallback((modelId: string) => {
    setFramingModel(modelId);
  }, []);

  // Spec-mode stage derivation (amended D19): explore → propose → apply.
  const stage = thread
    ? deriveStage(
        thread.currentMode,
        !!thread.openSpecChangeName,
        changeComplete
      )
    : "chat";

  const onPickExecutor = useCallback(
    async (agentId: string) => {
      const { project, thread } = current.current;
      if (!project || !thread) return;
      try {
        // Picking a provider clears the model — the old model id means
        // nothing to the new agent.
        await api.setThreadExecutor(project.hash, thread.id, agentId, null);
        await refresh();
      } catch (err) {
        fail(err);
      }
      probeAgentModels(agentId);
    },
    [refresh, probeAgentModels]
  );

  const onPickModel = useCallback(
    async (modelId: string) => {
      const { project, thread } = current.current;
      if (!project || !thread) return;
      // Pin the provider alongside the model, so the pair can't drift apart
      // if auto-detection later resolves differently.
      const executorId = thread.executor ?? flight?.selected ?? null;
      if (!executorId) return;
      try {
        await api.setThreadExecutor(
          project.hash,
          thread.id,
          executorId,
          modelId
        );
        await refresh();
      } catch (err) {
        fail(err);
      }
    },
    [refresh, flight]
  );

  const onSpec = async () => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    // D9: show the framing menu when entering spec mode with no open change
    // and no stored spec_type. Reuse the stored spec_type if one exists (D11).
    // Skip the menu entirely if a change is already open.
    if (!thread.openSpecChangeName && !thread.specType) {
      setComposerSpecTypePicker(true);
      return;
    }
    setBusy(true);
    const prefs = resolvePrefs(project.hash, thread.id);
    // Reuse the stored spec_type if available; otherwise the change is
    // already open so spec_type is silently dropped (D10).
    const specType = thread.specType ?? "grill-explore";
    // Fire specMode without awaiting — busy stays true until the agent's
    // turn ends (ExecutorEvent::Done clears it). If there's an open change,
    // spec_mode just sets the mode (no session started) so clear busy.
    api
      .specMode(project.hash, thread.id, specType, prefs.bypass)
      .then((meta) => {
        if (meta.openSpecChangeName) setBusy(false);
        refresh();
      })
      .catch((err) => {
        setBusy(false);
        fail(err);
      });
  };

  // D9: spec-type selection from the composer-toggle framing menu — the
  // thread already exists, so this calls specMode directly (no createThread).
  const onPickComposerSpecType = async (specType: string) => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    setComposerSpecTypePicker(false);
    setBusy(true);
    const prefs = resolvePrefs(project.hash, thread.id);
    // Fire specMode without awaiting — busy stays true until the agent's
    // turn ends (ExecutorEvent::Done clears it).
    api
      .specMode(project.hash, thread.id, specType, prefs.bypass)
      .then(() => refresh())
      .catch((err) => {
        setBusy(false);
        fail(err);
      });
  };

  // D13: Back button on the composer-toggle framing menu returns to the chat.
  const onComposerSpecTypeBack = () => {
    setComposerSpecTypePicker(false);
  };

  const onPropose = async () => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    try {
      setBusy(true);
      const prefs = resolvePrefs(project.hash, thread.id);
      await api.propose(project.hash, thread.id, prefs.bypass);
      await refresh();
    } catch (err) {
      setBusy(false);
      fail(err);
    }
  };

  const onApply = async () => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    try {
      setBusy(true);
      const prefs = resolvePrefs(project.hash, thread.id);
      await api.applySkill(project.hash, thread.id, prefs.bypass);
      await refresh();
    } catch (err) {
      setBusy(false);
      fail(err);
    }
  };

  const onSend = async () => {
    if (!project || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    // /go and /propose are the same functions the buttons call.
    if (text === "/go") return onGo();
    if (text === "/spec") return onSpec();
    if (text === "/propose") return onPropose();
    // D20: go-mode's empty composer has no thread yet — create it (+ set
    // go mode) on this, the first send, then fall through to the normal
    // send path below using the freshly created thread.
    let activeThread = thread;
    if (!activeThread) {
      if (pendingMode !== "go") return;
      try {
        const created = await api.createThread(project.hash, "New thread");
        activeThread = await api.setThreadMode(project.hash, created.id, "go");
        setThreads(await api.listThreads(project.hash));
        await selectThread(project.hash, activeThread);
        setPendingMode(null);
      } catch (err) {
        fail(err);
        return;
      }
    }
    try {
      setBusy(true);
      const prefs = resolvePrefs(project.hash, activeThread.id);
      // sendMessage returns the persisted user message; append it directly
      // instead of re-reading the whole thread. A second readThread here would
      // race with the done/thread-updated handlers' refresh() on fast turns —
      // a stale snapshot could clobber the fresh one. The done handler is the
      // single writer of the full history; onSend only adds this one row.
      const sent = await api.sendMessage(
        project.hash,
        activeThread.id,
        text,
        activeThread.currentMode,
        prefs.bypass
      );
      setMessages((prev) =>
        // A fast turn may have already refreshed history (which includes this
        // message); don't duplicate it.
        prev.some((m) => m.seq === sent.seq) ? prev : [...prev, sent]
      );
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
      invalidateFileTree(path);
    },
    [project, refreshPaletteFiles, invalidateFileTree]
  );

  const onRenameFile = useCallback(
    async (from: string, to: string) => {
      if (!project) return;
      await api.renamePath(project.hash, from, to);
      await refreshPaletteFiles();
      invalidateFileTree(from);
      tabs.rename(from, to);
    },
    [project, refreshPaletteFiles, invalidateFileTree]
  );

  const onDeleteFile = useCallback(
    async (path: string) => {
      if (!project) return;
      await api.deletePath(project.hash, path);
      await refreshPaletteFiles();
      invalidateFileTree(path);
      tabs.dropPath(path);
    },
    [project, refreshPaletteFiles, invalidateFileTree]
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
        run: () => shell.setDiffOpen((open) => !open),
      },
      {
        id: "view.shell",
        group: "View",
        label: "Switch between Vibe and Editor",
        keywords: "shell layout agent",
        run: () =>
          shell.setCenterShell(
            shell.centerShell === "vibe" ? "editor" : "vibe"
          ),
      },
      {
        id: "view.rightPanel",
        group: "View",
        label: "Toggle right panel",
        chord: "Mod+J",
        run: () => shell.rightPanel.toggleCollapsed(),
      },
      {
        id: "view.leftRail",
        group: "View",
        label: "Toggle file tree",
        chord: "Mod+Backslash",
        keywords: "explorer sidebar",
        run: () => shell.leftRail.toggleCollapsed(),
      },
      {
        id: "view.terminal",
        group: "View",
        label: "Toggle terminal",
        chord: "Mod+Backtick",
        run: () => shell.toggleTerminal(),
      },
      {
        id: "app.settings",
        group: "App",
        label: "Open settings",
        keywords: "preferences font shell.theme wrap",
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
      shell.centerShell,
      // Recomputed as tabs come and go: "Close tab" is only offered when
      // there is one, and a stale memo would keep hiding it.
      tabs.activePath,
      openFilePalette,
      openTextSearch,
      shell.rightPanel.toggleCollapsed,
      shell.leftRail.toggleCollapsed,
      shell.toggleTerminal,
      shell.setCenterShell,
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
              className={shell.centerShell === "vibe" ? "active" : ""}
              onClick={() => shell.setCenterShell("vibe")}
              data-testid="shell-vibe"
            >
              Vibe
            </button>
            <button
              className={shell.centerShell === "editor" ? "active" : ""}
              onClick={() => shell.setCenterShell("editor")}
              data-testid="shell-editor"
            >
              Editor
            </button>
          </div>
          <Tooltip label="Toggle left sidebar (Cmd+\)">
            <button
              className="ds-icon-btn"
              onClick={() => shell.leftRail.toggleCollapsed()}
              aria-label="Toggle left sidebar"
              data-testid="toggle-left-sidebar"
              data-tauri-drag-region-exclude
            >
              <IconLayoutSidebarFilled size={14} />
            </button>
          </Tooltip>
          <div className="ds-chrome-utils">
            <Tooltip label="Theme: click to cycle auto → light → dark">
              <button
                className="ds-icon-btn"
                onClick={() => {
                  const next = shell.nextTheme(shell.theme);
                  shell.setTheme(next);
                }}
                data-testid="theme-toggle"
                data-tauri-drag-region-exclude
              >
                {shell.theme === "auto"
                  ? "Auto"
                  : shell.theme === "light"
                    ? "Light"
                    : "Dark"}
              </button>
            </Tooltip>
            <Tooltip label="Toggle right sidebar (Cmd+J)">
              <button
                className="ds-icon-btn"
                onClick={() => shell.rightPanel.toggleCollapsed()}
                aria-label="Toggle right sidebar"
                data-testid="toggle-right-sidebar"
                data-tauri-drag-region-exclude
              >
                <IconLayoutSidebarRightFilled size={14} />
              </button>
            </Tooltip>
            <Tooltip label="Toggle terminal (Cmd+`)">
              <button
                className="ds-icon-btn"
                onClick={shell.toggleTerminal}
                aria-label="Toggle terminal"
                data-testid="toggle-terminal"
                data-tauri-drag-region-exclude
              >
                <IconTerminal2 size={14} />
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
                <IconSettings size={14} />
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
          {shell.centerShell === "editor" ? (
            <div className="ds-shell-contents" data-testid="editor-shell">
              <nav
                className="ds-nav-rail"
                data-testid="nav-rail"
                style={
                  {
                    "--rail-w": `${shell.leftRail.size}px`,
                    marginLeft: shell.leftRail.collapsed
                      ? -shell.leftRail.size
                      : 0,
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

              {!shell.leftRail.collapsed && (
                <div
                  className="ds-resize-handle ds-resize-handle-x"
                  data-testid="resize-left-rail"
                  onPointerDown={bindDrag(
                    shell.leftRail.handleProps,
                    "col-resize"
                  )}
                />
              )}

              <main className="main" data-testid="main-pane">
                <TabBar
                  tabs={tabs.tabs}
                  activePath={selectedFile}
                  onSelect={(path) => {
                    shell.setDiffOpen(false);
                    tabs.open(path);
                  }}
                  onClose={closeTab}
                  diffOpen={shell.diffOpen}
                  onToggleDiff={() => shell.setDiffOpen((open) => !open)}
                  activeMdPreview={tabs.activeMdPreview}
                  onToggleMdPreview={toggleMdPreview}
                />
                {!shell.diffOpen ? (
                  tabs.activeTab?.type === "spec" ? (
                    project &&
                    tabs.activeTab.type === "spec" &&
                    (() => {
                      const specName = tabs.activeTab!.specName;
                      return (
                        <SpecChangeTab
                          projectHash={project.hash}
                          specName={specName}
                          verifyPins={verifyPins[specName]}
                          onAddPin={(cmd) => addVerifyPin(specName, cmd)}
                          onRemovePin={(cmd) => removeVerifyPin(specName, cmd)}
                        />
                      );
                    })()
                  ) : project ? (
                    <FileEditorPane
                      projectHash={project.hash}
                      path={selectedFile}
                      projectName={project.displayName}
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

                {shell.terminalPlacement === "bottom" &&
                  !shell.terminalPanel.collapsed && (
                    <div
                      className="ds-resize-handle ds-resize-handle-y"
                      data-testid="resize-terminal-panel"
                      onPointerDown={bindDrag(
                        shell.terminalPanel.handleProps,
                        "row-resize"
                      )}
                    />
                  )}
                {/* Hidden rather than unmounted while collapsed: unmounting
                    disposes the xterm instance, so every collapse threw away
                    the scrollback and re-spawned the shell on reopen. */}
                {shell.terminalPlacement === "bottom" &&
                  terminalEverOpened.current && (
                    <div
                      className="ds-terminal-panel"
                      data-testid="terminal-panel"
                      hidden={shell.terminalPanel.collapsed}
                      style={
                        {
                          "--terminal-h": `${shell.terminalPanel.size}px`,
                          display: shell.terminalPanel.collapsed
                            ? "none"
                            : undefined,
                        } as CSSProperties
                      }
                    >
                      {project && (
                        <TerminalPane
                          projectHash={project.hash}
                          placement={shell.terminalPlacement}
                          onTogglePlacement={shell.toggleTerminalPlacement}
                        />
                      )}
                    </div>
                  )}
              </main>

              {!shell.rightPanel.collapsed && (
                <div
                  className="ds-resize-handle ds-resize-handle-x"
                  data-testid="resize-right-panel"
                  onPointerDown={bindDrag(
                    shell.rightPanel.handleProps,
                    "col-resize"
                  )}
                />
              )}

              <aside
                className="ds-right-sidebar"
                data-testid="right-sidebar"
                style={
                  {
                    "--panel-w": `${shell.rightPanel.size}px`,
                    marginRight: shell.rightPanel.collapsed
                      ? -shell.rightPanel.size
                      : 0,
                  } as CSSProperties
                }
              >
                <WorkspacePicker
                  variant="editor"
                  project={project}
                  projects={projects}
                  branches={branches}
                  onSelectProject={selectProject}
                  onAddProject={onAddProject}
                  onRenameProject={onRenameProject}
                  onOpenBranchPicker={onOpenBranchPicker}
                />
                <div className="ds-right-panes">
                  {shell.rightTab === "terminal" &&
                  shell.terminalPlacement === "sidebar" ? (
                    project && (
                      <TerminalPane
                        projectHash={project.hash}
                        placement={shell.terminalPlacement}
                        onTogglePlacement={shell.toggleTerminalPlacement}
                      />
                    )
                  ) : (
                    <Accordion
                      value={shell.editorRailOpen ? "threads-map" : null}
                      onChange={(value) =>
                        shell.setEditorRailOpen(value !== null)
                      }
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
                            value={shell.rightTab}
                            onChange={(value) =>
                              value &&
                              shell.setRightTab(
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
                          {shell.rightTab === "threads" && (
                            <ThreadList
                              variant="editor"
                              threads={threads}
                              activeThread={thread}
                              project={project}
                              onNewThread={onNewThread}
                              onSelect={onSelectEditorThread}
                              onRename={onRenameThread}
                              onDelete={onDeleteThread}
                            />
                          )}
                          {shell.rightTab === "codemap" && project && (
                            <Suspense
                              fallback={
                                <div style={{ padding: 12 }}>Loading map…</div>
                              }
                            >
                              <GraphPane projectHash={project.hash} />
                            </Suspense>
                          )}
                          {shell.rightTab === "specs" && project && (
                            <SpecPane
                              projectHash={project.hash}
                              linkedChange={thread?.openSpecChangeName}
                            />
                          )}
                          {shell.rightTab === "verify" && project && (
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
                    shell.rightTab === "terminal" &&
                    shell.terminalPlacement === "sidebar"
                  ) && (
                    <ChatSurface
                      project={project}
                      thread={thread}
                      messages={messages}
                      live={live}
                      busy={busy}
                      showThinking={showThinking}
                      executor={
                        thread?.executor ??
                        framingExecutor ??
                        flight?.selected ??
                        null
                      }
                      models={
                        (thread?.executor ??
                        framingExecutor ??
                        flight?.selected)
                          ? (modelsByAgent[
                              (thread?.executor ??
                                framingExecutor ??
                                flight?.selected)!
                            ] ?? null)
                          : null
                      }
                      onPickExecutor={onPickExecutor}
                      onPickModel={onPickModel}
                      onProbeModels={() => {
                        const id =
                          thread?.executor ??
                          framingExecutor ??
                          flight?.selected;
                        if (id) probeAgentModels(id);
                      }}
                      flightSelected={!!flight?.selected}
                      flight={flight}
                      draft={draft}
                      setDraft={setDraft}
                      onSend={onSend}
                      onStop={onStop}
                      onRenameThread={onRenameThread}
                      onSpec={onSpec}
                      onGo={onGo}
                      onApply={onApply}
                      stage={stage}
                      dragActive={dragActive}
                      newThreadPicker={newThreadPicker}
                      pendingMode={pendingMode}
                      specTypePicker={specTypePicker}
                      onSpecTypeBack={onSpecTypeBack}
                      onPickSpecType={onPickSpecType}
                      composerSpecTypePicker={composerSpecTypePicker}
                      transitioning={transitioning}
                      framingExecutor={framingExecutor}
                      framingModel={framingModel}
                      onPickFramingExecutor={onPickFramingExecutor}
                      onPickFramingModel={onPickFramingModel}
                      onPickComposerSpecType={onPickComposerSpecType}
                      onComposerSpecTypeBack={onComposerSpecTypeBack}
                      onPickMode={onPickMode}
                      threadBypass={threadPrefs.bypass}
                      onToggleBypass={onToggleBypassDefault}
                      prefsMenuOpen={prefsMenuOpen}
                      setPrefsMenuOpen={openPrefsMenu}
                      hasLiveSession={hasLiveSession}
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
                    "--vibe-chat-w": `${shell.vibeChat.size}px`,
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
                  executor={
                    thread?.executor ??
                    framingExecutor ??
                    flight?.selected ??
                    null
                  }
                  models={
                    (thread?.executor ?? framingExecutor ?? flight?.selected)
                      ? (modelsByAgent[
                          (thread?.executor ??
                            framingExecutor ??
                            flight?.selected)!
                        ] ?? null)
                      : null
                  }
                  onPickExecutor={onPickExecutor}
                  onPickModel={onPickModel}
                  onProbeModels={() => {
                    const id =
                      thread?.executor ?? framingExecutor ?? flight?.selected;
                    if (id) probeAgentModels(id);
                  }}
                  flightSelected={!!flight?.selected}
                  flight={flight}
                  draft={draft}
                  setDraft={setDraft}
                  onSend={onSend}
                  onStop={onStop}
                  onRenameThread={onRenameThread}
                  onSpec={onSpec}
                  onGo={onGo}
                  onApply={onApply}
                  stage={stage}
                  dragActive={dragActive}
                  newThreadPicker={newThreadPicker}
                  pendingMode={pendingMode}
                  specTypePicker={specTypePicker}
                  onSpecTypeBack={onSpecTypeBack}
                  onPickSpecType={onPickSpecType}
                  composerSpecTypePicker={composerSpecTypePicker}
                  transitioning={transitioning}
                  framingExecutor={framingExecutor}
                  framingModel={framingModel}
                  onPickFramingExecutor={onPickFramingExecutor}
                  onPickFramingModel={onPickFramingModel}
                  onPickComposerSpecType={onPickComposerSpecType}
                  onComposerSpecTypeBack={onComposerSpecTypeBack}
                  showEmptyModePicker={threads.length === 0 && !thread}
                  onPickMode={onPickMode}
                  onOpenSpec={(name) => tabs.openSpec(name)}
                  threadBypass={threadPrefs.bypass}
                  onToggleBypass={onToggleBypassDefault}
                  prefsMenuOpen={prefsMenuOpen}
                  setPrefsMenuOpen={openPrefsMenu}
                  hasLiveSession={hasLiveSession}
                />
              </section>

              <div
                className="ds-resize-handle ds-resize-handle-x"
                data-testid="resize-vibe-chat"
                onPointerDown={bindDrag(
                  shell.vibeChat.handleProps,
                  "col-resize"
                )}
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
                      {tabs.activeTab?.type === "spec"
                        ? tabs.activeTab.specName
                        : basename(selectedFile)}
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
                        onClick={() => shell.setCenterShell("editor")}
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
                    label={shell.diffOpen ? "Back to editor" : "Review changes"}
                    withinPortal
                  >
                    <ActionIcon
                      variant={shell.diffOpen ? "filled" : "subtle"}
                      aria-label={
                        shell.diffOpen ? "Back to editor" : "Review changes"
                      }
                      aria-pressed={shell.diffOpen}
                      onClick={() => shell.setDiffOpen((open) => !open)}
                      data-testid="vibe-toggle-diff"
                      ml={isMarkdownPath(selectedFile) ? undefined : "auto"}
                    >
                      <IconGitCompare size={16} />
                    </ActionIcon>
                  </Tooltip>
                </div>
                {!shell.diffOpen && tabs.activeTab?.type === "spec" ? (
                  project &&
                  tabs.activeTab.type === "spec" &&
                  (() => {
                    const specName = tabs.activeTab!.specName;
                    return (
                      <SpecChangeTab
                        projectHash={project.hash}
                        specName={specName}
                        verifyPins={verifyPins[specName]}
                        onAddPin={(cmd) => addVerifyPin(specName, cmd)}
                        onRemovePin={(cmd) => removeVerifyPin(specName, cmd)}
                      />
                    );
                  })()
                ) : !shell.diffOpen && selectedFile ? (
                  project && (
                    <FileEditorPane
                      projectHash={project.hash}
                      path={selectedFile}
                      projectName={project.displayName}
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

              {!shell.rightPanel.collapsed && (
                <div
                  className="ds-resize-handle ds-resize-handle-x"
                  data-testid="resize-right-panel"
                  onPointerDown={bindDrag(
                    shell.rightPanel.handleProps,
                    "col-resize"
                  )}
                />
              )}

              <aside
                className="ds-right-sidebar"
                data-testid="right-sidebar"
                style={
                  {
                    "--panel-w": `${shell.rightPanel.size}px`,
                    marginRight: shell.rightPanel.collapsed
                      ? -shell.rightPanel.size
                      : 0,
                  } as CSSProperties
                }
              >
                <WorkspacePicker
                  variant="vibe"
                  project={project}
                  projects={projects}
                  branches={branches}
                  onSelectProject={selectProject}
                  onAddProject={onAddProject}
                  onRenameProject={onRenameProject}
                  onOpenBranchPicker={onOpenBranchPicker}
                />
                <ThreadList
                  variant="vibe"
                  threads={threads}
                  activeThread={thread}
                  project={project}
                  onNewThread={onNewThread}
                  onSelect={onSelectVibeThread}
                  onRename={onRenameThread}
                  onDelete={onDeleteThread}
                />
                {project && (
                  <VibeSpecLauncher
                    projectHash={project.hash}
                    linkedChange={thread?.openSpecChangeName}
                    onOpenSpec={(name) => tabs.openSpec(name)}
                  />
                )}
                <div className="ds-vibe-explorer">
                  <Accordion
                    value={shell.vibeExplorerOpen ? "file-explorer" : null}
                    onChange={(value) =>
                      shell.setVibeExplorerOpen(value !== null)
                    }
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
