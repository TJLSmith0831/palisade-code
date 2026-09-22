import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  Skeleton,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconFlask,
  IconBolt,
  IconBox,
  IconAppWindow,
  IconChevronDown,
  IconClockPause,
  IconDots,
  IconTrash,
  IconBrandTelegram,
  IconListCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCommand,
  IconFile,
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
  IconPencil,
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
import { resolvePrefs, useThreadPrefs } from "./hooks/useThreadPrefs";
import { useNewThreadFlow } from "./hooks/useNewThreadFlow";
import { useThreadActions } from "./hooks/useThreadActions";
import { ArchiveIcon, ArchivingContext } from "./archiving";
import { useAppCommands } from "./hooks/useAppCommands";
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
import { describeError, errorKind, isAuthError } from "./errors";
import { fuzzyMatch } from "./fuzzyMatch";
import { useMessageQueue, type QueuedMessage } from "./hooks/useMessageQueue";
import { applyMention, mentionAt, rankMentions } from "./mentions";
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
import ChainsPanel, { CHAINS_CHANGED_EVENT, announceChainsChanged } from "./ChainsPanel";
import { CHAIN_EXECUTOR_PREFIX } from "./api";
import ChainCanvas from "./ChainCanvas";
import ChainRunCard, { type ChainRunCardView } from "./ChainRunCard";
import { deriveStage, type SpecStage } from "./stage";
import { RenameIcon, DeleteIcon } from "./icons";
import {
  EventList,
  filterForTab,
  itemsFromMessages,
  mergeDeltas,
  scrollToSession,
} from "./EventView";
import FileEditorPane, {
  evictEditorSession,
  evictProjectSessions,
} from "./FileEditorPane";
import TabBar from "./TabBar";
import PreviewPane from "./PreviewPane";
import { useDevServers } from "./useDevServers";
import DevServerChips from "./DevServerChips";
import { useLinkRouting } from "./linkRouting";
import { isMarkdownPath, tabKey, useOpenTabs } from "./openTabs";
import { loadSession, saveSession, type EditorSession } from "./session";
import CommandPalette from "./CommandPalette";
import { matchesChord } from "./commands";
import { createCommandBridge, type CommandHandler } from "./nativeMenu";

import FilePalette from "./FilePalette";
import TextSearchPalette from "./TextSearchPalette";
import FileTree from "./FileTree";
import { useFileTreeCache } from "./FileTreeCache";
import DiffPane from "./DiffPane";
import LiveFileChips from "./LiveFileChips";
import MergeGate from "./MergeGate";
import EditorEmptyState from "./EditorEmptyState";
/** Offered on an empty thread. Ordinary asks a developer has on day one
 * with an unfamiliar codebase, phrased so they work in either mode. */
const STARTER_PROMPTS = [
  "Explain how this project is structured",
  "Find and fix the failing tests",
  "Review my uncommitted changes",
];

import SpecPane from "./SpecPane";
import McpPane from "./McpPane";
import ConnectionsPanel from "./ConnectionsPanel";
import FirstRunChecklist from "./FirstRunChecklist";
import { notifyTurnDone } from "./turnNotifications";
// Lazy: the database surfaces pull in CodeMirror's SQL grammar and a grid
// nobody loads until they open the panel.
const DatabasePanel = lazy(() => import("./DatabasePanel"));
const SessionsPanel = lazy(() => import("./SessionsPanel"));
const DataGridTab = lazy(() => import("./DataGridTab"));
const SqlQueryTab = lazy(() => import("./SqlQueryTab"));
const NotebookTab = lazy(() => import("./NotebookTab"));
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
  loadGlobalAppearance,
  PROJECT_SETTINGS_FILE,
} from "./SettingsPanel";
import TerminalTabs, { firstTerminalId } from "./TerminalTabs";
import TestExplorer from "./TestExplorer";
import DebugPanel from "./DebugPanel";
import { markersForFile, resolveTestPath } from "./testGutter";
import { languageForPath } from "./lsp";
import OnboardingScreen from "./OnboardingScreen";
import NavRail from "./NavRail";
import FleetBoard, { type NewRunInput } from "./FleetBoard";
import WorktreeModeBadge from "./WorktreeModeBadge";
import ReviewPane, { type ReviewFile } from "./ReviewPane";
import ReviewRunList from "./ReviewRunList";
import { useFleet } from "./hooks/useFleet";
import SessionList from "./SessionList";
import { VerifyBadge } from "./fleetBadges";
import { MODE_SELECTOR_STYLES } from "./modeSelectorStyles";
import SearchPanel from "./SearchPanel";
import SourceControlPanel from "./SourceControlPanel";
import type { PanelId } from "./hooks/useAppShell";
import { openUrl } from "@tauri-apps/plugin-opener";
import { enableModernWindowStyle } from "./macRoundedCorners";
import { type UseResizableResult } from "./useResizable";
import "./App.css";

/** Native menu events are addressed to one window's label. A listener that
 * registers no target hears *every* emit, whichever window it was meant for,
 * so scoping here is what keeps a menu command in the window that ran it. */
const nativeEventTarget = () => ({ target: getCurrentWindow().label });

