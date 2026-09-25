import { useState } from "react";
import { ActionIcon, Box, Menu, Textarea, TextInput } from "@mantine/core";
import {
  IconAlertTriangle,
  IconBox,
  IconBrandTelegram,
  IconChevronDown,
  IconCircleCheck,
  IconDots,
  IconFolder,
  IconAppWindow,
  IconTrash,
  IconGitFork,
  IconLoader2,
  IconMessage,
  IconRefresh,
} from "@tabler/icons-react";
import palisadeWordmark from "../assets/palisade-wordmark-darkmode-no-bg.png";
import { relativeTime } from "./SessionList";
import type { ModelState, Preflight, Project } from "./api";
import { isAuthError } from "./errors";
import { AddAgentMenuSection } from "./AddAgentMenu";

// Amendment 9's project-first first-run screen (shape brief, 2026-08-24):
// project creation is the primary action, not the composer. Replaces
// Amendment 8's composer-first layout — see git history for that version.
//
// Deliberately absent, per PRODUCT.md: any account/sign-in UI, tier or plan
// badge, or "Pro" label. Palisade has no bundled billing; inventing one on the
// first screen a new user sees would misrepresent the product.
//
// The composer's provider/model pickers reuse the in-thread composer's own
// `.ds-composer-picker` class and `IconBox`/`IconBrandTelegram` iconography rather
// than a onboarding-only look — this is the same control, just reached
// before a project exists. Spec/Go doesn't appear here: with no thread yet
// there's nothing to toggle, so a send from this screen always runs go mode.

type Models = ModelState | "loading" | { error: string } | undefined;

