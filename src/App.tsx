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
  type ReactNode,
} from "react";
import {
  Menu,
  Modal as MantineModal,
  Popover,
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
  Paper,
  Stack,
  UnstyledButton,
  Indicator,
  Tabs,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconFlask,
  IconArchive,
  IconBolt,
  IconBox,
  IconChevronDown,
  IconBrandTelegram,
  IconListCheck,
  IconCode,
  IconCommand,
  IconLayoutSidebarRight,
  IconMessageDots,
  IconPlayerPlay,
  IconFolder,
  IconFolders,
  IconGitBranch,
  IconLayoutBottombar,
  IconLayoutSidebar,
  IconLayoutSidebarRightFilled,
  IconPlayerStopFilled,
  IconRoute,
  IconSettings,
  IconShield,
  IconShieldOff,
  IconSunMoon,
  IconTerminal2,
  IconPlus,
  IconWand,
  IconX,
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
import {
  commandTrigger,
  matchCommands,
  slashQuery,
  menuKind,
  leadingCommand,
  chainCommands,
  isChainCommand,
  parseChainInvocation,
  type MenuCommand,
} from "./slashCommands";
import BetaBadge from "./BetaBadge";
import ChainsPanel, { CHAINS_CHANGED_EVENT } from "./ChainsPanel";
import { CHAIN_EXECUTOR_PREFIX } from "./api";
import ChainCanvas, { type RunView } from "./ChainCanvas";
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
import TabBar from "./TabBar";
import PreviewPane from "./PreviewPane";
import { useDevServerPreview } from "./useDevServerPreview";
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
import McpPane from "./McpPane";
// Lazy: the database surfaces pull in CodeMirror's SQL grammar and a grid
// nobody loads until they open the panel.
const DatabasePanel = lazy(() => import("./DatabasePanel"));
const SessionsPanel = lazy(() => import("./SessionsPanel"));
const DataGridTab = lazy(() => import("./DataGridTab"));
const SqlQueryTab = lazy(() => import("./SqlQueryTab"));
import RunPanel from "./RunPanel";
import ProblemsPane from "./ProblemsPane";
import EditorStatusBar from "./EditorStatusBar";
import { languageLabelFor } from "./codeLanguage";
import {
  DIAGNOSTICS_CHANGED,
  allDiagnostics,
  disposeProject,
} from "./lspClients";
import SpecChangeTab from "./SpecChangeTab";
import VerifyPane from "./VerifyPane";
import SettingsPanel, {
  applyAccentHue,
  loadAccentHue,
  applyAppearance,
  loadAppearance,
  PROJECT_SETTINGS_FILE,
} from "./SettingsPanel";
import TerminalTabs from "./TerminalTabs";
import TestExplorer from "./TestExplorer";
import DebugPanel from "./DebugPanel";
import { markersForFile, resolveTestPath } from "./testGutter";
import { languageForPath } from "./lsp";
import OnboardingScreen from "./OnboardingScreen";
import NavRail from "./NavRail";
import SessionList from "./SessionList";
import SearchPanel from "./SearchPanel";
import SourceControlPanel from "./SourceControlPanel";
import type { PanelId } from "./hooks/useAppShell";
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
  /** The live session id for this thread, if any — needed to resolve a
   *  pending permission-approval prompt against the right session. */
  sessionId: string | null;
  busy: boolean;
  /** This thread's isolated worktree, absent until its first session runs
   *  and for every thread in a non-git project. */
  worktree?: api.WorktreeStatus;
  /** Opens the Source Control panel on this thread's worktree. */
  onViewDiff?: () => void;
  executor: Preflight["selected"] | null;
  flight: Preflight | null;
  flightSelected: boolean;
  /** Probed model selector for the effective provider, or its load state. */
  models: api.ModelState | "loading" | { error: string } | null;
  onPickExecutor: (agentId: string) => void;
  onPickModel: (modelId: string) => void;
  /** The model menu was opened — probe the provider if not yet cached. */
  onProbeModels: () => void;
  /** Slash commands the agent advertised for this thread (ACP
   *  `available_commands_update`) — skills, user commands and built-ins alike. */
  /** Agent-advertised commands plus this project's saved chains (D14). */
  commands: MenuCommand[];
  /** Saved chains, offered in the executor picker as go-mode targets (D5).
   *  Optional: a project with none is the ordinary case, and so is a test
   *  fixture that doesn't care about chains. */
  chains?: api.Chain[];
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
  /** Every thread in the project — the strip is the in-conversation
   *  switcher (Amendment 3); the session list is the browse surface. */
  threads?: ThreadMeta[];
  onSelectThread?: (thread: ThreadMeta) => void;
  /** Removes the thread from the strip. The thread itself is untouched —
   *  History still lists it, the same way closing a file tab keeps the
   *  file. */
  onCloseThread?: (thread: ThreadMeta) => void;
  onNewThread?: () => void;
};

/** Segments typed into a mode card's live preview on hover/focus — the
 *  card shows what the mode actually does (a live edit, an interview
 *  question) instead of only describing it in prose. */
const MODE_LIVE_PREVIEWS: Record<
  api.Mode,
  { text: string; cls?: string }[]
> = {
  go: [{ text: "> editing " }, { text: "src/api.ts", cls: "diff-add" }],
  spec: [{ text: '> "What are we building?"' }],
};

