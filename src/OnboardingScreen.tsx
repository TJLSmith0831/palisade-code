import { useState } from "react";
import { ActionIcon, Box, Menu, Textarea, TextInput } from "@mantine/core";
import {
  IconBox,
  IconBrandTelegram,
  IconChevronDown,
  IconFolder,
  IconGitFork,
  IconMessage,
} from "@tabler/icons-react";
import palisadeWordmark from "../assets/palisade-wordmark-darkmode-no-bg.png";
import { relativeTime } from "./SessionList";
import type { ModelState, Preflight, Project } from "./api";

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
  onPickExecutor,
  onPickModel,
  onOpenProject,
  onCloneRepository,
  onComposerSend,
  onSelectProject,
  openingHash = null,
}: {
  projects: Project[];
  flight: Preflight | null;
  /** The chosen provider, or null to use whatever was auto-detected. */
  executor: string | null;
  model: string | null;
  models: Models;
  onPickExecutor: (agentId: string) => void;
  onPickModel: (modelId: string) => void;
  onOpenProject: () => void;
  onCloneRepository: () => void;
  /** Opens a project folder, then creates a go-mode thread and sends this
   *  text on it — unlike `onOpenProject`, the request isn't dropped. */
  onComposerSend: (text: string) => void;
  onSelectProject: (project: Project) => void;
  /** Hash of the project currently being opened, if any. Switching a project
   *  is several round-trips; without this the row looked dead on click. */
  openingHash?: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const detected = flight?.selected ?? null;
  const detectedName =
    flight?.agents?.find((a) => a.id === detected)?.name ?? detected;

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

          {/* Detection-only status: no picker lives here, that's the
              composer's job below. A missing agent is a launch blocker, so
              it earns a distinct, warn-toned treatment rather than sharing
              the detected state's styling. `flight === null` means the
              preflight request just hasn't resolved yet — that read as a
              false "no agent found" flash on every launch until this was
              split from the genuinely-empty case. */}
          <div
            className={`ds-onboarding-status${
              flight ? (detectedName ? "" : " bad") : " loading"
            }`}
            data-testid="onboarding-status"
          >
            <span className="ds-onboarding-status-dot" />
            {!flight ? (
              "Checking for installed agents…"
            ) : detectedName ? (
              <>
                Detected: <strong>{detectedName}</strong>
              </>
            ) : (
              "No coding agent found — install Claude Code or Codex, then reopen Palisade."
            )}
          </div>
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
              Point Palisade at a local folder. Everything stays scoped to
              that project root.
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
              placeholder="Describe what you want to build…"
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
              const pick = () => {
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
                      pick();
                    }
                  }}
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