export default function OnboardingScreen({
  projects,
  flight,
  executor,
  model,
  models,
  agentModels,
  onPickExecutor,
  onPickModel,
  onProbeAgent,
  onAddAgent,
  addingAgentId = null,
  onOpenProject,
  onCloneRepository,
  onComposerSend,
  onSelectProject,
  onOpenProjectWindow,
  onRemoveProject,
  openingHash = null,
}: {
  projects: Project[];
  flight: Preflight | null;
  /** The chosen provider, or null to use whatever was auto-detected. */
  executor: string | null;
  model: string | null;
  models: Models;
  /** Every agent's own probed model/auth state, keyed by agent id — what the
   *  detection chip's dropdown lists so a user can see every installed
   *  agent's status at once, not just the one currently active in the
   *  composer below. */
  agentModels?: Record<string, Models>;
  onPickExecutor: (agentId: string) => void;
  onPickModel: (modelId: string) => void;
  /** Probes (or re-probes) one agent's models — doubles as the reauth retry
   *  action for a row in the detection chip's dropdown, since a fresh probe
   *  is exactly what "try again" means here. Omitted where there's nowhere
   *  to route it (no such caller today), in which case the dropdown reports
   *  status only, with no retry action. */
  onProbeAgent?: (agentId: string) => void;
  /** Enables a registry agent from `flight.addable` (see `AddAgentMenu`). */
  onAddAgent?: (agentId: string) => void;
  /** The addable agent currently being enabled, if any — disables its row
   *  so a double-click can't fire `onAddAgent` twice. */
  addingAgentId?: string | null;
  onOpenProject: () => void;
  onCloneRepository: () => void;
  /** Opens a project folder, then creates a go-mode thread and sends this
   *  text on it — unlike `onOpenProject`, the request isn't dropped. */
  onComposerSend: (text: string) => void;
  onSelectProject: (project: Project) => void;
  /** #33: open this project in its own window, leaving this one where it is. */
  onOpenProjectWindow?: (project: Project) => void;
  /** #28: forget a saved project. Source files and history are kept. */
  onRemoveProject?: (project: Project) => void;
  /** Hash of the project currently being opened, if any. Switching a project
   *  is several round-trips; without this the row looked dead on click. */
  openingHash?: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const detected = flight?.selected ?? null;
  const detectedName =
    flight?.agents?.find((a) => a.id === detected)?.name ?? detected;

  // The chip only speaks to whether an agent binary was *found* on PATH —
  // finding it says nothing about whether its own login is still good. A
  // model probe is what actually knows that, but probing means spawning the
  // agent's own CLI, and for some agents that spawn is not read-only — an
  // unauthenticated Devin CLI kicked off its own reauth flow the moment it
  // was probed just to populate this list. So nothing here is probed
  // automatically, on mount or on open: every row starts at whatever's
  // already cached from actual use (e.g. the composer's own model picker),
  // and a check is only ever run from an explicit click on that row.
  const agentStatus = (
    id: string
  ): "checking" | "ready" | "reauth" | "error" | "unknown" => {
    const state = agentModels?.[id];
    if (state === "loading") return "checking";
    if (state && typeof state === "object" && "error" in state)
      return isAuthError(state.error) ? "reauth" : "error";
    return state ? "ready" : "unknown";
  };
  const detectedStatus = detected ? agentStatus(detected) : "unknown";

  // The picker's own choice wins over detection; detection is the default,
  // not a lock — the same precedence the in-thread picker uses.
  const activeAgent = executor ?? detected;
  const activeAgentName =
    flight?.agents?.find((a) => a.id === activeAgent)?.name ?? activeAgent;
  const modelList =
    models && models !== "loading" && !("error" in models) ? models.models : [];
  const agentSelected =
    models && models !== "loading" && !("error" in models)
      ? models.current
      : null;
  const currentModelId = model ?? agentSelected ?? undefined;
  const modelLabel =
    modelList.find((m) => m.id === currentModelId)?.name ??
    (models === "loading" ? "Loading models…" : "default");
  const query = modelQuery.trim().toLowerCase();
  const filteredModels = query
    ? modelList.filter(
        (m) =>
          m.name.toLowerCase().includes(query) ||
          m.id.toLowerCase().includes(query)
      )
    : modelList;

  const submit = () => {
    if (!draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    setComposerOpen(false);
    onComposerSend(text);
  };

  return (
    <div className="ds-onboarding" data-testid="onboarding">
      <div className="ds-onboarding-inner">
        <div className="ds-onboarding-top">
          <div className="ds-onboarding-mark-wrap">
            <img
              className="ds-onboarding-mark"
              src={palisadeWordmark}
              alt="Palisade"
              draggable={false}
            />
          </div>

          {/* A missing agent is a launch blocker, so it earns a distinct,
              warn-toned treatment rather than sharing the detected state's
              styling. `flight === null` means the preflight request just
              hasn't resolved yet — that read as a false "no agent found"
              flash on every launch until this was split from the
              genuinely-empty case. Once at least one agent is found, the
              chip becomes a dropdown — the composer below still owns
              *picking* a provider, but a user has no other way to see
              which installed agents are actually usable versus needing to
              sign back in. */}
          {flight && detectedName ? (
            <Menu
              opened={statusMenuOpen}
              onChange={setStatusMenuOpen}
              withinPortal
              position="bottom-start"
            >
              <Menu.Target>
                <button
                  type="button"
                  className={`ds-onboarding-status${
                    detectedStatus === "reauth" || detectedStatus === "error"
                      ? " bad"
                      : ""
                  }`}
                  data-testid="onboarding-status"
                >
                  <span className="ds-onboarding-status-dot" />
                  Detected: <strong>{detectedName}</strong>
                  <IconChevronDown size={12} />
                </button>
              </Menu.Target>
              <Menu.Dropdown
                className="ds-model-menu ds-onboarding-status-menu"
                data-testid="onboarding-status-menu"
              >
                <Menu.Label>Installed agents</Menu.Label>
                {flight.agents.map((a) => {
                  const status = agentStatus(a.id);
                  const state = agentModels?.[a.id];
                  const error =
                    state && typeof state === "object" && "error" in state
                      ? state.error
                      : null;
                  return (
                    <Menu.Item
                      key={a.id}
                      component="div"
                      data-testid={`onboarding-agent-status-${a.id}`}
                      className={`status-${status}`}
                      closeMenuOnClick={false}
                    >
                      <div className="ds-onboarding-agent-row">
                        <div className="ds-onboarding-agent-row-top">
                          <span className="ds-onboarding-agent-row-name">
                            {a.name}
                            {a.id === detected && (
                              <span className="ds-onboarding-agent-row-default">
                                default
                              </span>
                            )}
                          </span>
                          {status === "checking" && (
                            <span className="ds-onboarding-agent-row-checking">
                              <IconLoader2 size={13} className="ds-spin" />
                              Checking…
                            </span>
                          )}
                          {status === "ready" && (
                            <span className="ds-onboarding-agent-row-ok">
                              <IconCircleCheck size={13} />
                              Ready
                            </span>
                          )}
                          {status === "unknown" && (
                            <button
                              type="button"
                              className="ds-onboarding-status-action subtle"
                              onClick={(e) => {
                                e.stopPropagation();
                                onProbeAgent?.(a.id);
                              }}
                              data-testid={`onboarding-check-${a.id}`}
                            >
                              Check status
                            </button>
                          )}
                          {status === "error" && (
                            <span className="ds-onboarding-agent-row-warn">
                              <IconAlertTriangle size={13} />
                              Issue
                            </span>
                          )}
                          {status === "reauth" && (
                            <span className="ds-onboarding-agent-row-warn">
                              <IconAlertTriangle size={13} />
                              Needs reauth
                            </span>
                          )}
                        </div>
                        {/* The failure text stayed in a `title` tooltip
                            before this — invisible on touch, and to a screen
                            reader. What broke and how to fix it are both
                            shown outright now, not hidden behind hover. */}
                        {(status === "error" || status === "reauth") && (
                          <div className="ds-onboarding-agent-row-detail">
                            <span
                              className="ds-onboarding-agent-row-detail-text"
                              title={error ?? undefined}
                            >
                              {error}
                            </span>
                            <button
                              type="button"
                              className="ds-onboarding-status-action"
                              onClick={(e) => {
                                e.stopPropagation();
                                onProbeAgent?.(a.id);
                              }}
                              data-testid={
                                status === "reauth"
                                  ? `onboarding-reauth-${a.id}`
                                  : `onboarding-retry-${a.id}`
                              }
                            >
                              <IconRefresh size={12} />
                              {status === "reauth" ? "Reauthenticate" : "Retry"}
                            </button>
                          </div>
                        )}
                      </div>
                    </Menu.Item>
                  );
                })}
                <div className="ds-onboarding-status-footnote">
                  Checking an agent runs it briefly — only done on request.
                </div>
                {onAddAgent && (
                  <AddAgentMenuSection
                    addable={flight?.addable ?? []}
                    onAdd={onAddAgent}
                    addingId={addingAgentId}
                    testIdPrefix="onboarding-add-agent"
                  />
                )}
              </Menu.Dropdown>
            </Menu>
          ) : flight && (flight.addable?.length ?? 0) > 0 && onAddAgent ? (
            // No agent ready yet, but at least one could be added — a
            // choice to make, not a dead end, so this gets its own dropdown
            // rather than the flat "no agent found" line below.
            <Menu
              opened={statusMenuOpen}
              onChange={setStatusMenuOpen}
              withinPortal
              position="bottom-start"
            >
              <Menu.Target>
                <button
                  type="button"
                  className="ds-onboarding-status bad"
                  data-testid="onboarding-status"
                >
                  <span className="ds-onboarding-status-dot" />
                  Choose your coding agent
                  <IconChevronDown size={12} />
                </button>
              </Menu.Target>
              <Menu.Dropdown
                className="ds-model-menu ds-onboarding-status-menu"
                data-testid="onboarding-status-menu"
              >
                <AddAgentMenuSection
                  addable={flight.addable}
                  onAdd={onAddAgent}
                  addingId={addingAgentId}
                  testIdPrefix="onboarding-add-agent"
                />
              </Menu.Dropdown>
            </Menu>
          ) : (
            <div
              className={`ds-onboarding-status${flight ? " bad" : " loading"}`}
              data-testid="onboarding-status"
            >
              <span className="ds-onboarding-status-dot" />
              {!flight
                ? "Checking for installed agents…"
                : "No coding agent found — install Claude Code or Codex, then reopen Palisade."}
            </div>
          )}
        </div>

        <h1 className="ds-onboarding-greeting">
          {projects.length > 0 ? "Welcome back" : "Welcome to Palisade"}
        </h1>

        <div className="ds-onboarding-cards">
          <button
            className="ds-onboarding-card primary"
            onClick={onOpenProject}
            data-testid="add-project"
          >
            <span className="ds-onboarding-card-icon">
              <IconFolder size={19} />
            </span>
            <span className="ds-onboarding-card-title">New Project</span>
            <span className="ds-onboarding-card-body">
              Point Palisade at a local folder. Every thread you start here
              runs in its own isolated worktree.
            </span>
          </button>
          <button
            className="ds-onboarding-card"
            onClick={onCloneRepository}
            data-testid="clone-repository"
          >
            <span className="ds-onboarding-card-icon">
              <IconGitFork size={19} />
            </span>
            <span className="ds-onboarding-card-title">Clone Repository</span>
            <span className="ds-onboarding-card-body">
              Clone from a URL, then open it as a new project automatically.
            </span>
          </button>
        </div>

        {composerOpen ? (
          <div className="ds-onboarding-composer">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Describe what you want an agent to build…"
              aria-label="Request"
              minRows={1}
              maxRows={6}
              variant="unstyled"
              autoFocus
              data-testid="onboarding-composer"
              styles={{ input: { paddingLeft: 4 } }}
            />
            <div className="ds-onboarding-composer-row">
              <Menu withinPortal position="top-start">
                <Menu.Target>
                  <button
                    className="ds-composer-picker"
                    data-testid="onboarding-agent-pill"
                  >
                    <IconBox size={14} />
                    <span className="ds-composer-picker-label">
                      {activeAgentName ?? "no agent detected"}
                    </span>
                    <IconChevronDown size={12} />
                  </button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>Provider</Menu.Label>
                  {flight?.agents?.length ? (
                    flight.agents.map((a) => (
                      <Menu.Item
                        key={a.id}
                        onClick={() => onPickExecutor(a.id)}
                        data-testid={`onboarding-executor-opt-${a.id}`}
                      >
                        {a.name}
                        {a.id === activeAgent ? " ·" : ""}
                      </Menu.Item>
                    ))
                  ) : (
                    <Menu.Item disabled>No ACP agents installed</Menu.Item>
                  )}
                </Menu.Dropdown>
              </Menu>

              {/* A provider can list 150+ models, so this is the same
                  search-plus-capped-scroll pattern the in-thread picker uses
                  (App.tsx's `ds-model-menu`) rather than a second variant. */}
              <Menu
                withinPortal
                position="top-start"
                closeOnItemClick
                onOpen={() => setModelQuery("")}
              >
                <Menu.Target>
                  <button
                    className={`ds-composer-picker${
                      currentModelId ? " selected" : ""
                    }`}
                    disabled={!activeAgent}
                    data-testid="onboarding-model-pill"
                  >
                    <IconBox size={14} />
                    <span className="ds-composer-picker-label">
                      {modelLabel}
                    </span>
                    <IconChevronDown size={12} />
                  </button>
                </Menu.Target>
                <Menu.Dropdown className="ds-model-menu">
                  <Menu.Label>Model</Menu.Label>
                  <TextInput
                    placeholder="Search models…"
                    value={modelQuery}
                    onChange={(e) => setModelQuery(e.currentTarget.value)}
                    size="xs"
                    mb={6}
                    data-testid="onboarding-model-search"
                  />
                  <Box style={{ maxHeight: 210, overflowY: "auto" }}>
                    {models === "loading" && (
                      <Menu.Item disabled>Loading…</Menu.Item>
                    )}
                    {models && typeof models === "object" && "error" in models && (
                      <Menu.Item disabled>{models.error}</Menu.Item>
                    )}
                    {modelList.length === 0 && models !== "loading" && (
                      <Menu.Item disabled>
                        This agent manages its own model
                      </Menu.Item>
                    )}
                    {filteredModels.map((m) => (
                      <Menu.Item
                        key={m.id}
                        onClick={() => onPickModel(m.id)}
                        data-testid={`onboarding-model-opt-${m.id}`}
                      >
                        {m.name}
                        {m.id === currentModelId ? " ·" : ""}
                      </Menu.Item>
                    ))}
                    {filteredModels.length === 0 && modelQuery && (
                      <Menu.Item
                        disabled
                        data-testid="onboarding-models-no-matches"
                      >
                        No models match “{modelQuery}”.
                      </Menu.Item>
                    )}
                  </Box>
                </Menu.Dropdown>
              </Menu>

              <div className="ds-onboarding-spacer" />

              <ActionIcon
                data-testid="onboarding-send"
                disabled={!draft.trim()}
                aria-label="Send message"
                size={30}
                radius="md"
                variant="filled"
                onClick={submit}
                styles={{
                  root: {
                    backgroundColor: "var(--accent)",
                    color: "var(--accent-on)",
                  },
                }}
              >
                <IconBrandTelegram size={17} />
              </ActionIcon>
            </div>
          </div>
        ) : (
          <button
            className="ds-onboarding-composer-toggle"
            onClick={() => setComposerOpen(true)}
            data-testid="onboarding-composer-toggle"
          >
            <IconMessage size={13} /> Or describe what you want to build first
          </button>
        )}

        <h2 className="ds-section-heading">Recent Projects</h2>
        {projects.length > 0 ? (
          <div className="ds-onboarding-recent">
            {projects.map((p) => {
              const opening = openingHash === p.hash;
              // One at a time: a second switch mid-flight would race the
              // first one's tab restore.
              const pick = (
                event?: React.MouseEvent | React.KeyboardEvent
              ) => {
                // VS Code's convention: ⌘/Ctrl-click a recent project opens
                // it in a second window instead of taking over this one.
                if (event?.metaKey || event?.ctrlKey) {
                  onOpenProjectWindow?.(p);
                  return;
                }
                if (!openingHash) onSelectProject(p);
              };
              return (
                <div
                  key={p.hash}
                  className={`ds-onboarding-recent-row${
                    opening ? " opening" : ""
                  }`}
                  role="button"
                  tabIndex={0}
                  aria-busy={opening || undefined}
                  aria-disabled={openingHash && !opening ? true : undefined}
                  onClick={pick}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      pick(e);
                    }
                  }}
                  title={
                    onOpenProjectWindow
                      ? `${p.root}\n⌘-click to open in a new window`
                      : p.root
                  }
                  data-testid="recent-project"
                >
                  <IconFolder size={15} />
                  <span className="ds-onboarding-recent-text">
                    <span className="ds-onboarding-recent-name">
                      {p.displayName}
                    </span>
                    <span className="ds-onboarding-recent-path">
                      {opening ? "Opening…" : p.root}
                    </span>
                  </span>
                  <span className="ds-onboarding-recent-time">
                    {opening ? "…" : relativeTime(p.lastAccessedAt)}
                  </span>
                  {(onOpenProjectWindow || onRemoveProject) && (
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
                          <IconDots size={14} />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {onOpenProjectWindow && (
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
                        )}
                        {onRemoveProject && (
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
                        )}
                      </Menu.Dropdown>
                    </Menu>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="empty ds-onboarding-recent-empty">
            No projects yet — open or clone one above to get started.
          </p>
        )}
      </div>
    </div>
  );
}