// Shared chat surface: mounted as the Vibe shell's main column and as the
// Editor shell's right-rail chat area (see openspec/changes/
// vibe-editor-shell-redesign design.md Decision 2 — one component, two
// mount points, rather than shell-specific duplicates). Shows the inline
// Vibe/Spec new-thread picker in place of the thread view when active.
type ChatSurfaceProps = {
  project: Project | null;
  /** Project switch is still fetching threads; keep the old empty state hidden. */
  loading?: boolean;
  /** This thread's history is still being read; show a skeleton, not "What are we building?". */
  historyLoading?: boolean;
  /** Older messages exist beyond what is on screen. */
  hasEarlier?: boolean;
  /** Fetch and prepend the next page of older messages. */
  onLoadEarlier?: () => Promise<void>;
  /** Threads whose title is still being written in the background. */
  titlePendingIds?: Set<string>;
  thread: ThreadMeta | null;
  messages: Message[];
  live: ExecutorEvent[];
  /** The live session id for this thread, if any — needed to resolve a
   *  pending permission-approval prompt against the right session. */
  sessionId: string | null;
  /** A permission prompt was answered in the chat surface. */
  onPermissionAnswered?: (requestId: string) => void;
  busy: boolean;
  /** This thread's isolated worktree, absent until its first session runs
   *  and for every thread in a non-git project. */
  worktree?: api.WorktreeStatus;
  /** This thread's latest verification, from the same fleet rows the board
   *  reads. Absent while no project is open. */
  verify?: api.FleetVerify;
  /** Opens the Source Control panel on this thread's worktree. */
  onViewDiff?: () => void;
  /** Archive this thread — the merge gate offers it once work has landed. */
  onArchiveSelf?: () => void;
  /** The worktree changed (a commit, a merge): re-poll the thread stats. */
  onWorktreeChanged?: () => void;
  /** Raise a message in the app's own error banner. */
  onError?: (message: string) => void;
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
  /** #32: every file in the project, for the `@` mention menu. */
  mentionFiles?: string[];
  /** #32: the mention menu opened — load the file list if it isn't cached. */
  onOpenMentions?: () => void;
  /** #26: messages typed during a turn, waiting for it to end. */
  queued?: QueuedMessage[];
  /** Drop a queued message without ever sending it. */
  onRemoveQueued?: (id: string) => void;
  /** Send a queued message again after it failed. */
  onRetryQueued?: (id: string) => void;
  /** Stop the live session for this thread. */
  onStop: () => void;
  onRenameThread: (target: ThreadMeta) => void;
  onSpec: () => void;
  onGo: () => void;
  /** "Apply" — fires grill-apply one-shot in ready_to_apply stage. */
  onApply: () => void;
  agentLogins?: api.AgentLogin[];
  agentLoginsFor?: (crashText: string) => api.AgentLogin[];
  onAgentLogin?: (login: api.AgentLogin) => void;
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
  /** D5: spec-type selection starts grill-explore. The card is the framing;
   *  `description` is what the user actually asked for (Kiro's model). */
  onPickSpecType?: (specType: string, description: string) => void;
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
  onPickComposerSpecType?: (specType: string, description: string) => void;
  /** D13: Back button on the composer-toggle framing menu returns to the chat. */
  onComposerSpecTypeBack?: () => void;
  onPickMode: (mode: api.Mode) => void;
  onOpenSpec?: (specName: string) => void;
  threadBypass: boolean;
  onToggleBypass: () => void;
  /** Whether this thread runs in its own worktree. Decided at creation and
   *  locked once the thread has run — the directory an agent is writing in
   *  cannot move underneath it. */
  worktreeEnabled?: boolean;
  worktreeLocked?: boolean;
  onToggleWorktree?: () => void;
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
  /** The chat live run card (D-h): set only while a chain run's invoking
   *  thread is the one on screen, so a run started elsewhere never bleeds
   *  into this thread's chat. */
  chainRun?: ChainRunCardView | null;
  onChainTranscript?: (sessionId: string) => void;
  onChainGateResolved?: (decision: "approve" | "sendBack" | "reject") => void;
  onChainOpenRun?: (runId: string) => void;
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

/**
 * The three ways a spec conversation can be framed (#35).
 *
 * A card is a framing, not the request: it pre-wires the questions that kind
 * of work always has to answer, and the user still says what they want. This
 * is Kiro's model — pick Spec, then describe the work — and it is why picking
 * a card no longer starts an agent turn on its own.
 */
const SPEC_FRAMINGS = [
  {
    id: "Feature",
    blurb:
      "Build something new — a capability, screen, or integration that doesn't exist yet.",
    label: "What do you want to build?",
    placeholder:
      "e.g. a CSV export on the reports page, so finance can hand numbers to their auditor",
  },
  {
    id: "Bugfix",
    blurb:
      "Diagnose and fix — trace a broken behavior to its root cause before changing code.",
    label: "What's going wrong?",
    placeholder:
      "e.g. the login redirect loops on Safari once a session cookie has expired",
  },
  {
    id: "Other",
    blurb:
      "Open-ended — describe your own framing and the agent will explore from there.",
    label: "What should this spec cover?",
    placeholder:
      "e.g. whether to move the job queue off Postgres before the next launch",
  },
] as const;

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

/** Chevron that collapses the thread pane to a rail and back. The tooltip is
 *  controlled: an uncontrolled one stays open after the click (the pointer is
 *  still over the button, and the label under it has just changed) until you
 *  leave and re-enter, so the click closes it and hover/keyboard focus reopen. */
function ChatPaneToggle({
  collapsed,
  editorCollapsed,
  onToggle,
}: {
  collapsed: boolean;
  editorCollapsed: boolean;
  onToggle: () => void;
}) {
  const [tipOpen, setTipOpen] = useState(false);
  return (
    <Tooltip
      opened={tipOpen}
      label={
        editorCollapsed
          ? "Show the editor to collapse the thread"
          : collapsed
            ? "Expand thread (⌘⇧J)"
            : "Collapse thread (⌘⇧J)"
      }
      position="right"
    >
      <ActionIcon
        variant="subtle"
        size="sm"
        className="ds-chat-rail-toggle"
        aria-label={collapsed ? "Expand thread" : "Collapse thread"}
        aria-expanded={!collapsed}
        disabled={editorCollapsed}
        onMouseEnter={() => setTipOpen(true)}
        onMouseLeave={() => setTipOpen(false)}
        onFocus={(event) => setTipOpen(event.currentTarget.matches(":focus-visible"))}
        onBlur={() => setTipOpen(false)}
        onClick={(event) => {
          event.stopPropagation();
          setTipOpen(false);
          onToggle();
        }}
        data-testid="toggle-chat-pane"
      >
        {collapsed ? <IconChevronRight size={14} /> : <IconChevronLeft size={14} />}
      </ActionIcon>
    </Tooltip>
  );
}

export const ChatSurface = memo(
  function ChatSurface({
    project,
    thread,
    messages,
    live,
    sessionId,
    onPermissionAnswered,
    busy,
    worktree,
    verify,
    onViewDiff,
    onArchiveSelf,
    onWorktreeChanged,
    onError,
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
    mentionFiles = [],
    onOpenMentions,
    queued = [],
    onRemoveQueued,
    onRetryQueued,
    onStop,
    onRenameThread,
    onSpec,
    onGo,
    onApply,
    agentLogins,
    agentLoginsFor,
    onAgentLogin,
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
    worktreeEnabled = true,
    worktreeLocked = false,
    onToggleWorktree,
    prefsMenuOpen,
    setPrefsMenuOpen,
    hasLiveSession,
    threads = [],
    onSelectThread,
    onCloseThread,
    onNewThread,
    chainRun,
    onChainTranscript,
    onChainGateResolved,
    onChainOpenRun,
    loading = false,
    historyLoading = false,
    hasEarlier = false,
    onLoadEarlier,
    titlePendingIds,
  }: ChatSurfaceProps) {
    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const [modelQuery, setModelQuery] = useState("");
    // Confirmation popover for the Accept→Bypass direction only (D2e) — the
    // reverse (Bypass→Accept) is a plain click, no popover state needed.
    const [bypassConfirmOpen, setBypassConfirmOpen] = useState(false);
    const [worktreeOffConfirmOpen, setWorktreeOffConfirmOpen] = useState(false);
    // D6/D15: "Other" spec-type text input state — local to the framing menu.
    // What the user typed, and which card frames it (#35).
    const [otherSpecText, setOtherSpecText] = useState("");
    const [specFraming, setSpecFraming] = useState<string | null>(null);
    const specRequestRef = useRef<HTMLDivElement | null>(null);
    // The field opens below the fold on a short window, and `autoFocus`
    // alone does not scroll a flex scroll container — the user was left
    // looking at three cards with the Start button off screen.
    useEffect(() => {
      if (specFraming)
        specRequestRef.current?.scrollIntoView({ block: "nearest" });
    }, [specFraming]);
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
    // Two sources for the same fact, live wins: `modelError` comes from the
    // thread-open auto-probe and reflects the agent's *current* status; a
    // successful probe (`modelState`) clears any stale `thread.authBlocked`
    // left over from the last turn that failed, without waiting for the
    // backend to see another turn complete. Before the probe resolves,
    // `authBlocked` is the best signal available.
    const authIssue =
      modelError && isAuthError(modelError)
        ? modelError
        : modelState
          ? null // a fresh, successful probe outranks a stale persisted flag
          : (thread?.authBlocked ?? null);
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
    // #35: the gap between picking a framing card and the agent's first
    // question is a cold agent spawn — seconds, sometimes tens of them —
    // and all it used to show was one italic line over an empty transcript.
    // A first-time user had nothing telling them what spec mode was about to
    // do to them, or that answering was their next move.
    // Anything the agent has produced ends it: a streamed event, a tool call,
    // or a persisted assistant message. A `plain` item with a `tool` role is
    // Palisade's own marker ("Switched to spec mode"), not the agent talking.
    const specStarting =
      thread?.currentMode === "spec" &&
      busy &&
      !items.some(
        (item) => item.kind !== "plain" || item.role === "assistant"
      );

    // The `/` menu. Opens on a leading slash and closes on the first space —
    // ACP takes the whole line as the prompt, so the rest is the command's
    // own input and there is nothing left to complete.
    // Chat-only: preflight ran and found no ACP agent at all. Keyed on the
    // agent list rather than `flightSelected`, which is also null in the
    // moment before an agent resolves — this must only fire when nothing
    // could ever answer a turn.
    const noAgentsInstalled = !!flight && flight.agents.length === 0;
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

    // The `@` mention menu (#32). Unlike `/`, a mention is a reference inside
    // a sentence — "compare @src/api.ts with @src/App.tsx" — so it opens
    // wherever the caret is rather than only at the start of the draft, and
    // the caret position is what decides which mention is being typed.
    const [caret, setCaret] = useState(0);
    const [mentionIndex, setMentionIndex] = useState(0);
    const mention = useMemo(
      () => (commandMenuOpen ? null : mentionAt(draft, caret)),
      [draft, caret, commandMenuOpen]
    );
    const mentionMatches = useMemo(
      () => (mention ? rankMentions(mentionFiles, mention.query) : []),
      [mention?.query, mentionFiles]
    );
    const mentionMenuOpen = mention !== null;
    const activeMention = mentionMatches[mentionIndex] ?? mentionMatches[0];
    useEffect(() => {
      setMentionIndex(0);
    }, [mention?.query]);
    // Walking the project tree costs a round trip, so it happens when the
    // menu first opens rather than on every keystroke or on mount.
    useEffect(() => {
      if (mentionMenuOpen) onOpenMentions?.();
    }, [mentionMenuOpen, onOpenMentions]);

    /** Swap the typed fragment for the real path and put the caret after it. */
    const pickMention = (path: string) => {
      if (!mention) return;
      const next = applyMention(draft, mention, path);
      setDraft(next.text);
      setCaret(next.caret);
      const input = composerInputRef.current;
      // After React has written the new value, or the browser puts the caret
      // back at the end of the old one.
      requestAnimationFrame(() => {
        input?.focus();
        input?.setSelectionRange(next.caret, next.caret);
      });
    };
    /** Keep `caret` honest for arrow keys, clicks and selections alike. */
    const trackCaret = (
      event: React.SyntheticEvent<HTMLTextAreaElement>
    ) => setCaret(event.currentTarget.selectionStart ?? 0);

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
    // A thread that just came on screen — new, switched to, or an empty Go
    // composer after the mode picker — should take typing at once. Never
    // from the code editor or another field someone is already typing in.
    useEffect(() => {
      const active = document.activeElement;
      const typing =
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement ||
        active?.classList.contains("cm-content");
      if (!typing) composerInputRef.current?.focus();
    }, [thread?.id, pendingMode]);
    // ⌘L from anywhere: the command can't reach this ref, so it asks.
    useEffect(() => {
      const onChatCommand = (event: Event) => {
        if ((event as CustomEvent).detail !== "focus") return;
        // After a collapsed panel re-mounts the textarea.
        requestAnimationFrame(() => composerInputRef.current?.focus());
      };
      window.addEventListener("palisade-chat-command", onChatCommand);
      return () =>
        window.removeEventListener("palisade-chat-command", onChatCommand);
    }, []);
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
    // Older messages land above what the reader is looking at. WKWebView has no
    // scroll anchoring, so hold the same distance from the bottom by hand.
    const earlierAnchor = useRef<{ oldest: number; fromBottom: number } | null>(null);
    const [loadingEarlier, setLoadingEarlier] = useState(false);
    const handleLoadEarlier = async () => {
      const el = messagesRef.current;
      const oldest = oldestSeq(messages);
      if (!onLoadEarlier || !el || oldest === undefined) return;
      earlierAnchor.current = { oldest, fromBottom: el.scrollHeight - el.scrollTop };
      setLoadingEarlier(true);
      try {
        await onLoadEarlier();
      } catch (err) {
        onError?.(describeError(err));
      } finally {
        setLoadingEarlier(false);
      }
    };
    useLayoutEffect(() => {
      const anchor = earlierAnchor.current;
      const el = messagesRef.current;
      const oldest = oldestSeq(messages);
      if (!anchor || !el || oldest === undefined || oldest >= anchor.oldest) return;
      el.scrollTop = el.scrollHeight - anchor.fromBottom;
      earlierAnchor.current = null;
    }, [messages]);
    useEffect(() => {
      if (!modelMenuOpen) setModelQuery("");
    }, [modelMenuOpen]);
    const currentModelId =
      thread?.model ?? framingModel ?? modelState?.current ?? null;
    const modelLabel =
      // A known bad flag (from a persisted `authBlocked`, since the live
      // probe can't have finished yet if it's loading) outranks "…" — an
      // in-flight probe must never hide a warning already known to be true.
      authIssue
        ? "sign in needed"
        : models === "loading"
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
    if (loading) {
      return <ThreadLoadingSkeleton />;
    }

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
    // One framing menu, two entry points: the new-thread flow and the
    // composer's Spec toggle. It lived as two copies of the same ~90 lines,
    // so every fix had to be made twice — and the second copy kept drifting
    // (#35 was reported against one of them and was present in both).
    const activeFraming =
      SPEC_FRAMINGS.find((f) => f.id === specFraming) ?? null;

    const specTypeMenu = (
      onPick: (specType: string, description: string) => void,
      onBack?: () => void
    ) => (
          <div
            className="ds-new-thread-picker"
            data-testid="spec-type-picker"
            onKeyDown={(event) => {
              // Esc backs out, the same as the button at the bottom.
              if (event.key === "Escape" && onBack) {
                event.preventDefault();
                onBack();
              }
            }}
          >
            <p className="ds-mode-picker-prompt">
              What would you like to spec out today?
            </p>
            {/* The card is the framing, not the request. Each one pre-wires
                the questions that kind of work always has to answer; the
                field below is what the user actually wants. Picking a card
                used to fire an agent turn on its own, which meant the
                interview opened by asking for a request the user had already
                been asked for. */}
            <p className="hint ds-spec-note" data-testid="spec-type-note">
              Pick how to frame it, say what you want, and the agent opens the
              interview from there.
            </p>
            {framingPickerRow}
            {!providerSelected && (
              <p className="hint ds-spec-note is-warn">
                Select a provider to continue.
              </p>
            )}
            <div className="ds-mode-picker">
              {SPEC_FRAMINGS.map((framing) => (
                <UnstyledButton
                  key={framing.id}
                  className="ds-mode-card"
                  data-testid={`spec-type-${framing.id.toLowerCase()}`}
                  disabled={!providerSelected}
                  aria-pressed={specFraming === framing.id}
                  data-active={specFraming === framing.id || undefined}
                  onClick={() =>
                    providerSelected && setSpecFraming(framing.id)
                  }
                >
                  <strong>{framing.id}</strong>
                  <span>{framing.blurb}</span>
                </UnstyledButton>
              ))}
            </div>
            {activeFraming && (
              <div ref={specRequestRef} className="ds-spec-request">
                <Textarea
                  value={otherSpecText}
                  onChange={(event) =>
                    setOtherSpecText(event.currentTarget.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      const trimmed = otherSpecText.trim();
                      if (trimmed && providerSelected)
                        onPick(activeFraming.id, trimmed);
                    }
                  }}
                  label={activeFraming.label}
                  description="Enter to start · Shift+Enter for a new line"
                  placeholder={activeFraming.placeholder}
                  data-testid="other-spec-input"
                  minRows={2}
                  maxRows={6}
                  autoFocus
                  styles={{ root: { width: "100%" } }}
                />
                <Button
                  size="sm"
                  data-testid="other-spec-submit"
                  disabled={!otherSpecText.trim() || !providerSelected}
                  onClick={() => onPick(activeFraming.id, otherSpecText.trim())}
                  leftSection={<IconListCheck size={14} />}
                  style={{ alignSelf: "flex-start" }}
                >
                  Start spec
                </Button>
              </div>
            )}
            <button
              className="ds-icon-btn ds-spec-back"
              data-testid="spec-type-back"
              onClick={onBack}
            >
              ← Back
            </button>
          </div>
    );

    if (specTypePicker) {
      return (
        <>
          <div className="pane-head">
            <strong>New thread</strong>
          </div>
          {specTypeMenu(
            (specType, description) => onPickSpecType?.(specType, description),
            onSpecTypeBack
          )}
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
          {specTypeMenu(
            (specType, description) =>
              onPickComposerSpecType?.(specType, description),
            onComposerSpecTypeBack
          )}
        </>
      );
    }

    // D20: pendingMode "go" is the deferred empty composer — no thread
    // exists yet, but the composer below must still render so the user can
    // type their first message (which creates the thread on send).
    // Entice the user to create a new thread only if threads are focused
    // and no mode is pending.
    if (transitioning) {
      return <div className="empty" role="status"><Loader size="sm" /> Preparing your Spec conversation…</div>;
    }
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
                <span className="ds-thread-tab-title">
                  {titlePendingIds?.has(t.id) ? (
                    <Skeleton height={12} width={96} role="status" aria-label="Naming thread" />
                  ) : (
                    t.title
                  )}
                </span>
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
            {thread && titlePendingIds?.has(thread.id) ? (
              <Skeleton height={14} width={180} role="status" aria-label="Naming thread" />
            ) : (
              thread?.title ?? "New thread"
            )}
          </strong>
          {thread && (
            <Tooltip label="Rename thread" openDelay={400}>
              <ActionIcon
                variant="subtle"
                color="neutral"
                size="sm"
                aria-label="Rename thread"
                onClick={() => onRenameThread(thread)}
                data-testid="rename-thread"
              >
                <IconPencil size={13} />
              </ActionIcon>
            </Tooltip>
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
          {/* The branch's evidence, beside the branch itself: a named verify
              command's exit code at a named commit, or "Not verified". */}
          {verify && <VerifyBadge verify={verify} />}
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
        {/* Polite, not assertive: agent output streams continuously, and an
            assertive region would interrupt the screen reader on every token.
            A permission prompt carries its own labelled group inside. */}
        <div
          className="messages"
          data-testid="messages"
          ref={messagesRef}
          onScroll={handleScroll}
          aria-live="polite"
          aria-relevant="additions text"
          data-autoscroll={autoScroll}
        >
          <>
            {hasEarlier && (
              <Button
                variant="subtle"
                size="compact-sm"
                loading={loadingEarlier}
                onClick={() => void handleLoadEarlier()}
                data-testid="load-earlier"
              >
                Load earlier messages
              </Button>
            )}
            {items.length === 0 && historyLoading && (
              <ThreadLoadingSkeleton label="Loading messages" />
            )}
            {items.length === 0 && !historyLoading && (
              <div className="ds-thread-empty" data-testid="thread-empty">
                <strong>What are we building?</strong>
                <p>
                  Describe the change you want. <b>Go</b> edits code right
                  away; <b>Spec</b> writes the plan with you first.
                </p>
                {/* Starters: a blank box is the hardest prompt to answer.
                    Each drops into the composer for editing, never sends. */}
                <div className="ds-thread-starters">
                  {STARTER_PROMPTS.map((prompt) => (
                    <UnstyledButton
                      key={prompt}
                      className="ds-thread-starter"
                      data-testid="thread-starter"
                      onClick={() => {
                        setDraft(prompt);
                        composerInputRef.current?.focus();
                      }}
                    >
                      {prompt}
                    </UnstyledButton>
                  ))}
                </div>
                <p>
                  Type <code>/</code> for commands, or <code>@</code> to point
                  at a file in this project.
                </p>
              </div>
            )}
            <EventList
              items={items}
              executor={executor}
              sessionId={sessionId}
              onPermissionAnswered={onPermissionAnswered}
              onRetry={(message) => {
                if (typeof message === "number" && project && thread) {
                  void api.retryMessage(project.hash, thread.id, message).catch((err) => onError?.(describeError(err)));
                } else if (typeof message === "string") {
                  // Legacy records lacked sequence ids. Preserve their old
                  // text retry behaviour; newly persisted failures use the
                  // sequence-keyed path above and cannot duplicate a row.
                  setDraft(message);
                }
              }}
              agentLogins={agentLogins}
              agentLoginsFor={agentLoginsFor}
              onAgentLogin={onAgentLogin}
            />
          </>
          {/* The chat live run card (D-h/D-j, PLAN §4.5): chat is the
              primary run surface (D-m), so a chain run started on this
              thread renders here — one message that mutates in place,
              never appended. */}
          {chainRun && project && (
            <ChainRunCard
              run={chainRun}
              projectHash={project.hash}
              onTranscript={onChainTranscript}
              onGateResolved={onChainGateResolved}
              onOpenRun={onChainOpenRun}
            />
          )}
          {busy && specStarting && (
            <Paper
              withBorder
              radius="md"
              p="sm"
              data-testid="spec-primer"
              role="status"
              style={{ background: "var(--surface)", marginTop: 8 }}
            >
              <Group gap={8} wrap="nowrap" mb={6}>
                <Loader type="dots" size={14} color="neutral" />
                <strong style={{ fontSize: 13 }}>
                  Starting {executorLabel ?? "the agent"}…
                </strong>
              </Group>
              <ol
                style={{
                  margin: 0,
                  paddingLeft: 18,
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: "var(--muted)",
                }}
              >
                <li>
                  It asks one question at a time. Answer in the composer below.
                </li>
                <li>
                  When the picture is clear, it writes a proposal for you to
                  read.
                </li>
                <li>Nothing in your code changes until you approve it.</li>
              </ol>
              <span className="hint" style={{ display: "block", marginTop: 6 }}>
                The first question usually takes a few seconds.
              </span>
            </Paper>
          )}
          {busy && !specStarting && (
            <div className="working" data-testid="working">
              Agent working…
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
        {/* What the running turn is touching right now, one chip per file,
            expandable in place — reviewing an edit should not cost a pane
            switch, and the row stays one line tall however many files a turn
            gets through. */}
        <LiveFileChips live={live} busy={busy} />

        {worktree && project && thread &&
          (worktree.added + worktree.removed > 0 || worktree.ahead > 0) && (
            <MergeGate
              projectHash={project.hash}
              threadId={thread.id}
              worktree={worktree}
              verify={verify}
              onViewDiff={onViewDiff}
              onArchive={onArchiveSelf}
              onChanged={onWorktreeChanged}
              onError={onError}
            />
          )}

        {/* #26: messages typed while the agent was mid-turn. They sit here,
            visible and removable, and go out in order the moment the turn
            ends — an agent takes one prompt per turn, so sending them now
            would either drop them or interleave them at random. */}
        {queued.length > 0 && (
          <Stack gap={4} px={8} pb={6} data-testid="queued-messages">
            <Group gap={6} c="dimmed">
              <IconClockPause size={12} />
              <span style={{ fontSize: 11 }}>
                {queued.length === 1
                  ? "1 message queued — sends when this turn ends"
                  : `${queued.length} messages queued — sent in order when this turn ends`}
              </span>
            </Group>
            {queued.map((message) => (
              <Paper
                key={message.id}
                withBorder
                radius="md"
                p={8}
                data-testid="queued-message"
                style={{ background: "var(--surface)" }}
              >
                <Group gap={8} wrap="nowrap" align="flex-start">
                  <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: 13,
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {message.text}
                    </span>
                    {message.error && (
                      <span
                        role="alert"
                        style={{ fontSize: 11, color: "var(--danger)" }}
                      >
                        Not sent. {message.error}
                      </span>
                    )}
                  </Stack>
                  {message.error && (
                    <Button
                      size="compact-xs"
                      variant="default"
                      data-testid="queued-retry"
                      onClick={() => onRetryQueued?.(message.id)}
                    >
                      Retry
                    </Button>
                  )}
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="neutral"
                    data-testid="queued-remove"
                    aria-label={`Remove queued message: ${message.text}`}
                    onClick={() => onRemoveQueued?.(message.id)}
                  >
                    <IconX size={12} />
                  </ActionIcon>
                </Group>
              </Paper>
            ))}
          </Stack>
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
            boxShadow: "var(--shadow-float)",
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
              aria-label={openMenuKind === "chains" ? "Playbooks" : "Skills"}
            >
              <div className="ds-command-menu-header">
                {openMenuKind === "chains" ? (
                  <>
                    <IconRoute size={12} />
                    Playbooks
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
                      ? "No playbooks saved for this project yet."
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

          {/* The `@` file mention menu (#32), sharing the `/` menu's shape so
              the two read as one control with two grammars. */}
          {mentionMenuOpen && (
            <Paper
              withBorder
              shadow="md"
              radius="md"
              className="ds-command-menu"
              data-testid="mention-menu"
              role="listbox"
              aria-label="Project files"
            >
              <div className="ds-command-menu-header">
                <IconFile size={12} />
                Files
              </div>
              <div className="ds-command-menu-scroll">
                {mentionMatches.length === 0 ? (
                  <p className="ds-command-menu-empty">
                    {mentionFiles.length === 0
                      ? "Reading the project's files…"
                      : `No files match “${mention.query}”.`}
                  </p>
                ) : (
                  mentionMatches.map((path, index) => (
                    <UnstyledButton
                      key={path}
                      role="option"
                      aria-selected={path === activeMention}
                      data-active={path === activeMention || undefined}
                      className="ds-command-menu-row"
                      data-testid="mention-row"
                      onMouseEnter={() => setMentionIndex(index)}
                      onClick={() => pickMention(path)}
                    >
                      <span className="ds-command-menu-name">
                        {path.split("/").pop()}
                      </span>
                      <span className="ds-command-menu-desc">{path}</span>
                    </UnstyledButton>
                  ))
                )}
              </div>
            </Paper>
          )}

          {/* Worktree isolation, sitting next to the permission toggle because
              it is the same kind of decision: what this thread is allowed to
              touch. Off means the agent edits the project's own working
              directory live, which is why turning it off asks first and why
              it locks once the thread has run. */}
          <Popover
            opened={worktreeOffConfirmOpen}
            onChange={setWorktreeOffConfirmOpen}
            withArrow
            position="top-end"
          >
            <Popover.Target>
              {/* The tooltip lives *inside* the target rather than wrapping
                  it: Popover.Target needs the ref on the element it anchors
                  to, and a disabled button never fires the events a tooltip
                  listens for either — hence the wrapper span, which carries
                  both. */}
              <span
                style={{ position: "absolute", top: 8, right: 40, zIndex: 1 }}
                data-tauri-drag-region-exclude
              >
                <WorktreeModeBadge
                  isolated={worktreeEnabled}
                  locked={worktreeLocked}
                  data-testid="worktree-mode-btn"
                  tooltip={
                    worktreeLocked
                      ? `Set when this thread started — it runs ${
                          worktreeEnabled ? "in its own worktree" : "in the project directory"
                        } for good now`
                      : worktreeEnabled
                        ? "Runs in its own git worktree — click to edit the project directly"
                        : "Edits the project directory directly — click to isolate this thread"
                  }
                  onClick={
                    onToggleWorktree
                      ? () => {
                          if (!worktreeEnabled) onToggleWorktree();
                          else setWorktreeOffConfirmOpen(true);
                        }
                      : undefined
                  }
                />
              </span>
            </Popover.Target>
            <Popover.Dropdown data-testid="worktree-mode-confirm">
              <Stack gap="xs">
                <span style={{ fontSize: 13, maxWidth: 280, display: "block" }}>
                  Turn off worktree isolation? The agent edits your working
                  directory live — uncommitted changes there can be overwritten,
                  and this thread gets no merge, PR or clean-up step. It can't be
                  changed after the first message.
                </span>
                <Group gap="xs" justify="flex-end">
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => setWorktreeOffConfirmOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="compact-xs"
                    color="warn"
                    data-testid="worktree-mode-confirm-off"
                    onClick={() => {
                      onToggleWorktree?.();
                      setWorktreeOffConfirmOpen(false);
                    }}
                  >
                    Turn off
                  </Button>
                </Group>
              </Stack>
            </Popover.Dropdown>
          </Popover>

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
            <div className="ds-composer-chip-row ds-composer-message-input">
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
                    // Mid-turn Enter queues rather than doing nothing (#26).
                    if (draft.trim()) {
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
                    fontSize: 13,
                    lineHeight: 1.5,
                  },
                }}
              />
            </div>
          ) : (
            <Textarea
              className="ds-composer-message-input"
              ref={composerInputRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setCaret(event.target.selectionStart ?? event.target.value.length);
              }}
              onSelect={trackCaret}
              onClick={trackCaret}
              onKeyDown={(event) => {
                // The mention menu owns the same keys the `/` menu does, and
                // the two are never open at once.
                if (mentionMenuOpen) {
                  if (
                    (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                    mentionMatches.length > 0
                  ) {
                    event.preventDefault();
                    const step = event.key === "ArrowDown" ? 1 : -1;
                    setMentionIndex(
                      (i) =>
                        (i + step + mentionMatches.length) %
                        mentionMatches.length
                    );
                    return;
                  }
                  if (
                    (event.key === "Tab" ||
                      (event.key === "Enter" && !event.shiftKey)) &&
                    activeMention
                  ) {
                    event.preventDefault();
                    pickMention(activeMention);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    // Keep the text, drop the `@`, so Escape never destroys
                    // what the user typed — same contract as the `/` menu.
                    const end = mention.start + 1 + mention.query.length;
                    setDraft(
                      draft.slice(0, mention.start) + draft.slice(mention.start + 1)
                    );
                    setCaret(end - 1);
                    return;
                  }
                }
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
                  // Mid-turn Enter queues rather than doing nothing (#26).
                  if (draft.trim()) {
                    event.currentTarget.form?.requestSubmit();
                  }
                }
              }}
              placeholder={
                !flightSelected
                  ? "Chat-only — no executor on PATH"
                  : busy
                    ? "Message — queued until this turn ends"
                    : "Message, or / for commands"
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
                  fontSize: 13,
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
                  type="button"
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
                    <Menu.Label>Playbook</Menu.Label>
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
                  type="button"
                  className={`ds-composer-picker${
                    currentModelId ? " selected" : ""
                  }${authIssue ? " warn" : ""}`}
                  data-testid="model-btn"
                  data-tauri-drag-region-exclude
                  disabled={!executor}
                  title={authIssue ?? undefined}
                >
                  {authIssue ? (
                    <IconAlertTriangle size={14} data-testid="model-btn-auth-warning" />
                  ) : (
                    <IconBox size={14} />
                  )}
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
                styles={MODE_SELECTOR_STYLES}
                classNames={{
                  control: "mode-selector-control",
                  label: "mode-selector-label",
                }}
              />

              {busy ? (
                <Group gap={6} wrap="nowrap">
                  {draft.trim() && (
                    <ActionIcon
                      type="submit"
                      data-testid="composer-queue"
                      aria-label="Queue message"
                      title="Queue — sends when this turn ends"
                      size={36}
                      radius="md"
                      variant="default"
                      style={{ flexShrink: 0 }}
                    >
                      <IconClockPause size={14} />
                    </ActionIcon>
                  )}
                <ActionIcon
                  data-testid="composer-stop"
                  onClick={onStop}
                  aria-label="Stop"
                  title="Stop"
                  size={36}
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
                        transform: "scale(0.96)",
                      },
                    },
                  }}
                >
                  <IconPlayerStopFilled size={16} />
                </ActionIcon>
                </Group>
              ) : (
                <ActionIcon
                  type="submit"
                  data-testid="composer-send"
                  // With no ACP agent detected there is nothing to answer a
                  // turn: `onSend` recorded the message, cleared busy, and
                  // left it sitting in the thread with no reply and no error,
                  // so the user could not tell the turn would never run.
                  // Preflight already says "chat-only mode, /go unavailable" —
                  // make the composer agree with that sentence.
                  disabled={busy || !draft.trim() || noAgentsInstalled}
                  aria-label="Send message"
                  title={
                    noAgentsInstalled
                      ? "No coding agent detected — install Claude Code or Codex, then reopen Palisade"
                      : "Send message"
                  }
                  size={36}
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
                        transform: "scale(0.96)",
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

function ThreadLoadingSkeleton({ label = "Loading threads" }: { label?: string }) {
  return (
    <div className="ds-thread-loading" data-testid="thread-loading" role="status" aria-label={label}>
      <div className="ds-thread-loading-message">
        <Skeleton height={12} width="28%" />
        <Skeleton height={14} width="82%" />
        <Skeleton height={14} width="64%" />
      </div>
      <div className="ds-thread-loading-activity">
        <Skeleton height={12} width="22%" />
      </div>
      <div className="ds-thread-loading-message">
        <Skeleton height={12} width="24%" />
        <Skeleton height={14} width="74%" />
      </div>
    </div>
  );
}

function PanelLoadingSkeleton({ label }: { label: string }) {
  return (
    <div className="ds-panel-loading" role="status" aria-label={label}>
      <Skeleton height={12} width="30%" />
      <Skeleton height={14} width="88%" />
      <Skeleton height={14} width="68%" />
      <Skeleton height={96} />
    </div>
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
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
/** Executor event kinds that are never persisted to the session store (same
 *  D-design comment as ExecutorEvent::TextDelta/ToolOutputDelta): a refresh
 *  that rebuilds `messages` from disk must keep these in the live buffer
 *  rather than drop them, or streamed output vanishes mid-turn. */
const LIVE_ONLY_KINDS = new Set<ExecutorEvent["kind"]>([
  "textDelta",
  "reasoningDelta",
  "toolOutputDelta",
  "permissionRequest",
]);
/** Placeholder `seq` for a user message rendered before the backend has
 *  assigned it a real one — real seqs are positive, persisted integers, so
 *  this can never collide with one. */
const OPTIMISTIC_SEQ = -1;
/** How much of a thread opens at once. Older messages come on demand ("Load
 *  earlier"), so opening — and every refresh — costs the same at any length. */
const THREAD_PAGE = 200;
/** Streamed executor events are applied to state at most this often. */
const LIVE_BATCH_MS = 50;
/** One page of a thread's newest messages (older than `beforeSeq`, if given),
 *  and whether any older ones exist. Asks for one message more than a page:
 *  its presence is the exact "there is more" signal, whatever seq a thread's
 *  log starts at. */
async function readPage(projectHash: string, threadId: string, beforeSeq?: number) {
  const got = await api.readThread(projectHash, threadId, { beforeSeq, limit: THREAD_PAGE + 1 });
  const hasEarlier = got.length > THREAD_PAGE;
  return { messages: hasEarlier ? got.slice(1) : got, hasEarlier };
}
/** What a refresh re-reads: everything from `fromSeq` on (keeping any earlier
 *  pages on screen), or the newest page when nothing is loaded yet. Only the
 *  newest page can say whether older messages exist. */
async function readFresh(
  projectHash: string,
  threadId: string,
  fromSeq: number | undefined
): Promise<{ messages: Message[]; hasEarlier?: boolean }> {
  if (fromSeq === undefined) return readPage(projectHash, threadId);
  return { messages: await api.readThread(projectHash, threadId, { fromSeq }) };
}
/** The seq of the oldest persisted message on screen; `undefined` when none. */
const oldestSeq = (messages: Message[]) => messages.find((m) => m.seq !== OPTIMISTIC_SEQ)?.seq;
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
            <ArchiveIcon threadId={thread.id} />
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
  onSelectProject: (project: Project) => void;
  onAddProject: () => void;
  onRenameProject: () => void;
  /** #33: open a project in its own window, leaving this one alone. */
  onOpenProjectWindow: (project: Project) => void;
  /** #28: forget a saved project. Source files and history are kept. */
  onRemoveProject: (project: Project) => void;
};

const WorkspacePicker = memo(function WorkspacePicker({
  variant,
  project,
  projects,
  onSelectProject,
  onAddProject,
  onRenameProject,
  onOpenProjectWindow,
  onRemoveProject,
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
          <Button
            size="compact-sm"
            variant="default"
            onClick={onAddProject}
            data-testid="add-project"
          >
            Add project
          </Button>
          {project && (
            <Button
              size="compact-sm"
              variant="default"
              onClick={onRenameProject}
              data-testid="rename-project"
            >
              Rename
            </Button>
          )}
          {project && (
            <Button
              size="compact-sm"
              variant="default"
              onClick={() => onOpenProjectWindow(project)}
              data-testid="open-project-window"
              title="Open this project in a second window"
            >
              New window
            </Button>
          )}
        </div>
      </div>
      {otherProjects.length > 0 && (
        <div className="ds-rail-section">
          <h2 className="ds-section-heading">Recent Projects</h2>
          <ul className="ds-recent-projects">
            {otherProjects.map((p) => {
              // ⌘/Ctrl-click opens a second window instead of switching this
              // one, the way VS Code's recent list behaves.
              const select = (
                event?: React.MouseEvent | React.KeyboardEvent
              ) => {
                if (event?.metaKey || event?.ctrlKey) {
                  onOpenProjectWindow(p);
                  return;
                }
                onSelectProject(p);
              };
              return (
                <li
                  key={p.hash}
                  className="ds-tree-row"
                  role="button"
                  tabIndex={0}
                  onClick={select}
                  onKeyDown={onActivateKey(select)}
                  title={`${p.root}\n⌘-click to open in a new window`}
                  data-testid="recent-project"
                >
                  <IconFolder size={14} className="ds-chevron" />
                  <span className="ds-tree-label">{p.displayName}</span>
                  <span className="ds-tree-row-actions">
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <ActionIcon
                        variant="subtle"
                        color="neutral"
                        size="sm"
                        aria-label={`Actions for ${p.displayName}`}
                        data-testid="recent-project-menu"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <IconDots size={13} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        leftSection={<IconAppWindow size={14} />}
                        data-testid="recent-project-new-window"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenProjectWindow(p);
                        }}
                      >
                        Open in new window
                      </Menu.Item>
                      <Menu.Item
                        color="danger"
                        leftSection={<IconTrash size={14} />}
                        data-testid="recent-project-remove"
                        onClick={(event) => {
                          event.stopPropagation();
                          onRemoveProject(p);
                        }}
                      >
                        Remove from Recent Projects
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                  </span>
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

export function clearRecoveredNotebook(
  paths: Set<string>,
  path: string
): Set<string> {
  if (!paths.has(path)) return paths;
  const next = new Set(paths);
  next.delete(path);
  return next;
}

/** Normalizes any `ChainNodeState` wire shape to its kind string. The
 *  chain-event reducer uses this to notice a node starting a new turn
 *  ("executing" after anything else) so it can derive per-node
 *  startedAt/endedAt/iterations — `ChainEvent` itself carries no timestamps. */
function chainStateKind(state: api.ChainNodeState | undefined): string | undefined {
  if (!state) return undefined;
  if (typeof state === "string") return state;
  if ("kind" in state && state.kind) return state.kind;
  if ("blocked" in state && state.blocked) return "blocked";
  if ("retrying" in state && state.retrying !== undefined) return "retrying";
  return undefined;
}

/** A durable `ChainRunRecord` (from history) into the same `RunView` shape
 *  the live card and canvas render — Review mode is the finished-run half
 *  of "one canvas, three modes" (PLAN §4.4), reusing the live rendering
 *  path rather than a second one. */
function buildReviewRunView(record: api.ChainRunRecord): ChainRunCardView {
  const states: Record<string, api.ChainNodeState> = {};
  const nodes: NonNullable<ChainRunCardView["nodes"]> = {};
  for (const [role, history] of Object.entries(record.nodes)) {
    const last = history.transitions[history.transitions.length - 1]?.state;
    const state: api.ChainNodeState = last ?? "queued";
    states[role] = state;
    nodes[role] = {
      state,
      sessionId: history.sessionId,
      iterations: history.iterations,
      cost: history.cost,
    };
  }
  const outcome = record.outcome && record.outcome.kind !== "interrupted" ? record.outcome : null;
  return {
    runId: record.id,
    chain: record.chainName,
    threadId: record.threadId,
    seed: record.seed,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    states,
    nodes,
    awaiting: null,
    outcome,
  };
}

/**
 * A one-line prompt, confirm, or picker, rendered as the app's own command
 * bar. `window.prompt` and `window.confirm` do nothing in Tauri's WKWebView —
 * they return null without ever showing a dialog — so anything needing a line
 * of text, or a yes/no, has to go through this.
 *
 * Hoisted out of App so the hooks that raise one can name it.
 */
export type CommandBarRequest =
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
        onCancel?: () => void;
      }
    | {
        kind: "select";
        label: string;
        /** "branch" keeps the create/delete/DWIM-worktree extras that only
         *  make sense for branches; "list" is a plain switcher (working
         *  trees today) that just picks a row. One modal, one look, for
         *  both — only the row extras differ. */
        variant: "branch" | "list";
        options: { value: string; label: string; secondary?: string }[];
        submit: (value: string) => void;
      }
    | null;

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
  const historyLoading = ex.historyLoading;
  const setHistoryLoading = ex.setHistoryLoading;
  /** Older messages exist beyond the page(s) on screen. */
  const [hasEarlier, setHasEarlier] = useState(false);
  const draft = ex.draft;
  const setDraft = ex.setDraft;
  const errors = ex.errors;
  const setErrors = ex.setErrors;
  const flight = ex.flight;
  const setFlight = ex.setFlight;
  // The first-run checklist's "Check again" is in flight.
  const [rechecking, setRechecking] = useState(false);
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
  const [bar, setBar] = useState<CommandBarRequest>(null);
  const {
    newThreadPicker,
    setNewThreadPicker,
    pendingMode,
    setPendingMode,
    framingExecutor,
    setFramingExecutor,
    framingModel,
    setFramingModel,
    specTypePicker,
    setSpecTypePicker,
    composerSpecTypePicker,
    setComposerSpecTypePicker,
    transitioning,
    setTransitioning,
    reset: resetNewThreadFlow,
  } = useNewThreadFlow();
  // The project being opened, if any — drives the onboarding row's spinner.
  const [openingProject, setOpeningProject] = useState<string | null>(null);
  /** Branch → the worktree path that holds it, for every worktree but the
   *  project root. Drives both the picker's worktree marker and what picking
   *  such a branch does. */
  const [worktreeBranches, setWorktreeBranches] = useState<Map<string, string>>(
    new Map()
  );
  const [selectQuery, setSelectQuery] = useState("");
  useEffect(() => {
    if (!bar) setSelectQuery("");
  }, [bar]);
  // The open files. Shared by both shells, so switching between Vibe and
  // Editor never closes anything or loses where you were in a file.
  const tabs = useOpenTabs();
  const selectedFile = tabs.activePath;
  // Notebooks that failed to parse as nbformat JSON — falls back to
  // FileEditorPane's plain-text view instead (design.md Migration Plan).
  const [unopenableNotebooks, setUnopenableNotebooks] = useState<Set<string>>(new Set());

  /** Whether a CodeMirror buffer is the thing on screen. The Edit and Go
   * editor rows reach `FileEditorPane`'s view and nothing else, and their
   * accelerators are held by the menu bar — so on a notebook, a spec, a
   * table or a chain they would be enabled rows that do nothing. */
  const codeEditorActive =
    tabs.activeTab?.type === "file" &&
    !(tabs.activePath?.toLowerCase().endsWith(".ipynb") &&
      !unopenableNotebooks.has(tabs.activePath));
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
  const {
    threadPrefs,
    prefsMenuOpen,
    setPrefsMenuOpen,
    pendingWorktreeEnabled,
    setPendingWorktreeEnabled,
    loadFor: loadThreadPrefs,
    toggleBypass,
    createThreadWithPrefs,
  } = useThreadPrefs();
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
    toggleBypass(project.hash, thread.id);
  };
  /** Flip this thread's worktree isolation. Only offered before the thread
   *  has run — the backend refuses once a worktree exists, so this can never
   *  leave the flag disagreeing with what is on disk. */
  const onToggleWorktree = () => {
    if (!project) return;
    if (!thread) {
      // D20 leaves go-mode's composer with no thread until the first send,
      // but this toggle lives in that composer and locks the moment the
      // thread runs — so the only window in which the choice can be made was
      // exactly the window in which there was nothing to store it on, and the
      // click returned here silently. That is what made the toggle look dead.
      // Hold the choice instead; `createThreadWithPrefs` applies it.
      setPendingWorktreeEnabled((on) => !on);
      return;
    }
    api
      .setThreadWorktreeEnabled(
        project.hash,
        thread.id,
        thread.worktreeEnabled === false,
      )
      .then((meta) => {
        setThreads((prev) => prev.map((t) => (t.id === meta.id ? meta : t)));
        setThread(meta);
      })
      .catch(fail);
  };
  const [dragActive, setDragActive] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [textSearchOpen, setTextSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [debugLive, setDebugLive] = useState(false);
  // The terminal is spawned lazily — a shell per project on launch is not
  // what anyone wants. Once opened it stays mounted, so collapsing the
  // panel keeps the scrollback instead of disposing the instance.
  const terminalEverOpened = useRef(false);
  // Which terminal tab a "Run" click should type into. Several shells can be
  // open at once, so "the terminal" is no longer a single implicit target.
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  if (!shell.terminalPanel.collapsed) {
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
      const current = verifyPins[specName] ?? [];
      if (current.includes(commandName)) return;
      const next = { ...verifyPins, [specName]: [...current, commandName] };
      try {
        await api.saveVerifyPins(project.hash, next);
        setVerifyPins(next);
      } catch {
        // The write failed (or a concurrent writer's version won). Resync
        // from disk so the pin buttons reflect reality, not a stale guess.
        reloadVerifyPins(project.hash);
      }
    },
    [project, verifyPins, reloadVerifyPins]
  );

  const removeVerifyPin = useCallback(
    async (specName: string, commandName: string) => {
      if (!project) return;
      const current = verifyPins[specName] ?? [];
      const filtered = current.filter((c) => c !== commandName);
      const next = { ...verifyPins };
      if (filtered.length === 0) delete next[specName];
      else next[specName] = filtered;
      try {
        await api.saveVerifyPins(project.hash, next);
        setVerifyPins(next);
      } catch {
        reloadVerifyPins(project.hash);
      }
    },
    [project, verifyPins, reloadVerifyPins]
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
  /** Source Control's target is a deliberate Git choice, not a side effect
   * of selecting a thread to read its conversation. */
  const [sourceControlTreeId, setSourceControlTreeId] =
    useState<string | null>(null);
  /** `null` is both the Project root value and the selector's initial value,
   * so track separately whether Source Control has established the diff
   * context. Otherwise an active thread incorrectly wins over an explicit
   * Project root selection. */
  const [sourceControlDiffContext, setSourceControlDiffContext] = useState(false);
  // A thread id belongs to exactly one project. Carrying it into another
  // project leaves the selector with no matching option and makes the backend
  // quietly fall back to that project's root, so source-control context must
  // be reset with the project.
  useEffect(() => {
    setSourceControlTreeId(null);
    setSourceControlDiffContext(false);
  }, [project?.hash]);
  const openDiffFor = useCallback(
    (path: string) => {
      setSourceControlDiffContext(true);
      setDiffFocusPath(path);
      setDiffCommit(null);
      shell.setDiffOpen(true);
    },
    [shell.setDiffOpen]
  );

  // Clicking a commit in the Source Control panel's graph opens that
  // commit's diff — previously the click only moved the row highlight, with
  // no way to see what the commit actually changed.
  const [diffCommit, setDiffCommit] = useState<api.GraphCommit | null>(null);
  const openCommitDiff = useCallback(
    (commit: api.GraphCommit) => {
      setDiffCommit(commit);
      setDiffFocusPath(null);
      shell.setDiffOpen(true);
    },
    [shell.setDiffOpen]
  );

  // The graph's "Uncommitted changes" node, above HEAD — clears any commit
  // or file focus so the diff pane falls back to its default view: the
  // whole working tree, same as clicking "Show working changes".
  const openWorkingChangesDiff = useCallback(() => {
    setSourceControlDiffContext(true);
    setDiffCommit(null);
    setDiffFocusPath(null);
    shell.setDiffOpen(true);
  }, [shell.setDiffOpen]);

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

  useEffect(() => {
    if (!project) {
      setDebugLive(false);
      return;
    }
    let active = true;
    api.debugStatus(project.hash).then((status) => {
      if (active) setDebugLive(!!status.sessionId);
    }).catch(() => active && setDebugLive(false));
    const ended = listen("debug-ended", () => setDebugLive(false));
    // `debug-started`, not `debug-stopped`: the latter means the debuggee
    // paused at a breakpoint, so a program that runs straight through would
    // leave Stop Debugging disabled for the whole session.
    const started = listen("debug-started", () => setDebugLive(true));
    return () => {
      active = false;
      void ended.then((off) => off());
      void started.then((off) => off());
    };
  }, [project?.hash]);

  const runCommand = useCallback(
    (name: string, command: string) => {
      setRunLast(name);
      openPreviewUntil.current = Date.now() + 60_000;
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
      const target = activeTerminalId ?? firstTerminalId(project.hash);
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

  // #19: the interactive logins this thread's agent advertises over ACP.
  // Agents that own a login expect the *client* to run it — their own
  // `authenticate` refuses those methods — so an expired agent login is only
  // fixable in-app if Palisade asks for the command and runs it.
  const [agentLogins, setAgentLogins] = useState<api.AgentLogin[]>([]);
  useEffect(() => {
    if (!project) {
      setAgentLogins([]);
      return;
    }
    let live = true;
    api
      .agentLogins(project.hash, thread?.id ?? null)
      .then((logins) => live && setAgentLogins(logins))
      .catch(() => live && setAgentLogins([]));
    return () => {
      live = false;
    };
  }, [project?.hash, thread?.id]);

  // Logins per agent id, for crashes from an agent that is not this thread's
  // — a chain node runs whatever agent it is bound to. Fetched on first sight
  // of that agent's crash and cached; an agent with no advertised login stays
  // an empty list, which renders as "no sign-in here" rather than a wrong one.
  const [loginsByAgent, setLoginsByAgent] = useState<Record<string, api.AgentLogin[]>>({});
  const agentLoginsFor = useCallback(
    (crashText: string): api.AgentLogin[] => {
      // The crash is built as `{agent_name} needs to be signed in — ...`
      // (acp_client.rs), so the name matches an installed agent exactly.
      const agent = (flight?.agents ?? []).find((a) => crashText.startsWith(a.name));
      if (!agent || !project) return [];
      const cached = loginsByAgent[agent.id];
      if (cached) return cached;
      void api
        .agentLogins(project.hash, null, agent.id)
        .then((logins) =>
          setLoginsByAgent((prior) =>
            prior[agent.id] ? prior : { ...prior, [agent.id]: logins }
          )
        )
        .catch(() => undefined);
      return [];
    },
    [flight?.agents, project, loginsByAgent]
  );

  // Login methods are learned during a real ACP initialize. Refresh them only
  // after that connection explicitly says it needs authentication; probing on
  // mount used to create a surprise auth flow after every app restart.
  useEffect(() => {
    const required = listen<string>("agent-auth-required", ({ payload: threadId }) => {
      const activeProject = current.current.project;
      if (!activeProject || current.current.thread?.id !== threadId) return;
      api.agentLogins(activeProject.hash, threadId).then(setAgentLogins, () => setAgentLogins([]));
    });
    return () => {
      void required.then((off) => off());
    };
  }, []);

  const onAgentLogin = useCallback(
    (login: api.AgentLogin) => {
      // Two shapes, both from the agent's own manifest. A terminal login is a
      // command Palisade runs so the user can complete it here; a protocol
      // login is an `authenticate` call the agent answers itself (#19).
      if (login.kind === "terminal") {
        runCommand(`Sign in — ${login.label}`, login.shellLine);
        return;
      }
      const { project, thread } = current.current;
      if (!project) return;
      setBusy(true);
      api
        .agentAuthenticate(project.hash, thread?.id ?? null, null, login.methodId)
        // The agent owns the result; a failed sign-in surfaces the agent's
        // own words rather than a Palisade-invented summary.
        .then(() =>
          setBar({
            kind: "confirm",
            label: `Signed in with ${login.label}. Palisade resumed the blocked message.`,
            confirmLabel: "Close",
            onConfirm: () => setBar(null),
          })
        )
        .catch(fail)
        .finally(() => setBusy(false));
    },
    [runCommand]
  );

  const handleFileSave = useCallback(
    (edit: { path: string; before: string; after: string }) => {
      // A repaired notebook first saves through the text fallback. Let its
      // next render retry notebook mode instead of keeping that path stuck.
      if (edit.path.toLowerCase().endsWith(".ipynb")) {
        setUnopenableNotebooks((previous) => clearRecoveredNotebook(previous, edit.path));
      }
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
      applyAppearance(loadGlobalAppearance());
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

  // Warnings are deduped by text; errors are not. One settings mistake
  // reaches `selected_executor` from every call site that resolves an agent,
  // so a single unknown `executorOverride` stacked four identical banners on
  // one session start, and the same advisory sentence four times tells the
  // user nothing the first one didn't. An error, by contrast, is about a
  // specific action the user just took — two failed branch switches are two
  // events worth seeing, even when they failed for the same reason.
  const banner = (message: string, tone: "error" | "warn") =>
    setErrors((prev) =>
      tone === "warn" && prev.some((e) => e.message === message && e.tone === tone)
        ? prev
        : [...prev, { id: `${Date.now()}-${Math.random()}`, message, tone }]
    );
  const fail = (err: unknown) => banner(describeError(err), "error");
  // Advisory, not a failure: another thread is running here, an executor id
  // in settings is unknown and Palisade fell back. Routing these through `fail`
  // put "Couldn't complete that" on an action that completed fine.
  const warn = (message: string) => banner(message, "warn");
  const dismissError = (id: string) =>
    setErrors((prev) => prev.filter((e) => e.id !== id));

  /** Bumped by every thread selection; a read that finds it moved on discards itself. */
  const selectionRef = useRef(0);
  const selectThread = useCallback(
    async (projectHash: string, next: ThreadMeta | null) => {
      // Leaving a thread lets the backend do its idle housekeeping (worktree
      // sweeps). Sessions stay alive — idle ones keep their auth state — and
      // anything mid-turn keeps running and keeps streaming into its own key.
      const leaving = current.current.thread?.id;
      if (leaving && leaving !== next?.id) api.leaveThread(leaving).catch(fail);
      // Each selection owns the screen until a newer one replaces it: a slow
      // read for an earlier click must not land its history under this thread.
      const mine = ++selectionRef.current;
      setThread(next);
      setNewThreadPicker(false);
      // The previous thread's history must not sit under the new title while
      // this one loads.
      setMessages([]);
      setHasEarlier(false);
      if (!next) {
        setHistoryLoading(false);
        return;
      }
      setHistoryLoading(true);
      localStorage.setItem(lastThreadKey(projectHash), next.id);
      clearLiveFor(next.id);
      try {
        const page = await readPage(projectHash, next.id);
        if (mine !== selectionRef.current) return;
        setMessages(page.messages);
        setHasEarlier(page.hasEarlier);
      } finally {
        if (mine === selectionRef.current) setHistoryLoading(false);
      }
      // Load this thread's model/bypass preferences (per-thread override or
      // global default) so the composer control shows the right values.
      loadThreadPrefs(projectHash, next.id);
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
        shell.setDiffOpen(saved.diffOpen);
        // Restore the open panel; a project never opened under this shell
        // lands on the Fleet board, which is what opening a project means
        // in an ADE.
        shell.openPanel(
          saved.activePanel !== undefined ? saved.activePanel : "fleet"
        );

        // The backend starts watchers and checks settings before it replies.
        // Switch the visible workspace now; its data continues loading below.
        setProject(next);
        setThreads([]);
        void selectThread(next.hash, null);
        currentProjectRef.current = next.hash;
        tabsRef.current.closeAll();

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
  //
  // The exception is a window opened *for* a project (#33): `?project=<hash>`
  // is the user's explicit act, made in the window that spawned this one, so
  // this window opens straight into it rather than asking again.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("project");
    api.listProjects().then((found) => {
      setProjects(found);
      const target = requested
        ? found.find((p) => p.hash === requested)
        : undefined;
      if (target) void selectProjectNow(target);
      else if (requested)
        warn("That project is no longer saved in Palisade.");
    }, fail);
  }, []);

  // Projects are shared state across every window (#33): one window adding,
  // renaming or removing a project must not leave the others showing a list
  // that no longer exists.
  useEffect(() => {
    const stop = listen("projects-changed", () => {
      api.listProjects().then(setProjects, () => {});
    });
    return () => {
      void stop.then((off) => off());
    };
  }, []);

  // #33: a second window on the same or another project. Sessions, watchers
  // and threads are keyed per project in the backend, so the two windows are
  // independent — this only asks for the window.
  const onOpenProjectWindow = useCallback(
    async (target: Project) => {
      try {
        await api.openProjectWindow(target.hash);
      } catch (err) {
        fail(err);
      }
    },
    []
  );

  // #28: forget a saved project. Nothing on disk is deleted — not the repo,
  // not its worktrees, not its thread history — so the confirmation says so
  // rather than implying a destructive delete the backend never performs.
  const onRemoveProject = useCallback(
    (target: Project) => {
      setBar({
        kind: "confirm",
        label: `Remove "${target.displayName}" from Recent Projects? Files and chat history stay on disk.`,
        confirmLabel: "Remove",
        onConfirm: async () => {
          setBar(null);
          try {
            await api.removeProject(target.hash);
            const remaining = await api.listProjects();
            setProjects(remaining);
            // The project the user was in just left the list; there is
            // nothing to show, so fall back to the onboarding screen.
            if (current.current.project?.hash === target.hash) {
              setThread(null);
              setThreads([]);
              setProject(null);
            }
          } catch (err) {
            fail(err);
          }
        },
      });
    },
    []
  );

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
      const created = await createThreadWithPrefs(added.hash);
      let activeThread = await api.setThreadMode(added.hash, created.id, "go");
      const persisted = await persistFramingChoice(added.hash, activeThread.id);
      if (persisted) activeThread = persisted;
      setThreads(await api.listThreads(added.hash));
      await selectThread(added.hash, activeThread);
      // Off the board and onto the thread, so the run is visible immediately
      // rather than as one row among everything else.
      shell.openPanel(null);
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

  // Every rail panel that hands the editor column something to show (a
  // file, spec, table, chain, query) does it by changing the active tab —
  // so this is the one place that needs to reclaim a collapsed Vibe editor
  // column, rather than every panel's open-handler remembering to. Keyed
  // only on activePath actually changing: including editorCollapsed itself
  // would refight a deliberate manual collapse of an already-open tab.
  const prevActivePathRef = useRef<string | null>(null);
  useEffect(() => {
    const changed = tabs.activePath !== prevActivePathRef.current;
    prevActivePathRef.current = tabs.activePath;
    if (changed && tabs.activePath && shell.editorCollapsed) {
      shell.toggleEditor();
    }
  }, [tabs.activePath]);

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

  // Native Close Window and Quit must take the same dirty-buffer path as tab
  // closing. The window listener also covers traffic lights and OS Quit; menu
  // rows below merely request those native actions rather than bypassing them.
  const closeWindow = useCallback(() => {
    void getCurrentWindow().close();
  }, []);
  const quitApplication = useCallback(() => {
    // The native registry fans this request out to *every* dirty Palisade
    // window. A single renderer cannot truthfully decide process exit.
    void api.requestQuit().catch(fail);
  }, []);
  useEffect(() => {
    // Keep the process-wide quit registry current. The registry is the
    // authority for multi-window Quit.
    void api.syncWindowDirty(tabs.anyDirty).catch(() => {});
  }, [tabs.anyDirty]);
  useEffect(() => {
    // Only going away reports this window clean. Reporting it from the
    // effect above's cleanup would fire on every flip of the flag, racing a
    // `false` against the `true` that follows it — and a lost race means
    // Quit discards unsaved work without asking.
    return () => { void api.syncWindowDirty(false).catch(() => {}); };
  }, []);
  useEffect(() => {
    const quitConfirmation = listen("native-quit-confirm", () => {
      const dirty = tabsRef.current.tabs.filter((tab) => tab.dirty);
      // The registry can be a beat behind this window — the clean report is
      // fire-and-forget IPC. Answering anyway is what lets the quit finish;
      // staying silent leaves it pending forever and Cmd+Q does nothing.
      if (dirty.length === 0) {
        void api.confirmQuitWindow().catch(fail);
        return;
      }
      setBar({
        kind: "confirm",
        label: dirty.length === 1
          ? `Discard unsaved changes to "${tabKey(dirty[0])}" and quit Palisade?`
          : `Discard unsaved changes to ${dirty.length} files and quit Palisade?`,
        confirmLabel: "Quit",
        onConfirm: () => void api.confirmQuitWindow().catch(fail),
        onCancel: () => void api.cancelQuit().catch(() => {}),
      });
    }, nativeEventTarget());
    return () => { void quitConfirmation.then((off) => off()); };
  }, []);
  useEffect(() => {
    const window = getCurrentWindow();
    // The browser test harness supplies only the window methods its tests
    // exercise. In a real Tauri window this is always present.
    if (typeof window.onCloseRequested !== "function") return;
    let destroyed = false;
    const listenForClose = window.onCloseRequested((event) => {
      if (destroyed || !tabsRef.current.anyDirty) return;
      event.preventDefault();
      const dirty = tabsRef.current.tabs.filter((tab) => tab.dirty);
      setBar({
        kind: "confirm",
        label: dirty.length === 1
          ? `Discard unsaved changes to "${tabKey(dirty[0])}" and close this window?`
          : `Discard unsaved changes to ${dirty.length} files and close this window?`,
        confirmLabel: "Close Window",
        onConfirm: () => {
          destroyed = true;
          void window.destroy();
        },
      });
    });
    return () => { void listenForClose.then((off) => off()); };
  }, []);

  // "Clear Menu" has only one meaning here: Palisade's recent list *is* its
  // registered-project list, so clearing it unregisters those projects. That
  // is the same act the per-project Remove makes you confirm (`onRemoveProject`
  // above), so it asks in the same words rather than emptying the list on one
  // unprompted click. The focused project stays: it is still open.
  const clearRecentProjects = useCallback(() => {
    const recent = projects.filter((entry) => entry.hash !== project?.hash);
    if (recent.length === 0) return;
    setBar({
      kind: "confirm",
      label: `Remove ${recent.length === 1 ? `"${recent[0].displayName}"` : `${recent.length} projects`} from Recent Projects? Files and chat history stay on disk.`,
      confirmLabel: "Clear Menu",
      onConfirm: async () => {
        setBar(null);
        try {
          for (const entry of recent) await api.removeProject(entry.hash);
          setProjects(await api.listProjects());
        } catch (err) {
          fail(err);
        }
      },
    });
  }, [projects, project]);

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

  // Running dev servers — from a terminal or an agent — are offered as chips,
  // never opened on their own: a URL in output is not evidence anyone wants a
  // browser. The one exception is a server the Run shortcut just started: the
  // app launched it, so opening its preview is the expected result.
  const { servers: devServers } = useDevServers(
    project?.hash ?? null,
    useMemo(() => pm.threads.map((t) => t.id), [pm.threads])
  );
  const openPreviewUntil = useRef(0);
  const knownServers = useRef(new Set<string>());
  useEffect(() => {
    const fresh = devServers.filter((s) => !knownServers.current.has(s.url));
    knownServers.current = new Set(devServers.map((s) => s.url));
    const started = fresh.find((s) => s.origin === "terminal");
    if (started && Date.now() < openPreviewUntil.current) {
      openPreviewUntil.current = 0;
      tabs.openPreview(started.url);
    }
  }, [devServers, tabs.openPreview]);
  useLinkRouting(useCallback((url: string) => tabs.openPreview(url), [tabs.openPreview]));

  // A hidden native view is still a running page, so it must not outlive its
  // tab: close it when the Preview tab goes, and when the project does.
  const hasPreviewTab = tabs.tabs.some((t) => t.type === "preview");
  useEffect(() => {
    if (project && !hasPreviewTab) void api.previewClose(project.hash).catch(() => {});
  }, [hasPreviewTab, project?.hash]);
  useEffect(() => {
    const hash = project?.hash;
    return () => {
      if (hash) void api.previewClose(hash).catch(() => {});
    };
  }, [project?.hash]);

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
      variant: "branch",
      label: "Switch branch (or type a new name to create one)",
      options: options.map((name) => ({ value: name, label: name })),
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

  // Same picker component as branches (Source Control's two controls read
  // as one system, not a custom modal next to a native <select>) — just the
  // plain "list" variant, since a working tree can't be created by typing
  // a name the way a branch can.
  const onOpenWorkingTreePicker = () => {
    if (!project) return;
    const workingTrees = [
      {
        value: "project-root",
        label: "Project root",
        secondary: branches.find((b) => b.isCurrent)?.name ?? "HEAD",
      },
      ...threads.flatMap((candidate) => {
        const worktree = worktrees.get(candidate.id);
        if (!worktree) return [];
        return [
          {
            value: candidate.id,
            label: candidate.title,
            secondary: worktree.branch,
          },
        ];
      }),
    ];
    setBar({
      kind: "select",
      variant: "list",
      label: "Switch working tree",
      options: workingTrees,
      submit: (value) => {
        setBar(null);
        setSourceControlTreeId(value === "project-root" ? null : value);
        setSourceControlDiffContext(true);
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
    resetNewThreadFlow();
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
  const onPickSpecType = async (specType: string, description: string) => {
    if (!project) return;
    // Optimistic: create the thread, swap to chat immediately, then fire
    // specMode in the background. The agent's response streams in via events.
    setSpecTypePicker(false);
    setTransitioning(true);
    let createdId: string | undefined;
    try {
      const created = await createThreadWithPrefs(project.hash);
      createdId = created.id;
      setBusyFor(created.id, true);
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
      // The echo is what the user typed, not which card they pressed.
      setMessages([
        {
          seq: OPTIMISTIC_SEQ,
          ts: new Date().toISOString(),
          role: "user",
          mode: "spec",
          content: description,
        },
      ]);
      // Fire specMode without awaiting — don't block the UI. The busy state
      // stays true until the agent's turn ends (ExecutorEvent::Done clears it).
      api
        .specMode(project.hash, updated.id, specType, description, false, true)
        .then((meta) => {
          setThreads((prev) => prev.map((t) => (t.id === meta.id ? meta : t)));
          if (current.current.thread?.id === meta.id) setThread(meta);
          if (!flight?.selected) setBusyFor(meta.id, false);
        })
        .catch((err) => {
          if (createdId) setBusyFor(createdId, false);
          fail(err);
        });
    } catch (err) {
      if (createdId) setBusyFor(createdId, false);
      fail(err);
    } finally {
      setTransitioning(false);
    }
  };

  // Keeps the event listener (registered once) pointed at the current thread.
  const current = useRef({ project, thread });
  current.current = { project, thread };
  // ...and at the thread list, so a turn ending on some other thread can be
  // named in its notification.
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const loadEarlier = useCallback(async () => {
    const { project, thread } = current.current;
    const before = oldestSeq(messagesRef.current);
    if (!project || !thread || before === undefined) return;
    const older = await readPage(project.hash, thread.id, before);
    if (current.current.thread?.id !== thread.id) return;
    setMessages((prev) => {
      const have = new Set(prev.map((m) => m.seq));
      return [...older.messages.filter((m) => !have.has(m.seq)), ...prev];
    });
    setHasEarlier(older.hasEarlier);
  }, [setMessages]);

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
    // Stop the live session for this thread. When we can't identify the
    // specific one (e.g. events haven't started streaming yet), fall back to
    // this thread's sessions — never every session in the app, which used to
    // cancel a concurrently running turn in an unrelated thread.
    void api.stopExecutor(liveSessionId ?? undefined, thread?.id);
  }, [liveSessionId, thread?.id]);

  // A thread's live buffer is pruned to its live-only events once history is
  // re-read from disk: everything else (toolCall, toolResult, text, ...) was
  // already persisted as it arrived, so keeping it too would render each one
  // twice. toolOutputDelta/textDelta/reasoningDelta and permissionRequest are
  // never persisted (D-design comment on ExecutorEvent), so they must survive
  // a refresh — including a mid-turn `thread-updated` refresh, where the
  // session generating them is still running and hasn't finished streaming.
  // Scoped to one thread so another thread's in-flight session isn't touched.
  const clearLiveFor = useCallback((threadId: string) => {
    setLiveBySession((previous) => {
      const next = new Map(previous);
      for (const [id, entry] of next) {
        if (entry.threadId !== threadId) continue;
        const kept = entry.events.filter((event) => LIVE_ONLY_KINDS.has(event.kind));
        if (kept.length === 0) {
          next.delete(id);
        } else if (kept.length !== entry.events.length) {
          next.set(id, { ...entry, events: kept });
        }
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
      if (entry.events.some((event) => event.kind === "permissionRequest")) {
        set.add(entry.threadId);
      }
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
  const loadWorktrees = useCallback(async () => {
    const hash = current.current.project?.hash;
    if (!hash) return;
    try {
      const list = await api.threadWorktrees(hash);
      setWorktrees(new Map(list.map((w) => [w.threadId, w])));
    } catch {
      // A non-git project has no worktrees to report; the rows just show none.
      setWorktrees(new Map());
    }
  }, []);
  useEffect(() => {
    const unlisten = listen("worktree-setup-finished", () => { void loadWorktrees(); });
    return () => { unlisten.then((un) => un()); };
  }, [loadWorktrees]);

  const { onRenameThread, onArchiveThread, onDeleteThread, archivingIds, withArchiving } = useThreadActions({
    projectHash: project?.hash ?? null,
    activeThread: thread,
    setThread,
    setThreads,
    setBar,
    fail,
    worktrees,
    loadWorktrees,
    setThreadArchived: pm.setThreadArchived,
    selectThread,
  });

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

  const refresh = useCallback(async () => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    // Re-read only from the oldest message already on screen, so a refresh
    // keeps whatever "Load earlier" has paged in and costs what changed, not
    // the whole thread. A thread not yet loaded (or empty) starts at the newest page.
    const [found, { messages: history, hasEarlier: moreBefore }] = await Promise.all([
      api.listThreads(project.hash),
      readFresh(project.hash, thread.id, oldestSeq(messagesRef.current)),
    ]);
    // The user may have moved on while this read was out.
    if (current.current.thread?.id !== thread.id) return;
    if (moreBefore !== undefined) setHasEarlier(moreBefore);
    const updated = found.find((t) => t.id === thread.id) ?? thread;
    setThreads(found);
    setThread(updated);
    // Everything from `history` on is fresh; keep any older page that landed
    // while this read was out (an optimistic bubble is superseded by its real row).
    const newest = history[0]?.seq ?? Number.POSITIVE_INFINITY;
    setMessages((prev) => [...prev.filter((m) => m.seq !== OPTIMISTIC_SEQ && m.seq < newest), ...history]);
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
  const [chainRun, setChainRun] = useState<ChainRunCardView | null>(null);

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
  // Pairs rather than names: the chain canvas picks by name, but Review has
  // to match a *command* back to the name that runs it.
  const [verifyPairs, setVerifyPairs] = useState<[string, string][]>([]);
  const chainVerifyCommands = useMemo(
    () => verifyPairs.map(([name]) => name),
    [verifyPairs]
  );
  useEffect(() => {
    if (!project) return;
    api
      .verifyCommands(project.hash)
      .then(setVerifyPairs)
      .catch(() => setVerifyPairs([]));
  }, [project]);

  // Live run progress. One run at a time on screen: a second `run_chain` while
  // one is live replaces what the canvas is watching, which is what the user
  // just asked for by starting it.
  useEffect(() => {
    const unlisten = listen<api.ChainEvent>("chain-event", ({ payload }) => {
      setChainRun((previous) => {
        const base: ChainRunCardView =
          previous?.runId === payload.runId
            ? previous
            : {
                runId: payload.runId,
                chain: payload.chain,
                threadId: payload.threadId,
                startedAt: new Date().toISOString(),
                states: {},
                nodes: {},
                awaiting: null,
                outcome: null,
              };
        // ChainEvent carries no timestamp of its own, so per-node
        // startedAt/endedAt/iterations are derived client-side from the
        // transition sequence: a new "executing" after anything else is a
        // new turn, and the run card (Wave I) needs sessionId/cost/timing
        // that the old reducer discarded entirely.
        const nodes = { ...base.nodes };
        if (payload.role && payload.state) {
          const prior = nodes[payload.role];
          const kind = chainStateKind(payload.state);
          const wasExecuting = chainStateKind(prior?.state) === "executing";
          const now = new Date().toISOString();
          const startingTurn = kind === "executing" && !wasExecuting;
          nodes[payload.role] = {
            state: payload.state,
            sessionId: payload.sessionId ?? prior?.sessionId ?? null,
            startedAt: startingTurn ? now : prior?.startedAt,
            endedAt:
              kind === "done" || kind === "failed" || kind === "cancelled"
                ? now
                : prior?.endedAt,
            iterations: startingTurn ? (prior?.iterations ?? 0) + 1 : (prior?.iterations ?? 0),
            cost: payload.cost !== undefined ? payload.cost : prior?.cost,
          };
        }
        return {
          ...base,
          chain: payload.chain,
          threadId: payload.threadId,
          states: payload.role && payload.state
            ? { ...base.states, [payload.role]: payload.state }
            : base.states,
          nodes,
          // A gate event sets it; a node starting its turn clears it, and so
          // does the run ending — approving the last gate produces an outcome
          // and no further node event, which used to leave the approve/reject
          // bar on screen after the chain had already finished.
          awaiting: payload.outcome
            ? null
            : payload.awaitingApproval
              ? {
                  from: payload.awaitingApproval.from,
                  to: payload.awaitingApproval.to,
                  output: payload.awaitingApproval.output,
                }
              : payload.state
                ? null
                : base.awaiting,
          outcome: payload.outcome ?? base.outcome,
        };
      });
      // A finished run is a new history record. The history list re-lists on
      // the same event a save or delete uses (one mechanism, not two), so
      // without this the run only appears after the user re-opens history.
      if (payload.outcome) announceChainsChanged();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  /**
   * Resolving a gate from either surface must disable the other immediately
   * (PLAN §4.5's one-gate-two-surfaces invariant) — both `<ChainCanvas
   * onGateResolved>` and `<ChainRunCard onGateResolved>` call this same
   * function, so the shared `RunView.awaiting.resolved` is the single
   * source of truth neither component keeps a local copy of.
   */
  const onChainGateResolved = useCallback(
    (decision: "approve" | "sendBack" | "reject") => {
      setChainRun((previous) =>
        previous && previous.awaiting
          ? { ...previous, awaiting: { ...previous.awaiting, resolved: decision } }
          : previous
      );
    },
    []
  );

  // A chain node's session IS a thread session (chain_exec.rs), so "click a
  // node, see what it actually did" means scrolling this thread's transcript
  // to where that session began — no second viewer, no new storage format.
  const onChainTranscript = useCallback(
    (sessionId: string) => scrollToSession(sessionId),
    []
  );

  /** Opens a past run (D8) from the chat card's own history section — same
   *  action `ChainsPanel`'s history already offers. */
  const onChainOpenRun = useCallback(
    (runId: string) => {
      if (!project) return;
      void api.getChainRun(project.hash, runId).then((record) => {
        if (!record) return;
        tabs.openChain(record.chainName);
        setChainRun(buildReviewRunView(record));
      });
    },
    [project, tabs]
  );

  /**
   * Starts a chain on `onThread`, opening its canvas to watch. `onThread` is
   * required (D7/D7a): every caller decides explicitly which thread this
   * run belongs to, rather than falling back to whatever thread happened to
   * be focused — that implicit fallback was the run-hijacking bug.
   */
  const startChainRun = useCallback(
    async (name: string, seed: string, onThread: ThreadMeta) => {
      const target = onThread;
      if (!project || !target) return;
      try {
        tabs.openChain(name);
        setChainRun({
          runId: "",
          chain: name,
          threadId: target.id,
          startedAt: new Date().toISOString(),
          states: {},
          nodes: {},
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
    [project, tabs]
  );

  /**
   * Starts a chain that was invoked with no thread of its own — the chains
   * panel, or the canvas's own Run button while editing a chain — rather
   * than commandeering whatever thread happened to be focused (D3/D7). Gets
   * its own thread, named after the chain, and switches to it so the user
   * can watch the run.
   */
  const runChainInNewThread = useCallback(
    async (name: string, seed: string) => {
      if (!project) return;
      try {
        const created = await createThreadWithPrefs(project.hash, name);
        setThreads(await api.listThreads(project.hash));
        await selectThread(project.hash, created);
        await startChainRun(name, seed, created);
      } catch (err) {
        fail(err);
      }
    },
    [project, createThreadWithPrefs, selectThread, startChainRun]
  );

  // Executor output streams in live; once the turn ends, the persisted log
  // becomes the source of truth again so both paths can't drift.
  useEffect(() => {
    // Streamed events pile up here and reach state every LIVE_BATCH_MS. Copying
    // the whole live array (and the Map around it) on every event made a long
    // turn quadratic; an event now costs a push. A timer, not an animation
    // frame: a hidden window pauses frames, and a permission prompt arriving
    // there must still raise the "waiting on you" badge.
    let pending = new Map<string, { threadId: string; events: ExecutorEvent[] }>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushLive = () => {
      flushTimer = undefined;
      const batch = pending;
      if (batch.size === 0) return;
      pending = new Map();
      setLiveBySession((previous) => {
        const next = new Map(previous);
        for (const [id, { threadId, events }] of batch) {
          const entry = next.get(id);
          next.set(id, { threadId, events: entry ? entry.events.concat(events) : events });
        }
        return next;
      });
    };
    const streaming = listen<Envelope>(
      "executor-event",
      async ({ payload: { sessionId, threadId, event } }) => {
        if (event.kind === "done" || event.kind === "crashed") {
          // The session's live entry is dropped below, so anything still
          // waiting for the next frame would only resurrect it.
          pending.delete(sessionId);
          setLiveBySession((previous) => {
            const next = new Map(previous);
            next.delete(sessionId);
            return next;
          });
          // Each thread's own composer unlocks when its own turn ends.
          setBusyFor(threadId, false);
          // Away from the window, this is the one moment worth a system
          // notification; with focus, the board and the sidebar already
          // moved the thread. The helper is silent when the setting is off.
          // Only the window whose project owns the thread speaks up:
          // envelopes reach every window, and two windows must not post
          // the same notification twice.
          const ended = threadsRef.current.find((t) => t.id === threadId);
          if (ended) {
            void notifyTurnDone({
              threadTitle: ended.title,
              kind: event.kind,
              focused: document.hasFocus(),
            });
          }
          // But a session finishing on some other thread must not drag the
          // thread on screen back to its own log.
          if (threadId !== current.current.thread?.id) return;
          // A turn that ends while its thread is on screen in a focused
          // window has been seen: record the view now, or the thread would
          // list itself as "Unreviewed" under the user's nose.
          const hash = current.current.project?.hash;
          if (hash && document.hasFocus()) {
            void api.markThreadViewed(hash, threadId).catch(() => {});
          }
          setDiffRefreshToken((t) => t + 1);
          await refresh().catch(fail);
          return;
        }
        const queued = pending.get(sessionId);
        if (queued) queued.events.push(event);
        else pending.set(sessionId, { threadId, events: [event] });
        flushTimer ??= setTimeout(flushLive, LIVE_BATCH_MS);
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
    // A watcher spawn failure or crash — the routine "not on PATH" case is
    // already covered by the persistent preflight warning banner.
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
      clearTimeout(flushTimer);
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
      diffOpen: shell.diffOpen,
      activePanel: shell.activePanel,
    };
    sessionRef.current = next;
    saveSessionDebounced(hash);
  }, [
    project?.hash,
    tabs.tabs,
    tabs.activePath,
    shell.diffOpen,
    shell.activePanel,
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
            : "",
          thread
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
      const kind = errorKind(err);
      // Readiness runs before a user has attempted a turn. Keep ACP's raw
      // provider diagnostic out of that first experience.
      const error = kind === "transientProvider"
        ? "Temporarily unavailable — retry in a moment."
        : kind === "authRequired"
          ? "Sign in required."
          : describeError(err);
      modelsRef.current = {
        ...modelsRef.current,
        [agentId]: { error },
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
    if (!project) return;
    // No thread yet: the user picked Go from the mode picker and changed
    // their mind in the composer. Same destination as picking Spec there —
    // the framing menu — instead of a toggle that silently does nothing.
    if (!thread) {
      if (pendingMode === "go") {
        setPendingMode(null);
        setSpecTypePicker(true);
      }
      return;
    }
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
      .specMode(project.hash, thread.id, specType, null, prefs.bypass, false)
      .then(() => refresh())
      .catch(fail);
  };

  // D9: spec-type selection from the composer-toggle framing menu — the
  // thread already exists, so this calls specMode directly (no createThread).
  const onPickComposerSpecType = async (
    specType: string,
    description: string
  ) => {
    const { project, thread } = current.current;
    if (!project || !thread) return;
    setComposerSpecTypePicker(false);
    setBusy(true);
    const prefs = resolvePrefs(project.hash, thread.id);
    // Fire specMode without awaiting — busy stays true until the agent's
    // turn ends (ExecutorEvent::Done clears it).
    api
      .specMode(project.hash, thread.id, specType, description, prefs.bypass, true)
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

  // #26: an agent takes one prompt per turn, so a message typed mid-turn used
  // to have nowhere to go — the Send button became Stop and the text sat in
  // the box. The queue holds it, shows it, and sends it the moment the turn
  // ends. Delivery is the same `sendMessage` path an ordinary send takes.
  const sendQueued = useCallback(
    async (queued: QueuedMessage) => {
      const target = threads.find((t) => t.id === queued.threadId);
      const mode: api.Mode = target?.currentMode ?? "go";
      const prefs = resolvePrefs(queued.projectHash, queued.threadId);
      setBusyFor(queued.threadId, true);
      try {
        const sent = await api.sendMessage(
          queued.projectHash,
          queued.threadId,
          queued.text,
          mode,
          prefs.bypass
        );
        // Only the thread the user is actually looking at gets its transcript
        // patched; a background thread's history is re-read when it is opened.
        if (current.current.thread?.id === queued.threadId)
          setMessages((prev) =>
            prev.some((m) => m.seq === sent.seq) ? prev : [...prev, sent]
          );
        if (!flight?.selected) setBusyFor(queued.threadId, false);
      } catch (err) {
        // The message stays in the queue with this error attached rather than
        // vanishing; `useMessageQueue` stops draining until the user retries.
        setBusyFor(queued.threadId, false);
        throw err;
      }
    },
    [threads, flight?.selected, setBusyFor]
  );
  const queue = useMessageQueue(busyThreads, sendQueued);

  const onSend = async () => {
    if (!project || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    // /go and /propose are the same functions the buttons call.
    if (text === "/go") return onGo();
    if (text === "/spec") return onSpec();
    if (text === "/propose") return onPropose();
    // Mid-turn: queue instead of dropping the text on the floor (#26).
    if (thread && busyThreads.has(thread.id)) {
      queue.enqueue(project.hash, thread.id, text);
      return;
    }
    // `|=<chain> <seed>` runs a saved chain instead of prompting the agent
    // (D6/D13). A name that isn't a saved chain falls through as an ordinary
    // message rather than failing — the user may just be typing.
    // The run itself happens *after* the thread-creation block below: a chain
    // needs a thread to run on, and go-mode's composer is exactly where none
    // exists yet, so bailing here made the first `|=` typed into a fresh
    // composer do nothing at all.
    const invocation = parseChainInvocation(
      text,
      chains.map((c) => c.name)
    );
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
        const created = await createThreadWithPrefs(project.hash);
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
  const onReviewWorkingChanges = useCallback(async (treeId?: string) => {
    if (!project || !thread) return;
    try {
      const diff = await api.gitWorkingDiff(project.hash, treeId);
      if (!diff.trim()) {
        fail("No working changes to review.");
        return;
      }
      // The reviewing session belongs to the active conversation, which may
      // be different from the tree selected in Source Control. Put the exact
      // selected diff in the turn so the agent reviews what the user chose,
      // rather than whatever happens to be in its own working directory.
      const reviewText =
        "Review these working changes. Point out correctness bugs, then anything " +
        "over-built. Be specific about file and line; skip praise.\n\n```diff\n" +
        diff +
        "\n```";
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
  // Polled whenever a project is open: the board, Review and the sidebar's
  // thread rows all read these rows, and the sidebar is on screen far more
  // often than the board is. One source for "what does the backend actually
  // know about this thread".
  const fleet = useFleet({ active: !!project && openingProject === null });
  // What "Next unreviewed thread" walks: finished, unopened, newest first.
  const unreviewedThreadIds = useMemo(
    () =>
      fleet.rows
        .filter((r) => r.kind === "thread" && r.status === "unreviewed")
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map((r) => r.threadId),
    [fleet.rows]
  );
  // `onFleetOpen` is defined further down, after the handlers it composes;
  // the command list is built here, so it reaches it through a ref.
  const onFleetOpenRef = useRef<(threadId: string) => void>(() => {});
  const onNextUnreviewed = useCallback(() => {
    const next =
      unreviewedThreadIds.find((id) => id !== current.current.thread?.id) ??
      unreviewedThreadIds[0];
    if (next) onFleetOpenRef.current(next);
  }, [unreviewedThreadIds]);

  const commands = useAppCommands({
    project,
    projects,
    shell,
    tabs,
    codeEditorActive,
    updateReady,
    debugLive,
    liveSessionId,
    runList,
    runLast,
    openFilePalette,
    openTextSearch,
    newFileAtRoot,
    onNewThread,
    onCloneRepository,
    onOpenProjectWindow,
    clearRecentProjects,
    closeWindow,
    quitApplication,
    selectProject,
    runCommand,
    onStop,
    onAddProject,
    onOpenSettings,
    selectedFile,
    setCommandPaletteOpen,
    setSettingsOpen,
    unreviewedCount: unreviewedThreadIds.length,
    onNextUnreviewed,
    activePathRef,
    closeTabRef,
    tabsRef,
  });
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  // Native menu events cannot carry a webview target on macOS. Rust resolves
  // the focused window and emits this event only there; this bridge is the
  // one place that turns its stable id back into the existing command.
  const nativeCommandHandlers = useMemo<Record<string, CommandHandler>>(
    () => Object.fromEntries(commands.map((command) => [command.id, {
      enabled: command.enabled !== false,
      ...(command.checked === undefined ? {} : { checked: command.checked }),
      ...(command.id.startsWith("project.recent.") || command.id.startsWith("run.config.")
        || command.id === "app.checkUpdates" || command.id === "view.rightPanel"
        ? { label: command.label }
        : {}),
      run: command.run,
    }])),
    [commands]
  );
  const nativeCommandBridge = useMemo(
    () => createCommandBridge(nativeCommandHandlers),
    [nativeCommandHandlers]
  );

  useEffect(() => {
    void api.syncNativeMenu(nativeCommandBridge.menuState()).catch(() => {});
  }, [nativeCommandBridge]);

  useEffect(() => {
    const unlisten = listen<string>("native-command", (event) => {
      nativeCommandBridge.dispatchCommand(event.payload);
    }, nativeEventTarget());
    return () => { void unlisten.then((off) => off()); };
  }, [nativeCommandBridge]);

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

  const chatPanel = shell.vibeChat;
  // Chat is the subject of this layout, so the pane you can send away is the
  // editor column — collapsing chat would leave the editor alone on screen,
  // which is a different app.
  const editorCollapsed = shell.editorCollapsed;
  // Fleet and Review take the whole center: they are the board and the
  // review of one thread, not a column beside a transcript.
  const boardPanel =
    shell.activePanel === "fleet" || shell.activePanel === "review";

  // Looking at a thread is what moves it out of "Unreviewed" on the
  // board. Re-marked on window focus too: a turn that finishes while the
  // app is in the background and is read the moment you come back would
  // otherwise keep flagging itself.
  useEffect(() => {
    const hash = project?.hash;
    const id = thread?.id;
    if (!hash || !id) return;
    const mark = () => void api.markThreadViewed(hash, id).catch(() => {});
    mark();
    window.addEventListener("focus", mark);
    return () => window.removeEventListener("focus", mark);
  }, [project?.hash, thread?.id]);

  // ----------------------------------------------------------------- fleet
  // The dock badge counts threads wanting a look: blocked on you (a permission
  // prompt, a gate, a crash) or finished and unread. App-wide, cleared at zero.
  // Rides useFleet's own coalescing, so a streaming agent does not hammer it.
  // A window with no project (welcome screen, or one mid-switch) has empty
  // rows and must not clear a badge another window is keeping up to date.
  useEffect(() => {
    if (!project || openingProject !== null) return;
    const count = fleet.rows.filter(
      (r) => r.status === "attention" || r.status === "unreviewed"
    ).length;
    void api.setDockBadge(count).catch(() => {});
  }, [fleet.rows, project, openingProject]);
  // Threads whose title the backend is still writing (`title_thread`). The
  // skeleton only clears once the new name has been read back, so no surface
  // flashes the "New thread" placeholder between the two.
  const [titlePending, setTitlePending] = useState<Set<string>>(() => new Set());
  const fleetRefresh = fleet.refresh;
  useEffect(() => {
    const un = listen<api.TitlePending>(
      "thread-title-pending",
      ({ payload: { threadId, pending } }) => {
        const mark = () =>
          setTitlePending((prev) => {
            const next = new Set(prev);
            if (pending) next.add(threadId);
            else next.delete(threadId);
            return next;
          });
        if (pending) mark();
        else void Promise.allSettled([refresh(), fleetRefresh()]).then(mark);
      }
    );
    return () => {
      void un.then((off) => off());
    };
  }, [refresh, fleetRefresh]);
  /** The open thread's own row — what the header's verify badge reports. */
  const threadFleetRow = useMemo(
    () =>
      thread
        ? fleet.rows.find((r) => r.kind === "thread" && r.threadId === thread.id)
        : undefined,
    [fleet.rows, thread]
  );
  const fleetAgents = useMemo(
    () =>
      (flight?.agents ?? []).map((agent) => ({
        id: agent.id,
        name: agent.name,
        installed: !!agent.path,
      })),
    [flight]
  );
  /** The board is cross-project; this window can only open its own project's
   *  threads, so a foreign row says so rather than doing nothing. */
  const selectFleetThread = useCallback(
    async (threadId: string) => {
      if (!project) return false;
      const found = threads.find((t) => t.id === threadId);
      if (!found) {
        warn("That run belongs to another project. Open it there first.");
        return false;
      }
      await selectThread(project.hash, found);
      return true;
    },
    [project, threads, selectThread]
  );
  const onFleetOpen = useCallback(
    (threadId: string) => {
      void selectFleetThread(threadId).then((ok) => {
        if (ok) shell.openPanel(null);
      });
    },
    [selectFleetThread, shell.openPanel]
  );
  onFleetOpenRef.current = onFleetOpen;
  const onFleetReview = useCallback(
    (threadId: string) => {
      void selectFleetThread(threadId).then((ok) => {
        if (ok) shell.openPanel("review");
      });
    },
    [selectFleetThread, shell.openPanel]
  );
  const onFleetStop = useCallback((threadId: string) => {
    void api.stopExecutor(undefined, threadId);
  }, []);
  /** A playbook row opens where its run already lives: the Playbooks panel,
   *  with the run selected on the canvas — the same path the panel's own run
   *  history takes. */
  const onFleetOpenRun = useCallback(
    (runId: string) => {
      onChainOpenRun(runId);
      shell.openPanel("chains");
    },
    [onChainOpenRun, shell.openPanel]
  );
  const onFleetCancelRun = useCallback((runId: string) => {
    void api.cancelChainRun(runId);
  }, []);
  const onFleetArchiveRun = useCallback((projectId: string, runId: string) => {
    void withArchiving(runId, () => api.setChainRunArchived(projectId, runId, true))
      .then(() => fleet.refresh())
      .catch(fail);
  }, [withArchiving, fleet.refresh, fail]);
  const onFleetArchive = useCallback(
    (projectId: string, threadId: string) => {
      const found = projectId === project?.hash
        ? threads.find((t) => t.id === threadId)
        : undefined;
      if (found) {
        onArchiveThread(found);
        return;
      }
      void withArchiving(threadId, () => api.setThreadArchived(projectId, threadId, true))
        .then(() => fleet.refresh())
        .catch(fail);
    },
    [project?.hash, threads, onArchiveThread, withArchiving, fleet.refresh, fail]
  );
  const onMergeThread = useCallback(
    async (projectId: string, threadId: string, overrideVerify = false) => {
      try {
        const result = await api.mergeThreadWorktree(
          projectId,
          threadId,
          overrideVerify
        );
        if (!result.merged) {
          // A conflict is a place to work, not an error — say where it is.
          banner(
            result.conflictPath
              ? `Merge conflicts — the half-merged tree is at ${result.conflictPath} (branch ${result.conflictBranch}). Open it to resolve.`
              : result.detail,
            "error"
          );
        }
        if (projectId === project?.hash) await loadWorktrees();
        await fleet.refresh();
      } catch (err) {
        fail(err);
      }
    },
    [project?.hash, loadWorktrees, fleet.refresh]
  );
  const onOpenThreadPr = useCallback(
    async (projectId: string, threadId: string) => {
      try {
        const url = await api.openThreadPr(projectId, threadId);
        if (projectId === project?.hash) await loadWorktrees();
        await openUrl(url);
      } catch (err) {
        fail(err);
      }
    },
    [project?.hash, loadWorktrees]
  );
  /** A run started from the board is the same first send the composer does:
   *  create the thread, put the picks on it, send, and land on it. */
  const onNewRun = useCallback(
    async ({ prompt, agentId, model, mode, isolated }: NewRunInput) => {
      if (!project) return;
      const hash = project.hash;
      try {
        const created = await api.createThread(hash, "New thread");
        if (agentId) await api.setThreadExecutor(hash, created.id, agentId, model ?? null);
        let activeThread = await api.setThreadMode(hash, created.id, mode);
        try {
          activeThread = await api.setThreadWorktreeEnabled(
            hash,
            created.id,
            isolated
          );
        } catch {
          // A project that isn't a git repo has no isolation to set; the
          // thread is still fine (same fallback createThreadWithPrefs makes).
        }
        setThreads(await api.listThreads(hash));
        await selectThread(hash, activeThread);
        shell.openPanel(null);
        setBusy(true);
        const prefs = resolvePrefs(hash, activeThread.id);
        const sent = await api.sendMessage(
          hash,
          activeThread.id,
          prompt,
          mode,
          prefs.bypass
        );
        setMessages((prev) =>
          prev.some((m) => m.seq === sent.seq) ? prev : [...prev, sent]
        );
        api.listThreads(hash).then(setThreads, () => {});
        if (!flight?.selected) setBusy(false);
      } catch (err) {
        setBusy(false);
        fail(err);
      }
    },
    [project, selectThread, shell.openPanel, resolvePrefs, flight?.selected]
  );

  // ---------------------------------------------------------------- review
  const [reviewFiles, setReviewFiles] = useState<ReviewFile[]>([]);
  const [reviewPatch, setReviewPatch] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  useEffect(() => {
    if (shell.activePanel !== "review" || !project || !thread) {
      setReviewFiles([]);
      setReviewPatch("");
      return;
    }
    let cancelled = false;
    setReviewLoading(true);
    // The same helper the Fleet board measures with — the lane used to parse
    // the working diff itself, which sees no untracked file and nothing of
    // the skip-list, so the two surfaces could disagree about one thread.
    Promise.all([
      api.threadReviewFiles(project.hash, thread.id),
      api.threadReviewDiff(project.hash, thread.id),
    ])
      .then(([rows, patch]) => {
        if (cancelled) return;
        setReviewFiles(rows);
        setReviewPatch(patch);
      })
      .catch(() => {
        if (cancelled) return;
        setReviewFiles([]);
        setReviewPatch("");
      })
      .finally(() => !cancelled && setReviewLoading(false));
    return () => {
      cancelled = true;
    };
  }, [shell.activePanel, project?.hash, thread?.id, diffRefreshToken]);

  const renderReview = () => {
    if (!project || !thread)
      return (
        <ReviewRunList
          runs={fleet.rows.filter((r) => r.kind !== "playbook")}
          onSelect={onFleetReview}
          onGoToFleet={() => shell.openPanel("fleet")}
        />
      );
    const row = fleet.rows.find((r) => r.threadId === thread.id);
    const worktree = worktrees.get(thread.id);
    return (
      <ReviewPane
        threadId={thread.id}
        title={thread.title}
        branch={row?.branch ?? worktree?.branch}
        baseBranch={worktree?.baseBranch}
        diff={row?.diff ?? { added: 0, removed: 0, files: 0, untracked: 0 }}
        files={reviewFiles}
        loadingFiles={reviewLoading}
        verify={verifyPairs.length ? (row?.verify ?? { state: "not_run" }) : { state: "unconfigured" }}
        merge={row?.merge ?? (worktree ? "clean" : "no_worktree")}
        renderDiff={(path) => (
          <DiffPane
            projectHash={project.hash}
            threadId={thread.id}
            focusPath={path}
            refreshToken={diffRefreshToken}
            reviewPatch={reviewPatch}
            onOpenInEditor={(file) => {
              shell.openPanel(null);
              selectFile(file);
            }}
          />
        )}
        onRunVerify={() => {
          // The command this thread's evidence was measured with, else the
          // project's first configured one.
          const name =
            verifyPairs.find(([, cmd]) => cmd === row?.verify.command)?.[0] ??
            verifyPairs[0]?.[0];
          if (!name) return;
          api.runVerify(project.hash, name, thread.id).catch(fail);
        }}
        onMerge={({ override }) =>
          void onMergeThread(project.hash, thread.id, override)
        }
        onOpenPr={() => void onOpenThreadPr(project.hash, thread.id)}
        onOpenInEditor={(path) => {
          shell.openPanel(null);
          selectFile(path);
        }}
        onBackToFleet={() => {
          setThread(null);
          shell.openPanel("review");
        }}
        projectHash={project.hash}
        setup={{ state: worktree?.setupState, output: worktree?.setupOutput }}
        onRerunSetup={() => {
          api.rerunWorktreeSetup(project.hash, thread.id).then(loadWorktrees, fail);
        }}
        onVerificationConfigured={() => {
          api.verifyCommands(project.hash).then(setVerifyPairs, () => {});
          void fleet.refresh();
        }}
      />
    );
  };

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
  // The editor pane reports these while mounted; with no file it is not
  // mounted at all, so the status bar has to be cleared from here.
  useEffect(() => {
    if (selectedFile) return;
    setLspStatus(null);
    setCursorPosition(null);
  }, [selectedFile]);
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
  // Know before you type, not just after a turn already died on it (#19
  // follow-up): probe the thread's real executor once when it opens.
  // `probeAgentModels` already caches per agent id, so switching back to a
  // thread already probed this run costs nothing. Deliberately scoped to an
  // *open thread's* actual executor — never all installed agents, and never
  // on the onboarding screen (`OnboardingScreen.tsx`'s own probe stays
  // click-only there), because a probe is a real spawn and at least one
  // agent (Devin) launches its own sign-in flow the moment it's probed.
  useEffect(() => {
    if (!project || !thread || !activeExecutor) return;
    probeAgentModels(activeExecutor);
  }, [project, thread?.id, activeExecutor, probeAgentModels]);
  const chatProps = {
    project,
    titlePendingIds: titlePending,
    thread,
    messages,
    historyLoading,
    hasEarlier,
    onLoadEarlier: loadEarlier,
    live,
    sessionId: liveSessionId,
    onPermissionAnswered: (requestId: string) => {
      setLiveBySession((previous) => {
        let changed = false;
        const next = new Map(previous);
        for (const [id, entry] of next) {
          const events = entry.events.filter(
            (event) =>
              event.kind !== "permissionRequest" || event.id !== requestId
          );
          if (events.length !== entry.events.length) {
            changed = true;
            next.set(id, { ...entry, events });
          }
        }
        return changed ? next : previous;
      });
    },
    busy,
    worktree: thread ? worktrees.get(thread.id) : undefined,
    verify: threadFleetRow?.verify,
    onArchiveSelf: thread ? () => onArchiveThread(thread) : undefined,
    onWorktreeChanged: loadWorktrees,
    onError: (message: string) => banner(message, "error"),
    // The code changes themselves, in the editor column — not the Source
    // Control panel, which is where committing and pushing live.
    onViewDiff: () => {
      setDiffFocusPath(null);
      // A pinned commit from the graph must not keep hiding the working
      // tree the user just asked to see.
      setDiffCommit(null);
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
    mentionFiles: paletteFiles,
    onOpenMentions: ensurePaletteFiles,
    queued: queue.items.filter((m) => m.threadId === thread?.id),
    onRemoveQueued: queue.remove,
    onRetryQueued: queue.retry,
    onStop,
    onRenameThread,
    onSpec,
    onGo,
    onApply,
    agentLogins,
    agentLoginsFor,
    onAgentLogin,
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
    worktreeEnabled: thread
      ? thread.worktreeEnabled !== false
      : pendingWorktreeEnabled,
    // The lock is the first message: a thread that made a worktree but never
    // spoke has nothing invested in it, and switching removes it again.
    worktreeLocked: messages.length > 0,
    onToggleWorktree,
    prefsMenuOpen,
    setPrefsMenuOpen,
    hasLiveSession,
    threads: openThreads,
    onSelectThread: onSelectVibeThread,
    onCloseThread: onCloseThreadTab,
    onNewThread,
    // Only the thread that actually invoked this run gets its card — a run
    // started on thread A must never bleed into thread B's chat.
    chainRun: chainRun && thread && chainRun.threadId === thread.id ? chainRun : null,
    onChainTranscript,
    onChainGateResolved,
    onChainOpenRun,
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
        <Suspense fallback={<PanelLoadingSkeleton label="Loading table" />}>
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
        <Suspense fallback={<PanelLoadingSkeleton label="Loading editor" />}>
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
        <PreviewPane projectHash={project.hash} url={tab.url} onNavigate={(url) => tabs.openPreview(url)} />
      );
    }
    if (tab?.type === "chain") {
      return (
        <ChainCanvas
          projectHash={project.hash}
          chainName={tab.chainName}
          agents={chainAgents}
          verifyCommands={chainVerifyCommands}
          onRun={(name, seed) => void runChainInNewThread(name, seed)}
          onSaved={(name) => tabs.renameChain(tab.chainName, name)}
          onTranscript={onChainTranscript}
          onGateResolved={onChainGateResolved}
          // Only the chain that is actually running gets the watching state;
          // opening a different chain mid-run still shows a normal canvas.
          run={chainRun?.chain === tab.chainName ? chainRun : null}
        />
      );
    }
    // .ipynb opens as an ordinary file tab (decisions.md D21) — branch here
    // rather than a new tab type, same divergence point table/query/chain
    // already use. onUnopenable falls through to FileEditorPane below by
    // forcing a re-render as a non-notebook path via unopenableNotebooks.
    if (selectedFile?.toLowerCase().endsWith(".ipynb") && !unopenableNotebooks.has(selectedFile)) {
      return (
        <Suspense fallback={<PanelLoadingSkeleton label="Loading notebook" />}>
          <NotebookTab
            projectHash={project.hash}
            path={selectedFile}
            onDirtyChange={tabs.setDirty}
            onUnopenable={() => {
              // Falling back to the text editor with no explanation left the
              // user looking at a .ipynb that simply refused to render as a
              // notebook. Say why, then let them fix the JSON by hand.
              warn(
                `${selectedFile} isn't valid notebook JSON — opening it as text so you can repair it.`
              );
              setUnopenableNotebooks((prev) => new Set(prev).add(selectedFile));
            }}
          />
        </Suspense>
      );
    }
    // Nothing open: teach the ways in rather than describe the absence.
    if (!selectedFile) return <EditorEmptyState commands={commands} />;
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
            workingTrees={[
              {
                id: null,
                label: "Project root",
                branch: branches.find((b) => b.isCurrent)?.name ?? "HEAD",
              },
              ...threads.flatMap((candidate) => {
                const worktree = worktrees.get(candidate.id);
                if (!worktree) return [];
                return [{
                  id: candidate.id,
                  label: candidate.title,
                  branch: worktree.branch,
                }];
              }),
            ]}
            selectedTreeId={sourceControlTreeId}
            onOpenWorkingTreePicker={onOpenWorkingTreePicker}
            branch={
              (sourceControlTreeId ? worktrees.get(sourceControlTreeId)?.branch : undefined) ??
              branches.find((b) => b.isCurrent)?.name ??
              "HEAD"
            }
            refreshToken={diffRefreshToken}
            onOpenFile={(path) => openDiffFor(path)}
            onReviewWorkingChanges={onReviewWorkingChanges}
            onSelectCommit={openCommitDiff}
            onSelectWorkingChanges={openWorkingChangesDiff}
            onOpenBranchPicker={onOpenBranchPicker}
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
        return (
          <ConnectionsPanel
            projectHash={project.hash}
            onLogin={onAgentLogin}
            mcp={<McpPane projectHash={project.hash} onError={fail} />}
          />
        );
      case "database":
        return (
          <Suspense fallback={<PanelLoadingSkeleton label="Loading database" />}>
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
            agents={chainAgents}
            onOpen={(name) => tabs.openChain(name)}
            onRun={(name, seed) => void runChainInNewThread(name, seed)}
            onOpenRun={(runId) => {
              if (!project) return;
              void api.getChainRun(project.hash, runId).then((record) => {
                if (!record) return;
                tabs.openChain(record.chainName);
                setChainRun(buildReviewRunView(record));
              });
            }}
            onRerun={(runId, fromRole) =>
              thread && void api.rerunChainRun(project.hash, runId, fromRole, thread.id)
            }
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
              <Suspense fallback={<PanelLoadingSkeleton label="Loading sessions" />}>
                <SessionsPanel
                  projectHash={project.hash}
                  threads={threads}
                  worktrees={worktrees}
                />
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
                onSelectProject={selectProject}
                onAddProject={onAddProject}
                onRenameProject={onRenameProject}
                onOpenProjectWindow={onOpenProjectWindow}
                onRemoveProject={onRemoveProject}
              />
            </div>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <ArchivingContext.Provider value={archivingIds}>
    <div className="ds-window" data-testid="window-shell">
      <div className="app" data-color-mode="dark">
        <header
          className="ds-top-chrome"
          data-testid="top-chrome"
          onMouseDown={onTitlebarMouseDown}
        >
          <h1 className="sr-only">Palisade Code</h1>
          {/* A thread is a page inside Fleet: back leaves it, and Agent Access is
              the compact Fleet beside it — quick access without leaving. Chat is
              never closable, so hiding the list can never empty the canvas. */}
          {project && !boardPanel && (
            <div className="ds-pill-group" role="group" aria-label="Fleet navigation">
              <Tooltip label="Back to Fleet (Cmd+K)">
                <ActionIcon
                  variant="subtle"
                  className="ds-icon-btn"
                  onClick={() => shell.openPanel("fleet")}
                  aria-label="Back to Fleet"
                  data-testid="back-to-fleet"
                  data-tauri-drag-region-exclude
                >
                  <IconArrowLeft size={14} />
                  <span className="ds-chrome-label">Fleet</span>
                </ActionIcon>
              </Tooltip>
              <Tooltip
                label={
                  attentionThreads.size > 0
                    ? `Agent Access · ${attentionThreads.size} thread${attentionThreads.size === 1 ? "" : "s"} waiting on you`
                    : "Agent Access"
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
                    aria-label={shell.sessionListOpen ? "Hide agent access" : "Show agent access"}
                    aria-pressed={shell.sessionListOpen}
                    data-testid="toggle-session-list"
                    data-tauri-drag-region-exclude
                  >
                    <IconLayoutSidebar size={14} />
                  </ActionIcon>
                </Indicator>
              </Tooltip>
            </div>
          )}
          <div className="ds-chrome-utils">
            <BetaBadge onUpdateReady={setUpdateReady} />
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
            <div className="ds-pill-group" role="group" aria-label="Workspace panels">
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
            {/* The secondary pane is the editor column — chat is the
                subject, so that is the side that can be sent away. */}
            {project && !boardPanel && (
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
            </div>
            )}
            <div className="ds-pill-group" role="group" aria-label="Application controls">
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
          </div>
        </header>
        {/* No agent at all is a first-run situation, not a warning line: it
            gets the checklist. Anything else preflight has to say keeps the
            plain banner. */}
        {flight && flight.agents.length === 0 ? (
          <FirstRunChecklist
            flight={flight}
            checking={rechecking}
            onRecheck={() => {
              setRechecking(true);
              api
                .preflight(true)
                .then(setFlight, fail)
                .finally(() => setRechecking(false));
            }}
          />
        ) : flight && flight.warnings.length > 0 ? (
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
        ) : null}

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
              onOpenProjectWindow={onOpenProjectWindow}
              onRemoveProject={onRemoveProject}
              openingHash={openingProject}
            />
          ) : (
            // One arrangement: chat leads, the editor column sits beside it,
            // and CSS `order` puts the rail and its panel at the right edge.
            // `data-preset` stays as the hook those order rules hang on.
          <div
            className="ds-shell-contents"
            data-preset="vibe"
            data-editor={editorCollapsed ? "collapsed" : undefined}
            data-testid="vibe-shell"
          >
            {/* Fleet is already every thread in every project; a thread list
                beside it would be the same question asked twice. */}
            {!boardPanel && shell.sessionListOpen && (
              <SessionList
                threads={threads}
                loading={openingProject === project.hash}
                activeThread={thread ?? undefined}
                /* `busyThreads` is already exactly "threads with a live
                   session" — no second derivation of the same state. */
                liveThreadIds={busyThreads}
                attentionThreadIds={attentionThreads}
                titlePendingIds={titlePending}
                worktrees={worktrees}
                /* Same rows the board renders — one source for what the
                   backend knows about a thread, whichever surface asks. */
                fleetRows={fleet.rows}
                onNewThread={onNewThread}
                onSelect={onSelectVibeThread}
                onRename={onRenameThread}
                onArchive={onArchiveThread}
                userOpened={shell.sessionListUserOpened}
              />
            )}

            <NavRail
              activePanel={shell.activePanel}
              onSelect={onSelectPanel}
              dirtyGit={dirtyCount > 0}
            />

            {shell.activePanel && !boardPanel && (
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

            {shell.activePanel && !boardPanel && (
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
              {shell.activePanel === "fleet" ? (
                <FleetBoard
                  rows={fleet.rows}
                  loading={fleet.loading}
                  error={fleet.error}
                  projectName={project?.displayName}
                  projectHash={project?.hash}
                  agents={fleetAgents}
                  liveThreadIds={busyThreads}
                  titlePendingIds={titlePending}
                  onOpen={onFleetOpen}
                  onReview={onFleetReview}
                  onStop={onFleetStop}
                  onMerge={onMergeThread}
                  onOpenPr={onOpenThreadPr}
                  onArchive={onFleetArchive}
                  onOpenRun={onFleetOpenRun}
                  onCancelRun={onFleetCancelRun}
                  onArchiveRun={onFleetArchiveRun}
                  onNewRun={onNewRun}
                />
              ) : shell.activePanel === "review" ? (
                renderReview()
              ) : (
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
                    onGoToFile={() => void openFilePalette()}
                  />
                  {!shell.diffOpen ? (
                    renderCenterTab()
                  ) : (
                    <div className="messages" data-testid="messages">
                      {project && (
                        <DiffPane
                          projectHash={project.hash}
                          /* Source Control's selected context is explicit:
                             the diff must never silently snap back to the
                             focused conversation's worktree. But absent an
                             explicit choice, "View diff" on the active
                             thread should show that thread's own worktree,
                             not the (clean) project root PR #37 left as the
                             unreachable default. */
                          threadId={
                            sourceControlDiffContext
                              ? (sourceControlTreeId ?? undefined)
                              : (thread?.id ?? undefined)
                          }
                          refreshToken={diffRefreshToken}
                          focusPath={diffFocusPath}
                          onClearFocus={() => setDiffFocusPath(null)}
                          commit={diffCommit}
                          onClearCommit={() => setDiffCommit(null)}
                        />
                      )}
                    </div>
                  )}
                </main>
                )}

                {/* Nothing to size against once the editor pane is gone. */}
                {!editorCollapsed && !shell.chatCollapsed && (
                  <div
                    className="ds-resize-handle ds-resize-handle-x"
                    data-testid="resize-right-panel"
                    onPointerDown={bindDrag(
                      chatPanel.handleProps,
                      "col-resize"
                    )}
                  />
                )}
                {/* Collapsing hides ChatSurface with CSS, never unmounts it:
                    scroll position and a streaming turn survive. The whole
                    rail is a click target for reopening, not just the icon. */}
                <aside
                  className="ds-chat-rail"
                  data-testid="right-sidebar"
                  data-collapsed={shell.chatCollapsed ? "true" : undefined}
                  style={{ "--panel-w": `${chatPanel.size}px` } as CSSProperties}
                  onClick={shell.chatCollapsed ? shell.toggleChat : undefined}
                >
                  <div className="ds-chat-rail-head">
                    <span className="ds-chat-rail-title">Thread</span>
                    <ChatPaneToggle
                      collapsed={shell.chatCollapsed}
                      editorCollapsed={editorCollapsed}
                      onToggle={shell.toggleChat}
                    />
                    {shell.chatCollapsed && (attentionThreads.size > 0 || hasLiveSession) && (
                      <span
                        className="ds-chat-rail-dot"
                        data-attention={attentionThreads.size > 0 ? "true" : undefined}
                        data-testid="chat-rail-dot"
                        role="img"
                        aria-label={
                          attentionThreads.size > 0
                            ? "An agent is waiting on you"
                            : "An agent is working"
                        }
                      />
                    )}
                  </div>
                  <ChatSurface
                    {...chatProps}
                    loading={openingProject === project.hash}
                  />
                </aside>
              </div>
              )}

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
                          onOpenPreview={(url) => tabs.openPreview(url)}
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
            trailing={<DevServerChips servers={devServers} onOpen={(url) => tabs.openPreview(url)} />}
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
          <MantineModal opened onClose={() => { bar.onCancel?.(); setBar(null); }} title={bar.label}>
            <div className="confirm-actions">
              <button
                onClick={bar.onConfirm}
                className="danger"
                data-testid="confirm-delete"
                autoFocus
              >
                {bar.confirmLabel ?? "Delete"}
              </button>
              <button onClick={() => { bar.onCancel?.(); setBar(null); }}>Cancel</button>
            </div>
          </MantineModal>
        )}

        {bar && bar.kind === "select" && (
          <MantineModal opened onClose={() => setBar(null)} title={bar.label}>
            <ul className="ds-branch-list" data-testid="branch-list">
              {(selectQuery.trim()
                ? bar.options.filter(
                    (option) => fuzzyMatch(selectQuery, option.label) !== null
                  )
                : bar.options
              ).map((option) => {
                // Only a real local, non-current branch can be deleted —
                // remote-only entries here are DWIM checkout targets, not
                // branches that exist locally to delete (GIT-14). Working
                // trees have neither concept, so both stay branch-only.
                const local =
                  bar.variant === "branch" &&
                  branches.find(
                    (b) => !b.isRemote && b.name === option.value
                  );
                // Git allows a branch in exactly one worktree, so this row
                // cannot switch — it opens the tree the branch already lives
                // in. Said on the row rather than after the click: an action
                // that silently does something else is worse than one that
                // fails. Deleting is off the table for the same reason git
                // refuses it — the branch is in use.
                const worktree =
                  bar.variant === "branch"
                    ? worktreeBranches.get(option.value)
                    : undefined;
                return (
                  <li
                    key={option.value}
                    role="button"
                    tabIndex={0}
                    onClick={() => bar.submit(option.value)}
                    onKeyDown={onActivateKey(() => bar.submit(option.value))}
                    data-testid="branch-option"
                    aria-label={
                      worktree
                        ? `${option.label} — open its worktree at ${worktree}`
                        : option.secondary
                          ? `${option.label} — ${option.secondary}`
                          : option.label
                    }
                  >
                    <span className="ds-branch-name" title={option.label}>
                      {option.label}
                    </span>
                    {option.secondary && !worktree && (
                      <span className="ds-branch-secondary">
                        {option.secondary}
                      </span>
                    )}
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
                            label: `Delete branch "${option.label}"? This can't be undone.`,
                            onConfirm: async () => {
                              setBar(null);
                              if (!project) return;
                              try {
                                await api.gitDeleteBranch(project.hash, option.value);
                                await refreshBranches(project.hash);
                              } catch (err) {
                                fail(err);
                              }
                            },
                          });
                        }}
                        title="Delete branch"
                        aria-label={`Delete branch ${option.label}`}
                        data-testid="branch-delete"
                      >
                        <DeleteIcon />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {bar.variant === "branch" && (
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
            )}
            <span className="hint">
              {bar.variant === "branch" ? (
                <>
                  Click a branch to switch · Enter a name to create · Esc to
                  cancel
                  {worktreeBranches.size > 0 && (
                    <> · a branch marked <b>worktree</b> opens that worktree</>
                  )}
                </>
              ) : (
                <>Click a working tree to switch · Esc to cancel</>
              )}
            </span>
          </MantineModal>
        )}
      </div>
    </div>
    </ArchivingContext.Provider>
  );
}