function ModeCard({
  mode,
  icon,
  title,
  description,
  primary,
  onPick,
  autoFocus,
  testId,
}: {
  mode: api.Mode;
  icon: ReactNode;
  title: string;
  description: string;
  primary?: boolean;
  onPick: () => void;
  autoFocus?: boolean;
  testId: string;
}) {
  const [active, setActive] = useState(false);
  const [typed, setTyped] = useState<{ text: string; cls?: string }[]>([]);
  const [done, setDone] = useState(false);
  const cardRef = useRef<HTMLButtonElement>(null);

  // Command Deck: cursor-tracked tilt + glow. Mutates the DOM directly on
  // pointermove (rAF-throttled) rather than through React state — a 3D
  // transform recalculated every frame has no business going through a
  // render. Skips entirely under reduced motion; keyboard focus still gets
  // the plain CSS lift from :focus-visible.
  useEffect(() => {
    const card = cardRef.current;
    if (!card || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    const maxTilt = 6;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const rect = card.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        const rotateY = (px - 0.5) * 2 * maxTilt;
        const rotateX = -(py - 0.5) * 2 * maxTilt;
        card.style.setProperty("--glow-x", `${px * 100}%`);
        card.style.setProperty("--glow-y", `${py * 100}%`);
        card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-2px)`;
      });
    };
    const onEnter = () => card.classList.add("tracking");
    const onLeave = () => {
      card.classList.remove("tracking");
      card.style.transform = "";
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerenter", onEnter);
    card.addEventListener("pointerleave", onLeave);
    return () => {
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerenter", onEnter);
      card.removeEventListener("pointerleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const segments = MODE_LIVE_PREVIEWS[mode];
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced) {
      setTyped(segments);
      setDone(true);
      return;
    }
    const built = segments.map((s) => ({ ...s, text: "" }));
    setTyped(built);
    setDone(false);
    let segIdx = 0;
    let charIdx = 0;
    const id = setInterval(() => {
      if (segIdx >= segments.length) {
        clearInterval(id);
        setDone(true);
        return;
      }
      const seg = segments[segIdx];
      if (charIdx < seg.text.length) {
        charIdx++;
        built[segIdx] = { ...built[segIdx], text: seg.text.slice(0, charIdx) };
        setTyped([...built]);
      } else {
        segIdx++;
        charIdx = 0;
      }
    }, 26);
    return () => clearInterval(id);
  }, [active, mode]);

  return (
    <button
      ref={cardRef}
      className={`ds-mode-card${primary ? " ds-mode-card-primary" : ""}`}
      onClick={onPick}
      // Hover-only: focus (e.g. Go's autoFocus on mount) would otherwise
      // show the preview before the user ever touches a card, and a
      // mouse-only user who never tabs through would never see the
      // typewriter at all.
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
      data-testid={testId}
      autoFocus={autoFocus}
    >
      <span className="ds-mode-card-glow" aria-hidden="true" />
      {icon}
      <strong>{title}</strong>
      <span>{description}</span>
      <span className="ds-live-preview" aria-hidden="true">
        {typed.map((s, i) => (
          <span key={i} className={s.cls}>
            {s.text}
          </span>
        ))}
        {done && <span className="cursor" />}
      </span>
    </button>
  );
}

export const ChatSurface = memo(
  function ChatSurface({
    project,
    thread,
    messages,
    live,
    sessionId,
    busy,
    worktree,
    onViewDiff,
    executor,
    flight,
    flightSelected,
    models,
    onPickExecutor,
    chains = [],
    onPickModel,
    onProbeModels,
    commands = [],
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
    threads = [],
    onSelectThread,
    onCloseThread,
    onNewThread,
  }: ChatSurfaceProps) {
    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const [modelQuery, setModelQuery] = useState("");
    // Confirmation popover for the Accept→Bypass direction only (D2e) — the
    // reverse (Bypass→Accept) is a plain click, no popover state needed.
    const [bypassConfirmOpen, setBypassConfirmOpen] = useState(false);
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

    // Amendment 5's banner. Per thread: a warning about a session in one
    // thread means nothing in another.
    const [switchNotice, setSwitchNotice] = useState<{
      next: string;
      current: string;
    } | null>(null);
    useEffect(() => {
      setSwitchNotice(null);
    }, [thread?.id]);
    // A chain in the executor slot is named, not identified: the stored value
    // is `chain:design-loop`, but the picker should read "design-loop".
    const isChainExecutor = executor?.startsWith(CHAIN_EXECUTOR_PREFIX) ?? false;
    const executorLabel = executor
      ? isChainExecutor
        ? executor.slice(CHAIN_EXECUTOR_PREFIX.length)
        : (flight?.agents.find((a) => a.id === executor)?.name ?? executor)
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
    // The `/` menu. Opens on a leading slash and closes on the first space —
    // ACP takes the whole line as the prompt, so the rest is the command's
    // own input and there is nothing left to complete.
    const commandQuery = slashQuery(draft);
    // Which of the two menus is open — skills (`/`, `$`) or chains (`|=`).
    // The sigils never overlap in one draft, so this is never ambiguous, and
    // the header can name the list instead of the generic "commands".
    const openMenuKind = menuKind(draft);
    // Every command of the typed sigil's kind, before the query narrows it —
    // an empty pool means the agent hasn't advertised anything yet (skills)
    // or the project has no saved chains, which reads differently from a
    // query that just has no matches, so the menu tells them apart.
    const commandPool = useMemo(
      () =>
        openMenuKind === null
          ? []
          : commands.filter(
              (command) => menuKind(commandTrigger(command)) === openMenuKind
            ),
      [commands, openMenuKind]
    );
    const commandMatches = useMemo(
      () => (commandQuery === null ? [] : matchCommands(commandPool, commandQuery)),
      [commandPool, commandQuery]
    );
    // The menu stays open on a valid sigil even with nothing to show — a
    // silently-closed menu looked identical to a stray `/` that did nothing,
    // and gave no way to tell "nothing advertised yet" from "typo".
    const commandMenuOpen = commandQuery !== null;
    const [commandIndex, setCommandIndex] = useState(0);
    // A new query can be shorter than the old list; clamping here rather than
    // in the key handler keeps the highlight on a row that actually exists.
    const activeCommand = commandMatches[commandIndex] ?? commandMatches[0];
    useEffect(() => {
      setCommandIndex(0);
    }, [commandQuery]);

    // Completing a command just rewrites the draft — ACP invokes one by
    // sending its name as the prompt. The sigil is the agent's, not ours.
    const pickCommand = (command: api.AgentCommand) => {
      setDraft(commandTrigger(command));
    };

    // The command a draft *opens with* (D-chip): once the name is complete
    // and typing has moved past it into argument position, the composer
    // collapses the sigil+name back into a stylized pill instead of raw text
    // — the same treatment Cursor/Windsurf give a picked slash command.
    const chipCommand = useMemo(
      () => leadingCommand(commands, draft),
      [commands, draft]
    );
    const chipRemainder = useMemo(() => {
      if (!chipCommand) return "";
      const text = draft.trimStart();
      const trigger = commandTrigger(chipCommand);
      return text === trigger.trimEnd() ? "" : text.slice(trigger.length);
    }, [chipCommand, draft]);
    const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
    // Refocus whichever box is now on screen — picking a command, or
    // Backspacing a chip away, swaps in a different <textarea> element and
    // would otherwise drop focus out of the composer entirely.
    useEffect(() => {
      composerInputRef.current?.focus();
    }, [!!chipCommand]);

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
    const currentModelId =
      thread?.model ?? framingModel ?? modelState?.current ?? null;
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
            <p className="ds-mode-picker-prompt">How do you want to start?</p>
            <div className="ds-mode-picker">
              <ModeCard
                mode="go"
                icon={<IconBolt size={22} stroke={1.6} aria-hidden="true" />}
                title="Go"
                description="Start building — the agent can edit code right away."
                primary
                onPick={() => onPickMode("go")}
                autoFocus
                testId="pick-go"
              />
              {/* Amendment 6: lead with what the mode does — a structured
                  interview — not with what it forbids. "Read-only planning"
                  was accurate and told a first-time user nothing about the
                  questions they're about to be asked. */}
              <ModeCard
                mode="spec"
                icon={<IconListCheck size={22} stroke={1.6} aria-hidden="true" />}
                title="Spec"
                description="Write the spec together, one question at a time. Nothing gets built until you approve the plan."
                onPick={() => onPickMode("spec")}
                testId="pick-spec"
              />
            </div>
            <span className="hint ds-mode-picker-hint">
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
            {/* Picking a card starts the interview immediately (D1). Said
                out loud, because a card that looks like navigation and
                actually spends an agent turn is the kind of surprise that
                costs trust — a first-run reviewer flagged exactly this. */}
            <p className="hint" style={{ marginBottom: 4 }}>
              What would you like to spec out today?
            </p>
            <p
              className="hint"
              style={{ marginBottom: 12, fontSize: 11.5 }}
              data-testid="spec-type-note"
            >
              Picking one starts the interview — the agent asks its first
              question straight away.
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
            {/* Picking a card starts the interview immediately (D1). Said
                out loud, because a card that looks like navigation and
                actually spends an agent turn is the kind of surprise that
                costs trust — a first-run reviewer flagged exactly this. */}
            <p className="hint" style={{ marginBottom: 4 }}>
              What would you like to spec out today?
            </p>
            <p
              className="hint"
              style={{ marginBottom: 12, fontSize: 11.5 }}
              data-testid="spec-type-note"
            >
              Picking one starts the interview — the agent asks its first
              question straight away.
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
        {/* Thread tabs: the quick in-conversation switcher, in both presets.
            The badge is the thread's real mode — spec or go, the only two
            that exist. */}
        {threads.length > 0 && (
          <div className="ds-thread-tabs" data-testid="thread-tabs">
            {threads.map((t) => (
              <button
                key={t.id}
                className={`ds-thread-tab${t.id === thread?.id ? " active" : ""}`}
                aria-current={t.id === thread?.id ? "true" : undefined}
                onClick={() => onSelectThread?.(t)}
                data-testid="thread-tab"
                title={t.title}
              >
                <span className="ds-thread-tab-title">{t.title}</span>
                <span className="ds-thread-tab-mode">
                  {t.currentMode === "spec" ? "SPEC" : "GO"}
                </span>
                <span
                  className="ds-thread-tab-close"
                  role="button"
                  tabIndex={0}
                  aria-label={`Close ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseThread?.(t);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onCloseThread?.(t);
                    }
                  }}
                  data-testid="thread-tab-close"
                >
                  <IconX size={12} />
                </span>
              </button>
            ))}
            <button
              className="ds-thread-tab-new"
              aria-label="New thread"
              onClick={() => onNewThread?.()}
              data-testid="thread-tab-new"
            >
              <IconPlus size={13} />
            </button>
          </div>
        )}
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
          {/* The branch this thread's agent is actually writing to. Absent
              until the first session creates the worktree, and for projects
              that aren't git repos. */}
          {worktree && (
            <Tooltip
              label="This thread runs in its own git worktree"
              openDelay={400}
            >
              <Badge
                size="sm"
                variant="default"
                tt="none"
                ff="var(--mono)"
                leftSection={<IconGitBranch size={11} />}
                data-testid="worktree-chip"
              >
                {worktree.branch}
              </Badge>
            </Tooltip>
          )}
          <div className="spacer" />
        </div>
        {/* Amendment 5: switching agents mid-session used to be explained
            only by a hint inside the dropdown, which closes the instant you
            choose — the explanation vanished exactly when it was needed.
            This lives in the chat area and stays until dismissed. */}
        {switchNotice && (
          <Alert
            color="warn"
            variant="light"
            m="8px 12px 0"
            data-testid="executor-switch-banner"
          >
            Next session will use <strong>{switchNotice.next}</strong>. This
            session continues as <strong>{switchNotice.current}</strong>.
            <Button
              size="compact-xs"
              variant="subtle"
              ml={8}
              onClick={() => setSwitchNotice(null)}
              data-testid="executor-switch-dismiss"
            >
              Dismiss
            </Button>
          </Alert>
        )}
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
              executor={executor}
              sessionId={sessionId}
              onRetry={(text) => {
                setDraft(text);
                handleSend();
              }}
            />
          </>
          {busy && (
            <div className="working" data-testid="working">
              executor working
              <Loader type="dots" size={16} color="neutral" />
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
        {/* What this thread has changed inside its own worktree, sitting
            where the user is already looking when a turn ends. Renders only
            once there is something to report — an empty worktree gets no
            strip, and neither does a non-git project.

            It says what changed, never that the change is correct: only a
            verify run can claim that. */}
        {worktree && worktree.added + worktree.removed > 0 && (
          <div className="ds-worktree-strip" data-testid="worktree-strip">
            <IconGitBranch size={12} />
            <span className="ds-worktree-strip-branch">{worktree.branch}</span>
            <span className="ds-worktree-strip-stat">
              <span className="added">+{worktree.added}</span>
              <span className="removed">−{worktree.removed}</span>
            </span>
            <div className="spacer" />
            {onViewDiff && (
              <button
                type="button"
                className="ds-worktree-strip-link"
                onClick={onViewDiff}
                data-testid="worktree-view-diff"
              >
                View diff
              </button>
            )}
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
            position: "relative",
          }}
        >
          {/* The `/` menu, anchored above the composer so the input it is
              completing stays visible and in place while it filters. */}
          {commandMenuOpen && (
            <Paper
              withBorder
              shadow="md"
              radius="md"
              className="ds-command-menu"
              data-testid="command-menu"
              data-kind={openMenuKind ?? undefined}
              role="listbox"
              aria-label={openMenuKind === "chains" ? "Chains" : "Skills"}
            >
              <div className="ds-command-menu-header">
                {openMenuKind === "chains" ? (
                  <>
                    <IconRoute size={12} />
                    Chains
                  </>
                ) : (
                  <>
                    <IconWand size={12} />
                    Skills
                  </>
                )}
              </div>
              <div className="ds-command-menu-scroll">
                {commandPool.length === 0 ? (
                  <p className="ds-command-menu-empty">
                    {openMenuKind === "chains"
                      ? "No chains saved for this project yet."
                      : "No skills advertised for this session yet — send a message to start one."}
                  </p>
                ) : commandMatches.length === 0 ? (
                  <p className="ds-command-menu-empty">
                    No matches for “{commandQuery}”.
                  </p>
                ) : (
                  commandMatches.map((command, index) => (
                  <UnstyledButton
                    key={command.name}
                    role="option"
                    aria-selected={command === activeCommand}
                    data-active={command === activeCommand || undefined}
                    className="ds-command-menu-row"
                    // Mouse and keyboard drive the same highlight, so hovering
                    // never leaves two rows looking selected at once.
                    onMouseEnter={() => setCommandIndex(index)}
                    onClick={() => pickCommand(command)}
                  >
                    <span className="ds-command-menu-name">
                      {isChainCommand(command) && (
                        <IconRoute
                          size={12}
                          // A chain runs several agents against each other —
                          // a different kind of thing than a skill, and the
                          // row says so before it is picked (D14).
                          style={{ marginRight: 4, verticalAlign: "-1px" }}
                        />
                      )}
                      {commandTrigger(command).trimEnd()}
                    </span>
                    <span className="ds-command-menu-desc">
                      {command.description}
                    </span>
                  </UnstyledButton>
                  ))
                )}
              </div>
            </Paper>
          )}

          {/* Standalone permission-mode toggle, always visible top-right of
              the composer (D2c) — separate from the executor/model pickers
              and Spec/Go control below. Icon carries the state (D2d); only
              the dangerous direction (Accept→Bypass) asks for confirmation
              (D2e). */}
          <Popover
            opened={bypassConfirmOpen}
            onChange={setBypassConfirmOpen}
            withArrow
            position="top-end"
          >
            <Popover.Target>
              <ActionIcon
                variant="subtle"
                color={threadBypass ? "warn" : "neutral"}
                data-testid="permission-mode-btn"
                data-tauri-drag-region-exclude
                aria-label={threadBypass ? "Bypass permissions" : "Accept permissions"}
                style={{ position: "absolute", top: 8, right: 8, zIndex: 1 }}
                onClick={() => {
                  if (threadBypass) {
                    onToggleBypass();
                  } else {
                    setBypassConfirmOpen(true);
                  }
                }}
              >
                {threadBypass ? <IconShieldOff size={16} /> : <IconShield size={16} />}
              </ActionIcon>
            </Popover.Target>
            <Popover.Dropdown data-testid="permission-mode-confirm">
              <Stack gap="xs">
                <span style={{ fontSize: 13 }}>
                  Bypass permissions for this thread? Tool calls will run
                  without asking.
                </span>
                <Group gap="xs" justify="flex-end">
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => setBypassConfirmOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="compact-xs"
                    color="warn"
                    data-testid="permission-mode-confirm-bypass"
                    onClick={() => {
                      onToggleBypass();
                      setBypassConfirmOpen(false);
                    }}
                  >
                    Bypass
                  </Button>
                </Group>
              </Stack>
            </Popover.Dropdown>
          </Popover>

          {/* Message input. Once the draft opens with a complete command, the
              sigil+name collapses into a pill (D-chip) and only the argument
              text stays in an editable box — the composer never asks the
              user to hand-edit `/adversarial-persona-testing` as raw text
              again once they've picked it from the menu. */}
          {chipCommand ? (
            <div className="ds-composer-chip-row">
              <span
                className="ds-composer-chip"
                data-kind={isChainCommand(chipCommand) ? "chain" : "skill"}
                data-testid="composer-chip"
              >
                {isChainCommand(chipCommand) ? (
                  <IconRoute size={12} />
                ) : (
                  <IconWand size={12} />
                )}
                {commandTrigger(chipCommand).trimEnd()}
              </span>
              <Textarea
                ref={composerInputRef}
                value={chipRemainder}
                onChange={(event) =>
                  setDraft(commandTrigger(chipCommand) + event.target.value)
                }
                onKeyDown={(event) => {
                  if (
                    event.key === "Backspace" &&
                    event.currentTarget.selectionStart === 0 &&
                    event.currentTarget.selectionEnd === 0
                  ) {
                    // Backspacing at the argument's start eats the whole
                    // pill in one keystroke, same as Cursor/Windsurf — not a
                    // character at a time out of a sigil the user can no
                    // longer see.
                    event.preventDefault();
                    setDraft(chipRemainder);
                    return;
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!busy && draft.trim()) {
                      event.currentTarget.form?.requestSubmit();
                    }
                  }
                }}
                placeholder="Argument…"
                aria-label="Command argument"
                data-testid="composer-input"
                minRows={1}
                maxRows={6}
                styles={{
                  root: { flex: 1, minWidth: 0 },
                  // No padding of its own — the row's 10px/12px padding is
                  // shared with the pill, so text starts flush with where a
                  // plain message would, not offset in its own little box.
                  input: {
                    width: "100%",
                    minHeight: 21,
                    padding: 0,
                    border: 0,
                    background: "transparent",
                    boxShadow: "none",
                    resize: "none",
                    fontSize: 14,
                    lineHeight: 1.5,
                  },
                }}
              />
            </div>
          ) : (
            <Textarea
              ref={composerInputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // The menu owns the arrows, Tab, Enter and Escape while it is
                // open — otherwise Enter would send a half-typed command name.
                if (commandMenuOpen) {
                  if (
                    (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                    commandMatches.length > 0
                  ) {
                    event.preventDefault();
                    const step = event.key === "ArrowDown" ? 1 : -1;
                    setCommandIndex(
                      (i) =>
                        (i + step + commandMatches.length) % commandMatches.length
                    );
                    return;
                  }
                  if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
                    event.preventDefault();
                    if (activeCommand) pickCommand(activeCommand);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    // Closing without choosing: keep what was typed, drop the
                    // sigil, so Escape never destroys the user's text.
                    setDraft(draft.replace(/^(\s*)[/$]/, "$1"));
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();

                  if (!busy && draft.trim()) {
                    event.currentTarget.form?.requestSubmit();
                  }
                }
              }}
              placeholder={
                flightSelected
                  ? "Message, or / for commands"
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
          )}

          {/* Bottom controls. Class, not inline styles: at the Editor
              preset's 300px default the row has to wrap and its labels have
              to truncate, and neither is expressible here. */}
          <div className="ds-composer-controls">
            <Menu opened={prefsMenuOpen} onChange={setPrefsMenuOpen}>
              <Menu.Target>
                {/* Pill, not a bare label: the mockup's composer reads as two
                    tappable chips (icon · name · chevron), and the flat
                    text-only buttons read as static labels instead. */}
                <button
                  className="ds-composer-picker"
                  data-testid="executor-btn"
                  data-tauri-drag-region-exclude
                >
                  <IconBox size={14} />
                  <span className="ds-composer-picker-label">
                    {executorLabel ?? "none detected"}
                  </span>
                  <IconChevronDown size={12} />
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
                        if (hasLiveSession) {
                          setSwitchNotice({
                            next: a.name,
                            current: executorLabel ?? "the current agent",
                          });
                        }
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
                {/* D5: a saved chain is one more thing this slot can
                    resolve to. Picking one makes /go run the chain instead of
                    a single agent — still go mode, not a third one. */}
                {chains.length > 0 && (
                  <>
                    <Menu.Divider />
                    <Menu.Label>Chain</Menu.Label>
                    {chains.map((chain) => {
                      const id = `${CHAIN_EXECUTOR_PREFIX}${chain.name}`;
                      return (
                        <Menu.Item
                          key={id}
                          className={`ds-model-opt ${executor === id ? "selected" : ""}`}
                          data-testid={`executor-opt-${id}`}
                          leftSection={<IconRoute size={14} />}
                          onClick={() => {
                            if (id !== executor) onPickExecutor(id);
                            setPrefsMenuOpen(false);
                          }}
                        >
                          {chain.name}
                        </Menu.Item>
                      );
                    })}
                  </>
                )}
                {/* Stale copy fixed: this said "Next session will use <the
                    agent you already have>", describing a switch that had
                    already happened, and then repeated the handoff sentence
                    the post-pick banner (Amendment 5) now owns. It's a
                    pre-pick caveat now — what a switch would cost, not a
                    report of one. */}
                {hasLiveSession && (
                  <span className="hint" data-testid="next-session-hint">
                    A session is running. Picking another agent starts the
                    next session with it
                    {threadBypass ? " (bypass on)" : ""} — this one keeps
                    going as {executorLabel ?? "the current agent"}.
                  </span>
                )}
              </Menu.Dropdown>
            </Menu>
            {/* A chain runs several agents in sequence, each with its own
                model — there is no single model slot to show or set here,
                so the picker doesn't render rather than offering a control
                that can't do anything (previously: probing "chain:<name>"
                as if it were an agent id and surfacing its failure as
                "models unavailable"). */}
            {!isChainExecutor && (
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
                {/* Accented once a model is actually pinned, so "which model
                    am I about to spend a turn on" is answerable at a glance. */}
                <button
                  className={`ds-composer-picker${
                    currentModelId ? " selected" : ""
                  }`}
                  data-testid="model-btn"
                  data-tauri-drag-region-exclude
                  disabled={!executor}
                >
                  <IconBox size={14} />
                  <span className="ds-composer-picker-label">{modelLabel}</span>
                  <IconChevronDown size={12} />
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
            )}
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
                    // Flexible, not fixed: 190px is the comfortable size, but
                    // a rigid block here is what forced the controls row to
                    // wrap in a narrow chat pane.
                    width: 190,
                    minWidth: 104,
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
                      backgroundColor: "var(--danger)",
                      color: "var(--danger-on)",
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
                  <IconPlayerStopFilled size={14} />
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
                  <IconBrandTelegram size={17} />
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
    const onMove = (e: PointerEvent) => {
      // Self-heal: if the button is already up, the pointerup never reached
      // us (a native window drag, a pointercancel, or a release outside the
      // window all swallow it) and the drag would otherwise track the cursor
      // forever with no way to let go.
      if (e.buttons === 0) {
        onUp();
        return;
      }
      handle.onPointerMove(e);
    };
    const onUp = () => {
      handle.onPointerUp();
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  };

// D15: .palisade/project-settings.json's known v1 shape. The backend auto-creates
// this on every project open (settings::ensure_file); this is only a
// fallback for the rare case a project's file was deleted after the fact
// and the user re-opens it via the settings button before switching
// projects again.
const DEFAULT_PROJECT_SETTINGS = `{
  "formatOnSave": {},
  "executorOverride": null
}
`;
const lastThreadKey = (hash: string) => `palisade:lastThread:${hash}`;
const threadPrefsKey = (hash: string, threadId: string) =>
  `palisade:thread-prefs:${hash}:${threadId}`;

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

// Every never-configured thread starts in Accept mode (D6) — no global
// default a thread's own toggle could silently promote for every other one.
const resolvePrefs = (hash: string, threadId: string): ThreadPrefs =>
  getThreadPrefs(hash, threadId) ?? { bypass: false };
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
/** Placeholder `seq` for a user message rendered before the backend has
 *  assigned it a real one — real seqs are positive, persisted integers, so
 *  this can never collide with one. */
const OPTIMISTIC_SEQ = -1;
type ThreadRowProps = {
  thread: ThreadMeta;
  active: boolean;
  onSelect: (thread: ThreadMeta) => void;
  onRename: (thread: ThreadMeta) => void;
  onDelete: (thread: ThreadMeta) => void;
  onArchive: (thread: ThreadMeta) => void;
};

const ThreadRow = memo(function ThreadRow({
  thread,
  active,
  onSelect,
  onRename,
  onDelete,
  onArchive,
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
          {/* Archive is the reversible one and comes first; delete stays
              separate and destructive. */}
          <button
            className="ds-thread-action"
            onClick={(event) => {
              event.stopPropagation();
              onArchive(thread);
            }}
            title={thread.archived ? "Unarchive thread" : "Archive thread"}
            aria-label={thread.archived ? "Unarchive thread" : "Archive thread"}
            data-testid="archive-thread"
          >
            <IconArchive size={13} />
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
  onArchive: (thread: ThreadMeta) => void;
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
  onArchive,
}: ThreadListProps) {
  void variant;
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = threads.filter((t) => t.archived).length;
  const shown = showArchived ? threads : threads.filter((t) => !t.archived);
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
        {shown.map((t) => (
          <ThreadRow
            key={t.id}
            thread={t}
            active={t.id === activeThread?.id}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
            onArchive={onArchive}
          />
        ))}
      </ul>
      {archivedCount > 0 && (
        <button
          className="ds-thread-archive-toggle"
          onClick={() => setShowArchived((v) => !v)}
          data-testid="toggle-archived"
        >
          {showArchived
            ? "Hide archived"
            : `Show ${archivedCount} archived`}
        </button>
      )}
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
  const otherProjects = projects.filter((p) => p.hash !== project?.hash);
  return (
    <div className="ds-workspace-panel">
      <div className="ds-rail-section">
        <p className="ds-workspace-desc">Project &amp; branch for this thread</p>
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
            Add project
          </button>
          {project && (
            <button
              className="ds-rail-action-subtle"
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
            <IconGitBranch size={14} />{" "}
            {branches.find((b) => b.isCurrent)?.name ?? "…"}
          </button>
        )}
      </div>
      {otherProjects.length > 0 && (
        <div className="ds-rail-section">
          <h2 className="ds-section-heading">Recent Projects</h2>
          <ul className="ds-recent-projects">
            {otherProjects.map((p) => {
              const select = () => onSelectProject(p);
              return (
                <li
                  key={p.hash}
                  className="ds-tree-row"
                  role="button"
                  tabIndex={0}
                  onClick={select}
                  onKeyDown={onActivateKey(select)}
                  data-testid="recent-project"
                >
                  <IconFolder size={14} className="ds-chevron" />
                  <span className="ds-tree-label">{p.displayName}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
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
  const commandsByThread = ex.commandsByThread;
  const setCommandsByThread = ex.setCommandsByThread;
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
        placeholder?: string;
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
  // The project being opened, if any — drives the onboarding row's spinner.
  const [openingProject, setOpeningProject] = useState<string | null>(null);
  /** Branch → the worktree path that holds it, for every worktree but the
   *  project root. Drives both the picker's worktree marker and what picking
   *  such a branch does. */
  const [worktreeBranches, setWorktreeBranches] = useState<Map<string, string>>(
    new Map()
  );
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
  const [threadPrefs, setThreadPrefsState] = useState<ThreadPrefs>({
    bypass: false,
  });
  const [prefsMenuOpen, setPrefsMenuOpen] = useState(false);
  // Whether *this* thread has a live session right now, so the "Next session
  // will use X" hint only shows when switching would actually hand off an
  // in-progress conversation. Reads `busyThreads` directly — the same
  // reactive state the sidebar dot uses — rather than polling
  // `executorStatus()` on menu-open: that poll raced the click (open the
  // menu, pick a provider before the fetch resolved) and could show the
  // hint on a thread that had never sent a message, just because a
  // *previous* thread's stale `hasLiveSession` value was still in state.
  const hasLiveSession = thread ? busyThreads.has(thread.id) : false;
  const onToggleBypass = () => {
    if (!project || !thread) return;
    const prefs = { bypass: !threadPrefs.bypass };
    setThreadPrefs(project.hash, thread.id, prefs);
    setThreadPrefsState(prefs);
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
  // Which terminal tab a "Run" click should type into. Several shells can be
  // open at once, so "the terminal" is no longer a single implicit target.
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  if (shell.terminalPlacement === "bottom" && !shell.terminalPanel.collapsed) {
    terminalEverOpened.current = true;
  }
  const [paletteFiles, setPaletteFiles] = useState<string[]>([]);
  const filesCache = useRef<Map<string, string[]>>(new Map());
  const { refreshToken: fileTreeRefreshToken, invalidate: invalidateFileTree } =
    useFileTreeCache();
  // Verify pins from `.palisade/project-settings.json` (D8): spec change name → list
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

  // Drives the Source Control rail icon's uncommitted-changes dot. Follows
  // the same refresh token the diff pane uses, so it never goes stale after
  // an agent turn or a save.
  const [dirtyCount, setDirtyCount] = useState(0);
  useEffect(() => {
    if (!project) {
      setDirtyCount(0);
      return;
    }
    api
      .gitStatus(project.hash)
      .then((files) => setDirtyCount(files.length))
      // Not every project is a git repo — no dot is the right answer here,
      // not an error banner.
      .catch(() => setDirtyCount(0));
  }, [project?.hash, diffRefreshToken]);

  // Clicking a change in the Source Control panel opens that file's diff —
  // what every other IDE does, and what the old behaviour (open the file
  // itself) failed at outright for an untracked directory.
  const [diffFocusPath, setDiffFocusPath] = useState<string | null>(null);
  const openDiffFor = useCallback(
    (path: string) => {
      setDiffFocusPath(path);
      shell.setDiffOpen(true);
    },
    [shell.setDiffOpen]
  );

  // Amendment 1: the project's run commands, shared by the title bar's split
  // button and the rail's Run panel. `runLast` is the split button's primary
  // action — the last thing you ran is what you almost always want next.
  const [runList, setRunList] = useState<[string, string][]>([]);
  const [runLast, setRunLast] = useState<string | null>(null);
  const [runReloadToken, setRunReloadToken] = useState(0);
  useEffect(() => {
    if (!project) {
      setRunList([]);
      setRunLast(null);
      return;
    }
    api.runCommands(project.hash).then(setRunList, () => setRunList([]));
  }, [project?.hash, runReloadToken]);

  const runCommand = useCallback(
    (name: string, command: string) => {
      setRunLast(name);
      // Output belongs in the bottom panel's Terminal tab (Amendment 1), so
      // open it before writing — otherwise the command runs somewhere the
      // user can't see.
      shell.setBottomTab("terminal");
      if (shell.terminalPanel.collapsed) shell.toggleTerminal();
      if (!project) return;
      // Spawn first: on the very first run the panel has only just opened,
      // and writing to a pty that doesn't exist yet fails with "no terminal
      // running" — the command would vanish with no output and no error.
      // `terminal_spawn` is a no-op when one is already running.
      // The focused tab, or — on the very first run, before TerminalTabs has
      // mounted and reported one — the tab it deterministically opens first.
      const target = activeTerminalId ?? `${project.hash}:1`;
      api
        .terminalSpawn(project.hash, target)
        .then(() => api.terminalInput(target, `${command}\n`))
        .catch(fail);
    },
    [
      project?.hash,
      activeTerminalId,
      shell.setBottomTab,
      shell.terminalPanel.collapsed,
      shell.toggleTerminal,
    ]
  );

  const handleFileSave = useCallback(
    (edit: { path: string; before: string; after: string }) => {
      setFileEdits((prev) => [...prev, edit]);
      // Test results recorded before this write describe code that no longer
      // exists; the explorer reads this to say so.
      setLastEditAt(Date.now());
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

  const banner = (message: string, tone: "error" | "warn") =>
    setErrors((prev) => [
      ...prev,
      { id: `${Date.now()}-${Math.random()}`, message, tone },
    ]);
  const fail = (err: unknown) => banner(describeError(err), "error");
  // Advisory, not a failure: another thread is running here, an executor id
  // in settings is unknown and Palisade fell back. Routing these through `fail`
  // put "Couldn't complete that" on an action that completed fine.
  const warn = (message: string) => banner(message, "warn");
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
    // Loaded alongside the branch list because it answers a question about
    // the same rows: which of these branches already live in a worktree, and
    // where. A branch can only be checked out once, so those rows open their
    // worktree instead of switching — the picker has to say so up front.
    try {
      setWorktreeBranches(new Map(await api.gitWorktrees(projectHash)));
    } catch {
      setWorktreeBranches(new Map());
    }
  }, []);

  // The branch label sits on a write action ("commit on X"), so it cannot be
  // read once at project open: an agent turn that switches branches would
  // leave the commit box naming a branch the commit won't land on.
  useEffect(() => {
    if (project) refreshBranches(project.hash);
  }, [project?.hash, diffRefreshToken, refreshBranches]);

  const selectProjectNow = useCallback(
    async (next: Project) => {
      // Switching is several round-trips (switch_project, a read per restored
      // tab, threads, branches). Announce it so the onboarding row the user
      // just clicked doesn't sit there looking dead.
      setOpeningProject(next.hash);
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
        if (previous && previous !== refreshed.hash) {
          evictProjectSessions(previous);
          // D15: servers live per project. Leaving them running would keep
          // a rust-analyzer indexing a directory nobody has open.
          void disposeProject(previous);
        }
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
      } finally {
        setOpeningProject(null);
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

  // Launch lands on the onboarding screen with nothing open, the way every
  // other IDE starts — opening a project is the user's explicit act, not
  // something restored behind their back. The recent list is loaded so that
  // screen can offer it; nothing is selected from it.
  useEffect(() => {
    api.listProjects().then(setProjects, fail);
  }, []);

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

  // Amendment 8's Clone Repository card. Clones into a directory the user
  // picks, then opens the result as a project — the same add path, with a
  // `git clone` in front of it.
  const onCloneRepository = () => {
    setBar({
      kind: "input",
      label: "Repository URL to clone",
      value: "",
      placeholder: "https://github.com/user/repo.git",
      submit: async (url) => {
        setBar(null);
        try {
          const parent = await open({
            directory: true,
            title: "Clone into…",
          });
          if (typeof parent !== "string") return;
          const added = await api.cloneRepository(url, parent);
          setProjects(await api.listProjects());
          await selectProject(added);
        } catch (err) {
          fail(err);
        }
      },
    });
  };

  // The onboarding composer's send: unlike the plain New Project tile, a
  // typed request has somewhere to go once a folder is picked — open the
  // project, create a fresh go-mode thread (reusing onSend's first-send
  // shape below, but against the just-picked project's hash directly rather
  // than closured `project`/`thread` state, which wouldn't be fresh yet),
  // carry the framing-menu's executor/model pick onto it, send the message,
  // and land in Vibe so the run is visible immediately instead of the empty
  // shell the New Project path leaves you on.
  const onOnboardingComposerSend = async (text: string) => {
    try {
      const picked = await open({ directory: true, title: "Add a project" });
      if (typeof picked !== "string") return;
      const added = await api.addProject(picked);
      setProjects(await api.listProjects());
      await selectProjectNow(added);
      const created = await api.createThread(added.hash, "New thread");
      let activeThread = await api.setThreadMode(added.hash, created.id, "go");
      const persisted = await persistFramingChoice(added.hash, activeThread.id);
      if (persisted) activeThread = persisted;
      setThreads(await api.listThreads(added.hash));
      await selectThread(added.hash, activeThread);
      shell.setCenterShell("vibe");
      setBusy(true);
      const prefs = resolvePrefs(added.hash, activeThread.id);
      const sent = await api.sendMessage(
        added.hash,
        activeThread.id,
        text,
        "go",
        prefs.bypass
      );
      setMessages((prev) =>
        prev.some((m) => m.seq === sent.seq) ? prev : [...prev, sent]
      );
      api.listThreads(added.hash).then((found) => {
        setThreads(found);
        const mine = found.find((t) => t.id === activeThread.id);
        if (mine) setThread(mine);
      }, () => {});
      if (!flight?.selected) setBusy(false);
    } catch (err) {
      setBusy(false);
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

  // Opens a location a test runner reported. Its paths are relative to
  // wherever the runner ran, which for a nested crate is not the project
  // root — resolve against the project's own files before opening.
  const openAtLine = useCallback(
    (reported: string, line: number) => {
      const known = project ? filesCache.current.get(project.hash) ?? [] : [];
      selectFile(resolveTestPath(reported, known), line);
    },
    [project?.hash, selectFile]
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

  // The tab bar's "+" → New File (D14, amended). The explorer's own inline
  // create input can't serve this: FileTree only mounts while the Explorer
  // panel is open, and in Vibe mode it isn't on screen at all.
  // Reuses the app's existing `kind: "input"` prompt rather than adding a
  // second name-entry modal.
  const newFileAtRoot = useCallback(() => {
    if (!project) return;
    setBar({
      kind: "input",
      label: "New file",
      value: "",
      submit: async (name) => {
        setBar(null);
        try {
          await api.writeFileContent(project.hash, name, "");
          filesCache.current.delete(project.hash);
          invalidateFileTree(name);
          tabs.open(name);
        } catch (err) {
          fail(err);
        }
      },
    });
  }, [project, tabs, invalidateFileTree]);

  // Auto-open Preview when either output stream prints a dev-server URL
  // (D9/D11) — same helper the "+" menu uses, so both paths behave alike.
  useDevServerPreview(useCallback((url: string) => tabs.openPreview(url), [tabs]));

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
          // A branch lives in exactly one worktree, and with a worktree per
          // thread most branches in this list are already checked out
          // somewhere — git cannot check one out twice, and trying produced a
          // `fatal:` naming a path the user never chose.
          //
          // Picking such a branch plainly means "take me to that work", so
          // that is what happens: the worktree opens as a workspace, with its
          // own file tree, editor, terminal and source control. One rule for
          // every worktree, Palisade's own thread worktrees included — being
          // able to edit that tree by hand is the whole point.
          const held = worktreeBranches.get(choice);
          if (held) {
            const opened = await api.addProject(held);
            setProjects(await api.listProjects());
            await selectProject(opened);
            return;
          }
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
    // Starting a new thread means starting over: clear the half-finished
    // states from the last attempt. Each of these outranks the picker in
    // the chat's render condition, so leaving one set made every "New
    // thread" button silently do nothing — pick Go, don't send, and the
    // app had no way back to the picker.
    setPendingMode(null);
    setSpecTypePicker(false);
    setComposerSpecTypePicker(false);
    setTransitioning(false);
    // Deselect the thread you were reading. The picker renders *over* the
    // chat, so leaving it selected meant picking Go fell straight through
    // to that thread's history — the new draft vanished and an older
    // conversation took its place. (Spec looked fine only because its
    // framing menu has its own branch above that fall-through.)
    setThread(null);
    // …and the messages that were on screen with it, or the new thread's
    // empty composer renders under the old thread's transcript.
    setMessages([]);
    setNewThreadPicker(true);
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

  // The provider/model the user picked before any thread existed (D21's
  // framing scratch state), written onto the thread the moment one is
  // created. Both deferred-creation paths — Spec's framing menu and Go's
  // first send — go through here; when only a model was picked, the
  // executor falls back to what the button was already displaying (D21),
  // or the model pick is dropped along with the unset executor.
  const persistFramingChoice = async (hash: string, threadId: string) => {
    const pickedExecutor =
      framingExecutor ?? (framingModel ? flight?.selected : null) ?? null;
    setFramingExecutor(null);
    setFramingModel(null);
    if (!pickedExecutor) return null;
    return api.setThreadExecutor(
      hash,
      threadId,
      pickedExecutor,
      framingModel ?? null
    );
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
    try {
      const created = await api.createThread(project.hash, "New thread");
      // Persist the framing-menu executor/model on the thread before
      // specMode fires — ensure_session reads the thread's stored executor
      // to decide which agent to start. Without this, it falls back to
      // auto-detection and ignores the user's framing-menu choice.
      await persistFramingChoice(project.hash, created.id);
      // Re-read the thread metadata so the executor/model is reflected.
      const threads = await api.listThreads(project.hash);
      const updated = threads.find((t) => t.id === created.id) ?? created;
      await selectThread(project.hash, updated);
      setThreads(threads);
      // Fire specMode without awaiting — don't block the UI. The busy state
      // stays true until the agent's turn ends (ExecutorEvent::Done clears it).
      api
        .specMode(project.hash, updated.id, specType, false, true)
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

  const onArchiveThread = (target: ThreadMeta) => {
    if (!project) return;
    pm.setThreadArchived(project.hash, target.id, !target.archived).catch(fail);
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
  // session isn't wiped along with it. A still-unanswered permission request
  // is the exception: it's live-only (never persisted, D-design comment on
  // ExecutorEvent::PermissionRequest), so dropping it on entry would strand
  // the session waiting on a prompt the UI no longer shows.
  const clearLiveFor = useCallback((threadId: string) => {
    setLiveBySession((previous) => {
      const next = new Map(previous);
      for (const [id, entry] of next) {
        if (entry.threadId !== threadId) continue;
        const last = entry.events[entry.events.length - 1];
        if (last?.kind === "permissionRequest") continue;
        next.delete(id);
      }
      return next;
    });
  }, []);

  // Threads whose live session is blocked on an unanswered permission prompt
  // — the sidebar's "needs-attention" dot and aggregate count. Derived from
  // the same live event stream the chat pane already renders the prompt
  // from, not a new subsystem.
  const attentionThreads = useMemo(() => {
    const set = new Set<string>();
    for (const entry of liveBySession.values()) {
      const last = entry.events[entry.events.length - 1];
      if (last?.kind === "permissionRequest") set.add(entry.threadId);
    }
    return set;
  }, [liveBySession]);

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

  // Each thread's own worktree and what has changed in it, keyed by thread —
  // this is what the sidebar's diff stat and branch line read.
  const [worktrees, setWorktrees] = useState<Map<string, api.WorktreeStatus>>(
    new Map()
  );
  const loadWorktrees = useCallback(() => {
    const hash = current.current.project?.hash;
    if (!hash) return;
    api.threadWorktrees(hash).then(
      (list) => setWorktrees(new Map(list.map((w) => [w.threadId, w]))),
      // A non-git project has no worktrees to report; the rows just show none.
      () => setWorktrees(new Map())
    );
  }, []);
  // Polled only while an agent is actually working — the stat is otherwise
  // static, and a timer running against an idle app buys nothing. The diff
  // pane rides the same tick, so watching chat and watching the code stay in
  // step while the agent writes.
  useEffect(() => {
    loadWorktrees();
    if (busyThreads.size === 0) return;
    const timer = setInterval(() => {
      loadWorktrees();
      setDiffRefreshToken((n) => n + 1);
    }, 4000);
    return () => clearInterval(timer);
  }, [loadWorktrees, project?.hash, threads, busyThreads]);

  // Show the code as the agent changes it, the way Cursor and Windsurf both
  // do: the moment a turn starts, the editor column switches to the diff, so
  // a user reading the chat is also watching the edits land.
  //
  // Rising edge only. Closing the diff mid-turn is a decision the user made
  // about *this* turn, and re-opening it under them on the next poll would
  // be the app arguing with them; the next turn starts the cycle over.
  const wasBusy = useRef(false);
  useEffect(() => {
    const busyNow = thread ? busyThreads.has(thread.id) : false;
    if (busyNow && !wasBusy.current && shell.centerShell === "vibe") {
      setDiffFocusPath(null);
      shell.setDiffOpen(true);
    }
    wasBusy.current = busyNow;
  }, [busyThreads, thread?.id, shell.centerShell, shell.setDiffOpen]);

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

  /* ---------------------------------------------------------------- chains */

  // Saved chains, kept here rather than in the panel because the composer's
  // `|=` menu needs the same list (D14).
  const [chains, setChains] = useState<api.Chain[]>([]);
  const [chainRun, setChainRun] = useState<
    (RunView & { chain: string }) | null
  >(null);

  useEffect(() => {
    if (!project) {
      setChains([]);
      return;
    }
    const load = () => api.listChains(project.hash).then(setChains, () => {});
    void load();
    window.addEventListener(CHAINS_CHANGED_EVENT, load);
    return () => window.removeEventListener(CHAINS_CHANGED_EVENT, load);
  }, [project]);

  // The agent picker's options: the same installed agents auto-detection sees
  // (D16), never a hand-maintained list.
  const chainAgents = useMemo(
    () =>
      (flight?.agents ?? [])
        .filter((agent) => !!agent.path)
        .map((agent) => ({ id: agent.id, name: agent.name })),
    [flight]
  );
  const [chainVerifyCommands, setChainVerifyCommands] = useState<string[]>([]);
  useEffect(() => {
    if (!project) return;
    api
      .verifyCommands(project.hash)
      .then((pairs) => setChainVerifyCommands(pairs.map(([name]) => name)))
      .catch(() => setChainVerifyCommands([]));
  }, [project]);

  // Live run progress. One run at a time on screen: a second `run_chain` while
  // one is live replaces what the canvas is watching, which is what the user
  // just asked for by starting it.
  useEffect(() => {
    const unlisten = listen<api.ChainEvent>("chain-event", ({ payload }) => {
      setChainRun((previous) => {
        const base =
          previous?.runId === payload.runId
            ? previous
            : {
                runId: payload.runId,
                chain: payload.chain,
                states: {},
                awaiting: null,
                outcome: null,
              };
        return {
          ...base,
          chain: payload.chain,
          states: payload.role && payload.state
            ? { ...base.states, [payload.role]: payload.state }
            : base.states,
          // A gate event sets it; a node starting its turn clears it, and so
          // does the run ending — approving the last gate produces an outcome
          // and no further node event, which used to leave the approve/reject
          // bar on screen after the chain had already finished.
          awaiting: payload.outcome
            ? null
            : (payload.awaitingApproval ?? (payload.state ? null : base.awaiting)),
          outcome: payload.outcome ?? base.outcome,
        };
      });
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  /** Starts a chain on the active thread, opening its canvas to watch. */
  const startChainRun = useCallback(
    async (name: string, seed: string, onThread?: ThreadMeta) => {
      // The composer's first send creates the thread it runs on, so it passes
      // that fresh one in rather than waiting for state to catch up.
      const target = onThread ?? thread;
      if (!project || !target) return;
      try {
        tabs.openChain(name);
        setChainRun({
          runId: "",
          chain: name,
          states: {},
          awaiting: null,
          outcome: null,
        });
        await api.runChain(project.hash, name, seed, target.id);
      } catch (err) {
        // A blocked run (a bound agent that isn't installed, D17) surfaces
        // here with the missing node and agent named.
        setChainRun(null);
        fail(err);
      }
    },
    [project, thread, tabs]
  );

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
      warn(payload)
    );
    // The agent's `/` menu. Keyed by thread, not session: the composer belongs
    // to the thread, and a thread can hold a spec and a go session at once.
    // The agent re-sends the whole list whenever it changes, so this replaces
    // rather than merges.
    const commanded = listen<api.AgentCommands>(
      "agent-commands",
      ({ payload }) =>
        setCommandsByThread((prev) =>
          new Map(prev).set(payload.threadId, payload.commands)
        )
    );
    return () => {
      streaming.then((un) => un());
      updated.then((un) => un());
      ambiguous.then((un) => un());
      warned.then((un) => un());
      commanded.then((un) => un());
    };
  }, [refresh, setBusyFor]);

  // Files changing for a reason that wasn't us — an agent turn writing
  // directly to disk, a branch switch, another editor. Kept as its own
  // effect (rather than folded into the executor stream above) because the
  // executor's own FileEdit events only describe what the agent *says* it
  // wrote, and say nothing about git or anything outside Palisade.
  useEffect(() => {
    const changed = listen<api.FsChanged>("fs-changed", ({ payload }) => {
      // A late event from the project the user just left would otherwise
      // refresh the new project's tree.
      if (payload.projectHash !== current.current.project?.hash) return;
      // The tree and the ⌘P palette both cache; without this they keep
      // showing files the agent already renamed or deleted.
      filesCache.current.delete(payload.projectHash);
      // Test results recorded before this write describe code that no longer
      // exists. An agent turn writing directly to disk is the most common way
      // code changes here, so staleness cannot hang off the editor's own save
      // handler alone — that only sees what the user typed.
      setLastEditAt(Date.now());
      // The same write also moves the working tree — and an agent that runs
      // `git checkout` moves HEAD with it. Everything keyed on this token
      // (dirty dot, diff pane, branch label) is stale until it bumps.
      setDiffRefreshToken((t) => t + 1);
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
      // D5: this thread's executor slot can hold a saved chain instead of an
      // agent. `goMode` has already checked the chain's agents are installed;
      // starting the run is this side's job, because the run is watched here.
      const chain = meta.executor?.startsWith(CHAIN_EXECUTOR_PREFIX)
        ? meta.executor.slice(CHAIN_EXECUTOR_PREFIX.length)
        : null;
      if (chain) {
        setBusy(false);
        // Applying an open change is go-mode work, so it is what the chain
        // is pointed at when one is linked.
        await startChainRun(
          chain,
          meta.openSpecChangeName
            ? `Apply the OpenSpec change "${meta.openSpecChangeName}".`
            : ""
        );
        return;
      }
      // #17: go-mode no longer brings a session up — `send_message` does
      // that on the user's first actual turn — so the toggle is never busy.
      setBusy(false);
    } catch (err) {
      setBusy(false);
      fail(err);
    }
  };

  // Probed model selectors, keyed by agent id. The ref is the guard against
  // double-probing (state updaters can run twice); the state mirror is what
  // re-renders the model menu.

  const probeAgentModels = useCallback(async (agentId: string) => {
    // A chain isn't an ACP agent — it's a saved sequence of them, each with
    // its own model. There's nothing for `listModels` to return, and probing
    // it anyway is what produced "unknown or unavailable agent 'chain:...'".
    if (agentId.startsWith(CHAIN_EXECUTOR_PREFIX)) return;
    const { project } = current.current;
    const existing = modelsRef.current[agentId];
    // Cached success or in-flight probe: don't re-probe. Errors retry —
    // the agent may just have been authed.
    if (existing === "loading" || (existing && "error" in existing === false))
      return;
    modelsRef.current = { ...modelsRef.current, [agentId]: "loading" };
    setModelsByAgent(modelsRef.current);
    try {
      // Null before a project is open (onboarding) — the backend probes
      // from the home directory in that case.
      const state = await api.listModels(project?.hash ?? null, agentId);
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
      // No thread yet (the chat's "New thread" state, or every tab closed):
      // there is nothing to persist onto, so the choice goes to the same
      // scratch state the new-thread flow uses and is written when the
      // thread is created. It used to return here — menu closed, label
      // unchanged, nothing written anywhere.
      if (!thread) {
        onPickFramingExecutor(agentId);
        return;
      }
      if (!project) return;
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
    [refresh, probeAgentModels, onPickFramingExecutor]
  );

  const onPickModel = useCallback(
    async (modelId: string) => {
      const { project, thread } = current.current;
      if (!thread) {
        onPickFramingModel(modelId);
        return;
      }
      if (!project) return;
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
    [refresh, flight, onPickFramingModel]
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
    const prefs = resolvePrefs(project.hash, thread.id);
    // Reuse the stored spec_type if available; otherwise the change is
    // already open so spec_type is silently dropped (D10).
    const specType = thread.specType ?? "grill-explore";
    // #17: the toggle records the mode and nothing else — no session, no
    // turn, so nothing to be busy for. The framing menu below is the one
    // path that starts anything.
    api
      .specMode(project.hash, thread.id, specType, prefs.bypass, false)
      .then(() => refresh())
      .catch(fail);
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
      .specMode(project.hash, thread.id, specType, prefs.bypass, true)
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
    // `|=<chain> <seed>` runs a saved chain instead of prompting the agent
    // (D6/D13). A name that isn't a saved chain falls through as an ordinary
    // message rather than failing — the user may just be typing.
    // The run itself happens *after* the thread-creation block below: a chain
    // needs a thread to run on, and go-mode's composer is exactly where none
    // exists yet, so bailing here made the first `|=` typed into a fresh
    // composer do nothing at all.
    const invocation = parseChainInvocation(text);
    const chainToRun =
      invocation && chains.some((c) => c.name === invocation.name)
        ? invocation
        : null;
    // D20: go-mode's empty composer has no thread yet — create it (+ set
    // go mode) on this, the first send, then fall through to the normal
    // send path below using the freshly created thread.
    let activeThread = thread;
    if (!activeThread) {
      if (pendingMode !== "go") return;
      try {
        const created = await api.createThread(project.hash, "New thread");
        activeThread = await api.setThreadMode(project.hash, created.id, "go");
        // Same persistence the Spec path does (see onPickSpecType): without
        // it the composer's provider/model pick is dropped on the floor and
        // the turn silently runs on the auto-detected agent's default model.
        const persisted = await persistFramingChoice(
          project.hash,
          created.id
        );
        if (persisted) activeThread = persisted;
        setThreads(await api.listThreads(project.hash));
        await selectThread(project.hash, activeThread);
        setPendingMode(null);
      } catch (err) {
        fail(err);
        return;
      }
    }
    if (chainToRun) {
      return void startChainRun(chainToRun.name, chainToRun.seed, activeThread);
    }
    // Shown the instant Send is hit, not once the backend round-trip
    // resolves — `sendMessage` also spawns/waits on the executor session
    // before it returns (a cold agent spawn can take seconds), so waiting
    // for its result to render the bubble made the user's own message not
    // appear until the agent's reply did. Every chat app renders the local
    // echo first and reconciles with the server's copy once it lands.
    const optimistic: api.Message = {
      seq: OPTIMISTIC_SEQ,
      ts: new Date().toISOString(),
      role: "user",
      mode: activeThread.currentMode,
      content: text,
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      setBusy(true);
      const prefs = resolvePrefs(project.hash, activeThread.id);
      // sendMessage returns the persisted user message; swap it in for the
      // optimistic placeholder instead of re-reading the whole thread. A
      // second readThread here would race with the done/thread-updated
      // handlers' refresh() on fast turns — a stale snapshot could clobber
      // the fresh one. The done handler is the single writer of the full
      // history; onSend only adds this one row.
      const sent = await api.sendMessage(
        project.hash,
        activeThread.id,
        text,
        activeThread.currentMode,
        prefs.bypass
      );
      setMessages((prev) => {
        // A fast turn may have already refreshed history (which includes
        // this message, placeholder already gone) — don't duplicate it.
        if (prev.some((m) => m.seq === sent.seq))
          return prev.filter((m) => m.seq !== OPTIMISTIC_SEQ);
        return prev.map((m) => (m.seq === OPTIMISTIC_SEQ ? sent : m));
      });
      // The first turn is also what names the thread, and that name is
      // written server-side — without re-reading, the row the user is
      // looking at keeps saying "New thread" until something else refreshes.
      api.listThreads(project.hash).then((found) => {
        setThreads(found);
        const mine = found.find((t) => t.id === activeThread.id);
        if (mine) setThread(mine);
      }, () => {});
      // Chat-only mode never answers, so never leave the composer locked.
      if (!flight?.selected) setBusy(false);
    } catch (err) {
      // The send itself failed — the optimistic echo would otherwise sit
      // there forever claiming a message was sent that never was.
      setMessages((prev) => prev.filter((m) => m.seq !== OPTIMISTIC_SEQ));
      setBusy(false);
      fail(err);
    }
  };

  // Amendment 7's **Review Working Changes**. Unlike Generate — whose answer
  // is a value for the commit box — a review is prose the user reads, so it
  // goes through the ordinary send path and lands in the conversation.
  const onReviewWorkingChanges = useCallback(async () => {
    if (!project || !thread) return;
    try {
      const diff = await api.gitWorkingDiff(project.hash);
      if (!diff.trim()) {
        fail("No working changes to review.");
        return;
      }
      const reviewText =
        "Review my working changes. Point out correctness bugs, then anything " +
        "over-built. Be specific about file and line; skip praise.";
      setMessages((prev) => [
        ...prev,
        {
          seq: OPTIMISTIC_SEQ,
          ts: new Date().toISOString(),
          role: "user",
          mode: thread.currentMode,
          content: reviewText,
        },
      ]);
      setBusy(true);
      const prefs = resolvePrefs(project.hash, thread.id);
      const sent = await api.sendMessage(
        project.hash,
        thread.id,
        reviewText,
        thread.currentMode,
        prefs.bypass
      );
      setMessages((prev) => {
        if (prev.some((m) => m.seq === sent.seq))
          return prev.filter((m) => m.seq !== OPTIMISTIC_SEQ);
        return prev.map((m) => (m.seq === OPTIMISTIC_SEQ ? sent : m));
      });
      if (!flight?.selected) setBusy(false);
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.seq !== OPTIMISTIC_SEQ));
      setBusy(false);
      fail(err);
    }
  }, [project, thread, flight?.selected]);

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
      // Listed first and listed at all so the palette documents its own way
      // in: this chord used to live only in the keyboard handler, which made
      // it the single shortcut the shortcut list didn't mention.
      {
        id: "help.commands",
        group: "Help",
        label: "Command palette (all shortcuts)",
        chord: "Mod+Shift+P",
        keywords: "help keyboard shortcuts commands keys",
        run: () => setCommandPaletteOpen(true),
      },
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
        // The chord means "hide the pane that isn't the subject", which is
        // chat in Editor and the editor column in Vibe.
        label:
          shell.centerShell === "vibe"
            ? "Toggle editor panel"
            : "Toggle chat panel",
        chord: "Mod+J",
        run: () => toggleSidePane(),
      },
      {
        // One state, two entry points: this and the rail icon both drive
        // `activePanel` — a separate "collapsed" flag would be a second
        // source of truth for the same thing.
        id: "view.leftRail",
        group: "View",
        label: "Toggle side panel",
        chord: "Mod+Backslash",
        keywords: "explorer sidebar files",
        run: () => shell.selectPanel(shell.activePanel ?? "explorer"),
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
        label: "Edit .palisade/project-settings.json",
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
      shell.toggleChat,
      shell.selectPanel,
      shell.activePanel,
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

  // Settings and Account open their existing surfaces rather than a panel;
  // History has no panel of its own yet and falls through to the thread list.
  const onSelectPanel = useCallback(
    (id: PanelId) => {
      if (id === "settings") {
        setSettingsOpen(true);
        return;
      }
      shell.selectPanel(id);
    },
    [shell.selectPanel]
  );

  const chatPanel =
    shell.centerShell === "vibe" ? shell.vibeChat : shell.rightPanel;
  // Vibe is the chat-first preset — collapsing chat there leaves the editor
  // alone on screen, which is just Editor with the panels on the wrong side.
  // So the collapse (and its toggle, and Cmd+J) applies to Editor only.
  const chatCollapsed = shell.centerShell === "editor" && shell.chatCollapsed;
  // Vibe's mirror image: chat is the subject there, so the pane you can send
  // away is the editor column. Same affordance, same chord, other side.
  const editorCollapsed =
    shell.centerShell === "vibe" && shell.editorCollapsed;
  /** Whichever pane the current preset lets you collapse. */
  const toggleSidePane =
    shell.centerShell === "vibe" ? shell.toggleEditor : shell.toggleChat;

  // The strip shows opened threads, not every thread the project has ever
  // had — a hundred threads is a hundred tabs otherwise. The active thread
  // is always in the strip, however it was selected.
  useEffect(() => {
    if (thread) shell.openThread(thread.id);
  }, [thread?.id, shell.openThread]);
  const openThreads = threads.filter(
    (t) => shell.openThreadIds.includes(t.id) && !t.archived
  );
  const onCloseThreadTab = useCallback(
    (target: ThreadMeta) => {
      shell.closeThread(target.id);
      if (target.id !== thread?.id) return;
      // Closing the visible tab moves to its neighbour, the way an editor
      // tab does — never to a blank screen with tabs still showing.
      const remaining = openThreads.filter((t) => t.id !== target.id);
      const next = remaining[remaining.length - 1] ?? null;
      if (next && project) selectThread(project.hash, next);
      else setThread(null);
    },
    [shell.closeThread, thread?.id, openThreads, project, selectThread, setThread]
  );

  // The status bar spans the shell (mockup parity), so the two things it
  // reports on — the open file's cursor and its language server — are
  // reported up from the editor pane rather than owned by it.
  const [cursorPosition, setCursorPosition] = useState<{
    line: number;
    col: number;
  } | null>(null);
  const [lspStatus, setLspStatus] = useState<api.LspStatus | null>(null);
  // The count belongs on the tab: a diagnostic nobody opens the tab to see
  // may as well not have been reported.
  const [problemCount, setProblemCount] = useState(0);
  // The newest parsed test report, shared by the Tests tab (which shows the
  // rows) and the editor gutter (which marks the failing lines) so the two
  // can never disagree about what the last run said.
  const [testReport, setTestReport] = useState<api.TestReport | null>(null);
  // Every breakpoint in the project, keyed by project-relative path. Held
  // here rather than in the debug panel: the editor gutter needs them
  // whether or not that panel is open.
  const [breakpoints, setBreakpoints] = useState<Record<string, api.Breakpoint[]>>({});
  // Where execution is stopped, so the editor can highlight the line.
  const [debugStop, setDebugStop] = useState<{ path: string; line: number } | null>(null);
  // When the project was last written to. Results from before it describe
  // code that no longer exists, and the explorer says so rather than
  // presenting them as current.
  const [lastEditAt, setLastEditAt] = useState<number | null>(null);
  // Loaded (and kept up to date) here rather than only inside the Tests tab:
  // the tab badge and the editor gutter both need the last run's results
  // whether or not that tab is open, and it mounts only when it is.
  //
  // ponytail: takes the newest run with a parsed report, whichever command
  // produced it. A project whose non-test verify commands also parse as tests
  // could see the wrong one; per-command selection if that ever shows up.
  useEffect(() => {
    if (!project) {
      setTestReport(null);
      return;
    }
    let cancelled = false;
    api
      .listVerifications(project.hash)
      .then((runs) => {
        if (cancelled) return;
        const parsed = runs.filter((run) => run.tests?.parsed);
        setTestReport(parsed.length > 0 ? parsed[parsed.length - 1].tests : null);
      })
      .catch(() => !cancelled && setTestReport(null));
    return () => {
      cancelled = true;
    };
  }, [project?.hash]);

  useEffect(() => {
    const finished = listen<api.VerificationRun>(
      "verification-finished",
      ({ payload }) => {
        if (payload.projectHash !== project?.hash) return;
        if (payload.tests?.parsed) setTestReport(payload.tests);
      }
    );
    return () => {
      finished.then((un) => un());
    };
  }, [project?.hash]);

  // Breakpoints outlive both the debug session and the app, so they are read
  // from disk on project open rather than starting empty every launch.
  useEffect(() => {
    if (!project) {
      setBreakpoints({});
      return;
    }
    let cancelled = false;
    api
      .debugBreakpoints(project.hash)
      .then((stored) => !cancelled && setBreakpoints(stored))
      .catch(() => !cancelled && setBreakpoints({}));
    return () => {
      cancelled = true;
    };
  }, [project?.hash]);

  const toggleBreakpoint = useCallback(
    (line: number) => {
      if (!project || !selectedFile) return;
      const path = selectedFile;
      api
        .debugToggleBreakpoint(project.hash, path, line)
        .then((file) => setBreakpoints((previous) => ({ ...previous, [path]: file })))
        .catch(fail);
    },
    [project?.hash, selectedFile]
  );

  // Which adapter to offer. Prefers a file that already has a breakpoint —
  // that is what Start is actually for — over the focused tab, so closing or
  // switching away from that file (DEB-08) doesn't silently disable Start.
  // Falls back to the focused file when nothing has a breakpoint yet.
  const breakpointLanguage = useMemo(() => {
    const path = Object.keys(breakpoints).find((p) => (breakpoints[p]?.length ?? 0) > 0);
    return path ? languageForPath(path) : null;
  }, [breakpoints]);
  const debugLanguage = useMemo(
    () => breakpointLanguage ?? (selectedFile ? languageForPath(selectedFile) : null),
    [breakpointLanguage, selectedFile]
  );

  const editorBreakpoints = useMemo(
    () => (selectedFile ? breakpoints[selectedFile] ?? [] : []),
    [breakpoints, selectedFile]
  );

  // Only the file that is actually stopped in gets the highlight; the same
  // line number in another file is not where execution is.
  const editorDebugLine = useMemo(
    () => (debugStop && debugStop.path === selectedFile ? debugStop.line : null),
    [debugStop, selectedFile]
  );

  // The markers for the file currently on screen. Recomputed from the same
  // report the Tests tab renders, so the gutter and the explorer can never
  // disagree about which test failed where.
  const editorTestMarkers = useMemo(
    () => (selectedFile ? markersForFile(testReport, selectedFile) : []),
    [testReport, selectedFile]
  );

  const failingTestCount = useMemo(
    () =>
      testReport?.parsed
        ? testReport.cases.filter(
            (c) => c.status === "failed" || c.status === "errored"
          ).length
        : 0,
    [testReport]
  );
  useEffect(() => {
    const refresh = () => setProblemCount(allDiagnostics().length);
    window.addEventListener(DIAGNOSTICS_CHANGED, refresh);
    refresh();
    return () => window.removeEventListener(DIAGNOSTICS_CHANGED, refresh);
  }, []);
  useEffect(() => {
    if (!selectedFile) {
      setCursorPosition(null);
      setLspStatus(null);
    }
  }, [selectedFile]);

  // Mounted ONCE and handed to the single ChatSurface. Previously these
  // props were spelled out twice — once per shell branch — which is exactly
  // how the two shells drifted apart in the first place.
  const activeExecutor =
    thread?.executor ?? framingExecutor ?? flight?.selected ?? null;
  const chatProps = {
    project,
    thread,
    messages,
    live,
    sessionId: liveSessionId,
    busy,
    worktree: thread ? worktrees.get(thread.id) : undefined,
    // The code changes themselves, in the editor column — not the Source
    // Control panel, which is where committing and pushing live.
    onViewDiff: () => {
      setDiffFocusPath(null);
      shell.setDiffOpen(true);
    },
    executor: activeExecutor,
    models: activeExecutor ? (modelsByAgent[activeExecutor] ?? null) : null,
    onPickExecutor,
    onPickModel,
    onProbeModels: () => {
      if (activeExecutor) probeAgentModels(activeExecutor);
    },
    flightSelected: !!flight?.selected,
    flight,
    // Two sources, one menu: what the agent advertises, plus the project's
    // saved chains (D14). Chains are available even with no live session.
    commands: [
      ...(thread ? (commandsByThread.get(thread.id) ?? []) : []),
      ...chainCommands(chains),
    ],
    chains,
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
    pendingMode,
    specTypePicker,
    onSpecTypeBack,
    onPickSpecType,
    composerSpecTypePicker,
    transitioning,
    framingExecutor,
    framingModel,
    onPickFramingExecutor,
    onPickFramingModel,
    onPickComposerSpecType,
    onComposerSpecTypeBack,
    // Any "no thread on screen" state, not just a brand-new project: the
    // next step is always picking a mode, so offer it rather than telling
    // the user to create a thread and leaving them to find how.
    showEmptyModePicker: !thread,
    onPickMode,
    onOpenSpec: (name: string) => tabs.openSpec(name),
    threadBypass: threadPrefs.bypass,
    onToggleBypass,
    prefsMenuOpen,
    setPrefsMenuOpen,
    hasLiveSession,
    threads: openThreads,
    onSelectThread: onSelectVibeThread,
    onCloseThread: onCloseThreadTab,
    onNewThread,
  };

  // The nine rail panels. Identical in both presets by construction — this
  // function is called from the one shared shell tree, not per branch.
  // What the centre column shows for the active tab. A function rather than a
  // ternary chain in the JSX: with file, spec, table and query tabs the chain
  // was four deep and nothing could be read at a glance.
  const renderCenterTab = () => {
    if (!project) return null;
    const tab = tabs.activeTab;
    if (tab?.type === "spec") {
      const specName = tab.specName;
      return (
        <SpecChangeTab
          projectHash={project.hash}
          specName={specName}
          verifyPins={verifyPins[specName]}
          onAddPin={(cmd) => addVerifyPin(specName, cmd)}
          onRemovePin={(cmd) => removeVerifyPin(specName, cmd)}
        />
      );
    }
    if (tab?.type === "table") {
      return (
        <Suspense fallback={<div style={{ padding: 12 }}>Loading table…</div>}>
          <DataGridTab
            projectHash={project.hash}
            connectionId={tab.connectionId}
            connectionName={tab.connectionName}
            schema={tab.schema}
            table={tab.table}
          />
        </Suspense>
      );
    }
    if (tab?.type === "query") {
      return (
        <Suspense fallback={<div style={{ padding: 12 }}>Loading editor…</div>}>
          <SqlQueryTab
            projectHash={project.hash}
            connectionId={tab.connectionId}
            connectionName={tab.connectionName}
          />
        </Suspense>
      );
    }
    if (tab?.type === "preview") {
      return (
        <PreviewPane url={tab.url} onNavigate={(url) => tabs.openPreview(url)} />
      );
    }
    if (tab?.type === "chain") {
      return (
        <ChainCanvas
          projectHash={project.hash}
          chainName={tab.chainName}
          agents={chainAgents}
          verifyCommands={chainVerifyCommands}
          onRun={thread ? (name) => void startChainRun(name, "") : undefined}
          // Only the chain that is actually running gets the watching state;
          // opening a different chain mid-run still shows a normal canvas.
          run={chainRun?.chain === tab.chainName ? chainRun : null}
        />
      );
    }
    return (
      <FileEditorPane
        projectHash={project.hash}
        path={selectedFile}
        projectName={project.displayName}
        projectRoot={project.root}
        onSave={handleFileSave}
        onDirtyChange={tabs.setDirty}
        externalChange={externalChange}
        revealLine={revealLine}
        initialCursor={selectedFile ? session?.cursors[selectedFile] : undefined}
        onCursorChange={rememberCursor}
        onCursorPosition={setCursorPosition}
        onLspStatus={setLspStatus}
        testMarkers={editorTestMarkers}
        breakpoints={editorBreakpoints}
        onToggleBreakpoint={toggleBreakpoint}
        debugLine={editorDebugLine}
        mdPreview={tabs.activeMdPreview}
        onToggleMdPreview={toggleMdPreview}
      />
    );
  };

  const renderSidePanel = () => {
    if (!project) return null;
    switch (shell.activePanel) {
      case "explorer":
        // FileTree heads itself with the project name; the panel name goes
        // above it, as in VS Code. Every other panel already announces what
        // it is, and three first-run reviewers in a row read the icon rail
        // as unlabelled glyphs — clicking one should teach you its name.
        return (
          <>
            <div className="ds-panel-head">Explorer</div>
            <div className="ds-panel-body">
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
            </div>
          </>
        );
      case "search":
        return (
          <SearchPanel
            projectHash={project.hash}
            /* Pass the line through: the sidebar search's whole point is
               landing on the match, not the top of the file. */
            onOpenMatch={selectFile}
            onError={fail}
          />
        );
      case "git":
        return (
          <SourceControlPanel
            projectHash={project.hash}
            threadId={thread?.id ?? null}
            /* The panel reads and writes the thread's worktree, so it has to
               name that worktree's branch — the project root's current
               branch is a different tree and would put the wrong name on the
               commit button. */
            branch={
              (thread ? worktrees.get(thread.id)?.branch : undefined) ??
              branches.find((b) => b.isCurrent)?.name ??
              "HEAD"
            }
            refreshToken={diffRefreshToken}
            onOpenFile={openDiffFor}
            onReviewWorkingChanges={onReviewWorkingChanges}
            onChanged={() => setDiffRefreshToken((t) => t + 1)}
            onError={fail}
          />
        );
      case "specs":
        return (
          <>
            <div className="ds-panel-head">Specs</div>
            <div className="ds-panel-body">
              <SpecPane
                projectHash={project.hash}
                threadId={thread?.id}
                linkedChange={thread?.openSpecChangeName}
                onOpenSpec={(name) => tabs.openSpec(name)}
              />
            </div>
          </>
        );
      case "codemap":
        return (
          <>
            <div className="ds-panel-head">Codebase Map</div>
            <div className="ds-panel-body">
              <Suspense fallback={<div style={{ padding: 12 }}>Loading map…</div>}>
                <GraphPane projectHash={project.hash} />
              </Suspense>
            </div>
          </>
        );
      case "run":
        return (
          <>
            <RunPanel
              projectHash={project.hash}
              onRun={runCommand}
              onChanged={() => setRunReloadToken((n) => n + 1)}
              onError={fail}
            />
            {/* Verify commands are a different thing (evidence a spec is
                green, not a shortcut) but they are still project commands,
                so they share the panel rather than a tenth rail icon. */}
            <div className="ds-panel-body">
              <h2 className="ds-section-heading">Verification</h2>
              <VerifyPane projectHash={project.hash} threadId={thread?.id} />
              {/* The debugger shares this panel for the same reason verify
                  does: it is a project command surface, and the rail's icon
                  groups are deliberately capped at four. */}
              <h2 className="ds-section-heading">Debug</h2>
              <DebugPanel
                projectHash={project.hash}
                language={debugLanguage}
                onOpen={openAtLine}
                onStoppedAt={(path, line) => setDebugStop(path && line ? { path, line } : null)}
                onBreakpointsChange={setBreakpoints}
                breakpoints={breakpoints}
              />
            </div>
          </>
        );
      case "mcp":
        return <McpPane projectHash={project.hash} onError={fail} />;
      case "database":
        return (
          <Suspense fallback={<div style={{ padding: 12 }}>Loading…</div>}>
            <DatabasePanel
              projectHash={project.hash}
              onOpenTable={(connection, schema, table) =>
                tabs.openTable(connection.id, connection.name, schema, table)
              }
              onOpenQuery={(connection) =>
                tabs.openQuery(connection.id, connection.name)
              }
            />
          </Suspense>
        );
      case "chains":
        return (
          <ChainsPanel
            projectHash={project.hash}
            onOpen={(name) => tabs.openChain(name)}
            onRun={thread ? (name) => void startChainRun(name, "") : undefined}
          />
        );
      case "history":
        return (
          <>
            <div className="ds-panel-head">History</div>
            <div className="ds-panel-body">
              <ThreadList
                variant="editor"
                threads={threads}
                activeThread={thread}
                project={project}
                onNewThread={onNewThread}
                onSelect={onSelectEditorThread}
                onRename={onRenameThread}
                onDelete={onDeleteThread}
                onArchive={onArchiveThread}
              />
              {/* THR-12/THR-13: sessions are a different thing from threads
                  (CLAUDE.md's Thread-vs-Session model) — this is the only
                  place busy/idle state and agent attribution per session
                  are inspectable. */}
              <h2 className="ds-section-heading">Sessions</h2>
              <Suspense fallback={<div style={{ padding: 12 }}>Loading…</div>}>
                <SessionsPanel projectHash={project.hash} threads={threads} />
              </Suspense>
            </div>
          </>
        );
      case "workspace":
        return (
          <>
            <div className="ds-panel-head">Workspace</div>
            <div className="ds-panel-body">
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
            </div>
          </>
        );
      default:
        return null;
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
          <h1 className="sr-only">Palisade Code</h1>
          {/* Amendment 8: no shell switch before a project is open — there
              is nothing for either preset to arrange yet. */}
          {project && (
            <div
              className="ds-shell-toggle"
              data-testid="shell-toggle"
              data-tauri-drag-region-exclude
            >
              {/* "Vibe" and "Editor" say nothing to someone who has never
                  used this app — a first-run reviewer listed both as
                  unexplained jargon. The names stay (they're the product's
                  own), but a tooltip only pays out on hover, so the glyph
                  carries the same distinction for someone just looking:
                  speech bubble = chat leads, brackets = code leads. */}
              <Tooltip label="Vibe — chat first, code alongside it">
                <button
                  className={shell.centerShell === "vibe" ? "active" : ""}
                  onClick={() => shell.setCenterShell("vibe")}
                  aria-label="Vibe layout: chat first, code alongside it"
                  data-testid="shell-vibe"
                >
                  <IconMessageDots size={13} stroke={1.8} aria-hidden="true" />
                  Vibe
                </button>
              </Tooltip>
              <Tooltip label="Editor — code first, chat alongside it">
                <button
                  className={shell.centerShell === "editor" ? "active" : ""}
                  onClick={() => shell.setCenterShell("editor")}
                  aria-label="Editor layout: code first, chat alongside it"
                  data-testid="shell-editor"
                >
                  <IconCode size={13} stroke={1.8} aria-hidden="true" />
                  Editor
                </button>
              </Tooltip>
            </div>
          )}
          {/* Vibe preset only: chat is the primary surface there, so the
              reclaimable width is the session list's, not the chat rail's. */}
          {project && shell.centerShell === "vibe" && (
            <Tooltip
              label={
                attentionThreads.size > 0
                  ? `${attentionThreads.size} thread${attentionThreads.size === 1 ? "" : "s"} waiting on you`
                  : "Toggle session list"
              }
            >
              <Indicator
                label={attentionThreads.size}
                size={16}
                color="var(--danger)"
                disabled={shell.sessionListOpen || attentionThreads.size === 0}
                data-testid="session-list-attention-badge"
              >
                <ActionIcon
                  variant="subtle"
                  className="ds-icon-btn"
                  onClick={shell.toggleSessionList}
                  aria-label="Toggle session list"
                  aria-pressed={shell.sessionListOpen}
                  data-testid="toggle-session-list"
                  data-tauri-drag-region-exclude
                >
                  <IconLayoutSidebar size={14} />
                </ActionIcon>
              </Indicator>
            </Tooltip>
          )}
          <div className="ds-chrome-utils">
            <BetaBadge />
            {/* Amendment 1's split button: project-scoped, not file-scoped.
                Primary action is the last command run (first configured
                until you run one); the chevron lists them all. Nothing
                configured means no button — the Run panel is where an empty
                project sets one up. */}
            {project && runList.length > 0 && (
              <div className="ds-run-split" data-tauri-drag-region-exclude>
                {(() => {
                  const remembered = runList.find(([n]) => n === runLast);
                  const [name, command] = remembered ?? runList[0];
                  return (
                    <Tooltip
                      label={`${
                        remembered ? "Run again" : "Run"
                      }: ${command}`}
                    >
                      <button
                        className="ds-icon-btn ds-run-primary"
                        onClick={() => runCommand(name, command)}
                        data-testid="run-primary"
                      >
                        <IconPlayerPlay size={13} />
                        {name}
                      </button>
                    </Tooltip>
                  );
                })()}
                <Menu withinPortal position="bottom-end">
                  <Menu.Target>
                    <ActionIcon
                      variant="subtle"
                      className="ds-icon-btn ds-run-chevron"
                      aria-label="Run commands"
                      data-testid="run-menu"
                    >
                      <IconChevronDown size={12} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>Run</Menu.Label>
                    {runList.map(([name, command]) => (
                      <Menu.Item
                        key={name}
                        onClick={() => runCommand(name, command)}
                        data-testid={`run-opt-${name}`}
                      >
                        {name}
                        <span className="ds-run-command"> {command}</span>
                      </Menu.Item>
                    ))}
                    <Menu.Divider />
                    <Menu.Item onClick={() => shell.selectPanel("run")}>
                      Configure…
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </div>
            )}
            {/* Amendment 9: one state, two entry points — this and the
                bottom panel's own inline chevron both call toggleTerminal.
                Both panel toggles need a project to have a panel at all. */}
            {project && (
            <Tooltip label="Toggle terminal panel (Cmd+`)">
              <ActionIcon
                variant="subtle"
                className="ds-icon-btn"
                onClick={shell.toggleTerminal}
                aria-label="Toggle terminal panel"
                aria-pressed={!shell.terminalPanel.collapsed}
                data-testid="toggle-terminal"
                data-tauri-drag-region-exclude
              >
                <IconLayoutBottombar size={14} />
              </ActionIcon>
            </Tooltip>
            )}
            {/* Each preset can send away its secondary pane: chat in Editor,
                the editor column in Vibe. Same chord, same corner, the icon
                points at whichever side actually collapses. */}
            {project && shell.centerShell === "editor" && (
              <Tooltip label="Toggle chat panel (Cmd+J)">
                <ActionIcon
                  variant="subtle"
                  className="ds-icon-btn"
                  onClick={shell.toggleChat}
                  aria-label="Toggle chat panel"
                  aria-pressed={!shell.chatCollapsed}
                  data-testid="toggle-chat"
                  data-tauri-drag-region-exclude
                >
                  <IconLayoutSidebarRightFilled size={14} />
                </ActionIcon>
              </Tooltip>
            )}
            {project && shell.centerShell === "vibe" && (
              <Tooltip label="Toggle editor panel (Cmd+J)">
                <ActionIcon
                  variant="subtle"
                  className="ds-icon-btn"
                  onClick={shell.toggleEditor}
                  aria-label="Toggle editor panel"
                  aria-pressed={!shell.editorCollapsed}
                  data-testid="toggle-editor"
                  data-tauri-drag-region-exclude
                >
                  <IconLayoutSidebarRightFilled size={14} />
                </ActionIcon>
              </Tooltip>
            )}
            <Tooltip label="Theme: click to cycle auto → light → dark">
              <ActionIcon
                variant="subtle"
                className="ds-icon-btn"
                onClick={() => shell.setTheme(shell.nextTheme(shell.theme))}
                aria-label={`Theme: ${shell.theme}`}
                data-testid="theme-toggle"
                data-tauri-drag-region-exclude
              >
                <IconSunMoon size={14} />
              </ActionIcon>
            </Tooltip>
            {/* The only always-visible way in to the command list. Every
                shortcut this app has was previously reachable only by
                already knowing a shortcut, which is fine for the person who
                wrote them and a dead end for anyone else. */}
            <Tooltip label="Commands and shortcuts (Cmd+Shift+P)">
              <ActionIcon
                variant="subtle"
                className="ds-icon-btn"
                onClick={() => setCommandPaletteOpen(true)}
                aria-label="Commands and shortcuts"
                data-testid="open-commands"
                data-tauri-drag-region-exclude
              >
                <IconCommand size={14} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Settings">
              <ActionIcon
                variant="subtle"
                className="ds-icon-btn"
                onClick={() => setSettingsOpen(true)}
                aria-label="Settings"
                data-testid="open-settings"
                data-tauri-drag-region-exclude
              >
                <IconSettings size={14} />
              </ActionIcon>
            </Tooltip>
          </div>
        </header>
        {flight && flight.warnings.length > 0 && (
          <Alert
            color="warn"
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
            color="warn"
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
            className={e.tone === "warn" ? "error warn" : "error"}
            data-tone={e.tone}
            onClick={() => dismissError(e.id)}
            data-testid="error"
          >
            {e.message} <span className="dismiss">dismiss</span>
          </div>
        ))}

        <div className="body">
          {/* Amendment 8: with no project open there is nothing for either
              preset to arrange, so this screen stands outside the Governing
              Rule entirely rather than rendering an empty shell. */}
          {!project ? (
            <OnboardingScreen
              projects={projects}
              flight={flight}
              /* Reuses the framing-menu state (D21) — the same "chosen
                 before a thread exists" slot the in-thread empty composer
                 uses, so the pick carries into the go-mode thread
                 onOnboardingComposerSend creates rather than being a
                 throwaway. */
              executor={framingExecutor}
              model={framingModel}
              models={
                modelsByAgent[framingExecutor ?? flight?.selected ?? ""]
              }
              agentModels={modelsByAgent}
              onPickExecutor={onPickFramingExecutor}
              onPickModel={onPickFramingModel}
              onProbeAgent={probeAgentModels}
              onOpenProject={onAddProject}
              onCloneRepository={onCloneRepository}
              onComposerSend={onOnboardingComposerSend}
              onSelectProject={selectProject}
              openingHash={openingProject}
            />
          ) : (
            // ONE shell, two arrangements (Governing Rule). The same children
            // are mounted in both presets; `data-preset` flips their CSS
            // `order` so the rail and its panel sit at the right edge in Vibe
            // and the left edge in Editor. There is deliberately no
            // Vibe-only or Editor-only panel — the only preset-conditional
            // children are the session list and the chat-collapse control,
            // which are affordances, not panels.
          <div
            className="ds-shell-contents"
            data-preset={shell.centerShell}
            data-chat={chatCollapsed ? "collapsed" : undefined}
            data-editor={editorCollapsed ? "collapsed" : undefined}
            data-testid={
              shell.centerShell === "vibe" ? "vibe-shell" : "editor-shell"
            }
          >
            {shell.centerShell === "vibe" && shell.sessionListOpen && (
              <SessionList
                threads={threads}
                projects={projects}
                activeProject={project ?? undefined}
                activeThread={thread ?? undefined}
                /* `busyThreads` is already exactly "threads with a live
                   session" — no second derivation of the same state. */
                liveThreadIds={busyThreads}
                attentionThreadIds={attentionThreads}
                worktrees={worktrees}
                onNewThread={onNewThread}
                onSelect={onSelectVibeThread}
                onRename={onRenameThread}
                onArchive={onArchiveThread}
              />
            )}

            <NavRail
              activePanel={shell.activePanel}
              onSelect={onSelectPanel}
              dirtyGit={dirtyCount > 0}
            />

            {shell.activePanel && (
              <div
                className="ds-side-panel"
                data-testid="side-panel"
                data-panel={shell.activePanel}
                style={
                  {
                    "--panel-w": `${shell.leftRail.size}px`,
                  } as CSSProperties
                }
              >
                {renderSidePanel()}
              </div>
            )}

            {shell.activePanel && (
              <div
                className="ds-resize-handle ds-resize-handle-x"
                data-testid="resize-left-rail"
                onPointerDown={bindDrag(
                  shell.leftRail.handleProps,
                  "col-resize"
                )}
              />
            )}

            <div className="ds-main" data-testid="main-pane">
              <div className="ds-work-row">
                {!editorCollapsed && (
                <main className="ds-editor-col" data-testid="editor-col">
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
                    onNewFile={newFileAtRoot}
                    onNewPreview={() => {
                      shell.setDiffOpen(false);
                      tabs.openPreview();
                    }}
                    onNewChain={() => {
                      shell.setDiffOpen(false);
                      tabs.openChain(null);
                    }}
                  />
                  {!shell.diffOpen ? (
                    renderCenterTab()
                  ) : (
                    <div className="messages" data-testid="messages">
                      {project && (
                        <DiffPane
                          projectHash={project.hash}
                          /* The agent writes in this thread's worktree, so
                             that is the tree to show — the project root has
                             none of its edits. */
                          threadId={thread?.worktreePath ? thread.id : undefined}
                          refreshToken={diffRefreshToken}
                          focusPath={diffFocusPath}
                          onClearFocus={() => setDiffFocusPath(null)}
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
                              executor={flight?.selected ?? null}
                            />
                          </section>
                        );
                      })()}
                    </div>
                  )}
                </main>
                )}

                {!chatCollapsed && (
                  <>
                    {/* The Governing Rule allows the two presets to differ
                        by default width, and they must: a 520px chat is the
                        subject in Vibe and swamps the editor in Editor.
                        Two resizables, so a drag in one preset doesn't
                        resize the other. */}
                    {/* Nothing to size against once the other pane is gone. */}
                    {!editorCollapsed && (
                      <div
                        className="ds-resize-handle ds-resize-handle-x"
                        data-testid="resize-right-panel"
                        onPointerDown={bindDrag(
                          chatPanel.handleProps,
                          "col-resize"
                        )}
                      />
                    )}
                    <aside
                      className="ds-chat-rail"
                      data-testid="right-sidebar"
                      style={
                        {
                          "--panel-w": `${chatPanel.size}px`,
                        } as CSSProperties
                      }
                    >
                      <ChatSurface {...chatProps} />
                    </aside>
                  </>
                )}
              </div>

              {/* Hidden rather than unmounted while collapsed: unmounting
                  disposes the xterm instance, so every collapse threw away
                  the scrollback and re-spawned the shell on reopen. */}
              <div
                className="ds-bottom-panel"
                data-testid="bottom-panel"
                hidden={shell.terminalPanel.collapsed}
                style={
                  {
                    "--terminal-h": `${shell.terminalPanel.size}px`,
                    display: shell.terminalPanel.collapsed ? "none" : undefined,
                  } as CSSProperties
                }
              >
                <div
                  className="ds-resize-handle ds-resize-handle-y"
                  data-testid="resize-terminal-panel"
                  onPointerDown={bindDrag(
                    shell.terminalPanel.handleProps,
                    "row-resize"
                  )}
                />
                <Tabs
                  className="ds-bp-tabs-root"
                  variant="unstyled"
                  value={shell.bottomTab}
                  keepMounted={false}
                  onChange={(v) =>
                    v && shell.setBottomTab(v as "terminal" | "problems" | "tests")
                  }
                >
                  <div className="ds-bp-tabs">
                    <Tabs.List>
                      <Tabs.Tab
                        value="terminal"
                        className="ds-bp-tab"
                        leftSection={<IconTerminal2 size={13} />}
                        data-testid="bp-tab-terminal"
                      >
                        Terminal
                      </Tabs.Tab>
                      <Tabs.Tab
                        value="tests"
                        className="ds-bp-tab"
                        leftSection={<IconFlask size={13} />}
                        rightSection={
                          failingTestCount > 0 ? (
                            <span
                              className="ds-bp-count"
                              data-testid="bp-test-count"
                            >
                              {failingTestCount}
                            </span>
                          ) : undefined
                        }
                        data-testid="bp-tab-tests"
                      >
                        Tests
                      </Tabs.Tab>
                      <Tabs.Tab
                        value="problems"
                        className="ds-bp-tab"
                        leftSection={<IconAlertTriangle size={13} />}
                        rightSection={
                          problemCount > 0 ? (
                            <span
                              className="ds-bp-count"
                              data-testid="bp-problem-count"
                            >
                              {problemCount}
                            </span>
                          ) : undefined
                        }
                        data-testid="bp-tab-problems"
                      >
                        Problems
                      </Tabs.Tab>
                    </Tabs.List>
                    <div className="ds-bp-spacer" />
                    {shell.bottomTab === "terminal" && (
                      <Tooltip label="Move terminal to the sidebar" withinPortal>
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          aria-label="Move terminal to the sidebar"
                          onClick={shell.toggleTerminalPlacement}
                          data-testid="terminal-placement-toggle"
                        >
                          <IconLayoutSidebarRight size={14} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    <Tooltip label="Collapse panel" withinPortal>
                      <ActionIcon
                        variant="subtle"
                        size="sm"
                        aria-label="Collapse panel"
                        onClick={shell.toggleTerminal}
                        data-testid="bp-collapse"
                      >
                        <IconChevronDown size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </div>
                  <div className="ds-bp-content">
                    {/* keepMounted on this panel only: the terminal must stay
                        mounted while hidden, since unmounting disposes the pty
                        and kills whatever is running in it. Problems has no
                        such state, so it mounts/unmounts with the tab. */}
                    <Tabs.Panel value="terminal" keepMounted className="ds-bp-pane">
                      {project && terminalEverOpened.current && (
                        <TerminalTabs
                          projectHash={project.hash}
                          onActiveTerminalChange={setActiveTerminalId}
                        />
                      )}
                    </Tabs.Panel>
                    <Tabs.Panel value="tests" className="ds-bp-pane">
                      {project && (
                        <TestExplorer
                          projectHash={project.hash}
                          threadId={thread?.id}
                          lastEditAt={lastEditAt}
                          onOpen={(path, line) => openAtLine(path, line)}
                        />
                      )}
                    </Tabs.Panel>
                    <Tabs.Panel value="problems" className="ds-bp-pane">
                      <ProblemsPane onOpen={selectFile} />
                    </Tabs.Panel>
                  </div>
                </Tabs>
              </div>
            </div>
          </div>
          )}
        </div>

        {/* Outside `.body` (a flex row) so it spans the window rather than
            becoming another column — full width, under everything, in both
            presets (mockup parity). */}
        {project && (
          <EditorStatusBar
            language={languageLabelFor(selectedFile)}
            lsp={lspStatus}
            cursor={cursorPosition}
          />
        )}

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
            <TextInput
              id="barInput"
              name="barInput"
              autoFocus
              autoComplete="off"
              defaultValue={bar.value}
              placeholder={bar.value ? undefined : bar.placeholder}
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
            <span className="hint" style={{ display: "block", marginTop: 8 }}>
              Enter to confirm · Esc to cancel
            </span>
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
              ).map((name) => {
                // Only a real local, non-current branch can be deleted —
                // remote-only entries here are DWIM checkout targets, not
                // branches that exist locally to delete (GIT-14).
                const local = branches.find(
                  (b) => !b.isRemote && b.name === name
                );
                // Git allows a branch in exactly one worktree, so this row
                // cannot switch — it opens the tree the branch already lives
                // in. Said on the row rather than after the click: an action
                // that silently does something else is worse than one that
                // fails. Deleting is off the table for the same reason git
                // refuses it — the branch is in use.
                const worktree = worktreeBranches.get(name);
                return (
                  <li
                    key={name}
                    role="button"
                    tabIndex={0}
                    onClick={() => bar.submit(name)}
                    onKeyDown={onActivateKey(() => bar.submit(name))}
                    data-testid="branch-option"
                    aria-label={
                      worktree
                        ? `${name} — open its worktree at ${worktree}`
                        : name
                    }
                  >
                    <span className="ds-branch-name" title={name}>
                      {name}
                    </span>
                    {worktree && (
                      <Tooltip
                        label={`Checked out in ${worktree} — opens that worktree`}
                        openDelay={300}
                        withinPortal
                      >
                        <Badge
                          size="xs"
                          variant="default"
                          tt="none"
                          ff="var(--mono)"
                          leftSection={<IconFolders size={10} />}
                          data-testid="branch-worktree-badge"
                        >
                          worktree
                        </Badge>
                      </Tooltip>
                    )}
                    {local && !local.isCurrent && !worktree && (
                      <button
                        className="ds-branch-delete"
                        onClick={(event) => {
                          event.stopPropagation();
                          setBar({
                            kind: "confirm",
                            label: `Delete branch "${name}"? This can't be undone.`,
                            onConfirm: async () => {
                              setBar(null);
                              if (!project) return;
                              try {
                                await api.gitDeleteBranch(project.hash, name);
                                await refreshBranches(project.hash);
                              } catch (err) {
                                fail(err);
                              }
                            },
                          });
                        }}
                        title="Delete branch"
                        aria-label={`Delete branch ${name}`}
                        data-testid="branch-delete"
                      >
                        <DeleteIcon />
                      </button>
                    )}
                  </li>
                );
              })}
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
              Click a branch to switch · Enter a name to create · Esc to
              cancel
              {worktreeBranches.size > 0 && (
                <> · a branch marked <b>worktree</b> opens that worktree</>
              )}
            </span>
          </MantineModal>
        )}
      </div>
    </div>
  );
}
