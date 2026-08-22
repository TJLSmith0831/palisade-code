import { useState } from "react";
import {
  ActionIcon,
  Box,
  Button,
  Loader,
  Menu,
  TextInput,
  Textarea,
} from "@mantine/core";
import {
  IconChevronDown,
  IconCpu,
  IconFolder,
  IconFolderOpen,
  IconGitBranch,
  IconGitFork,
  IconSend,
  IconSparkles,
} from "@tabler/icons-react";
import palisadeWordmark from "../assets/palisade-wordmark-darkmode-no-bg.png";
import type { ModelState, Preflight, Project } from "./api";

// Amendment 8's first-run screen: shown whenever no project is open. Stands
// outside the Vibe/Editor governing rule entirely — with nothing open there
// is nothing for either preset to arrange (v1 scope note).
//
// Deliberately absent, per PRODUCT.md: any account/sign-in UI, tier or plan
// badge, or "Pro" label. Palisade has no bundled billing; inventing one on the
// first screen a new user sees would misrepresent the product.

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
  onSelectProject: (project: Project) => void;
  /** Hash of the project currently being opened, if any. Switching a project
   *  is several round-trips; without this the row looked dead on click. */
  openingHash?: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const detected = flight?.selected ?? null;
  const detectedName =
    flight?.agents?.find((a) => a.id === detected)?.name ?? detected;

  // The picker's own choice wins over detection; detection is the default,
  // not a lock — the same precedence the thread picker uses.
  const activeAgent = executor ?? detected;
  const activeAgentName =
    flight?.agents?.find((a) => a.id === activeAgent)?.name ?? activeAgent;
  const modelList =
    models && models !== "loading" && !("error" in models) ? models.models : [];
  // The user's own pick wins; otherwise show what the agent reports as
  // current, so the pill names a real model rather than a placeholder.
  const agentSelected =
    models && models !== "loading" && !("error" in models)
      ? models.current
      : null;
  const modelLabel =
    modelList.find((m) => m.id === (model ?? agentSelected ?? undefined))
      ?.name ?? (models === "loading" ? "Loading models…" : "default");
  const query = modelQuery.trim().toLowerCase();
  const filteredModels = query
    ? modelList.filter(
        (m) =>
          m.name.toLowerCase().includes(query) ||
          m.id.toLowerCase().includes(query)
      )
    : modelList;

  // Palisade is project-scoped (PRODUCT.md): there is no directory-less
  // execution path, so a message with nowhere to run prompts for a
  // directory rather than being silently accepted.
  const submit = () => {
    if (!draft.trim()) return;
    onOpenProject();
  };

  return (
    <div className="ds-onboarding" data-testid="onboarding">
      <div className="ds-onboarding-inner">
        <img
          className="ds-onboarding-mark"
          src={palisadeWordmark}
          alt="Palisade"
          draggable={false}
        />

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
            placeholder="Type a request, or select a project below to get started…"
            aria-label="Request"
            rows={1}
            variant="unstyled"
            data-testid="onboarding-composer"
          />
          {/* Only controls that do something live here. The mockup's
              add-context, bypass-permissions and dictate affordances are
              per-thread settings with nothing to attach to before a project
              exists — a dead button on the first screen is worse than no
              button. They appear in the real composer once a thread opens. */}
          <div className="ds-onboarding-composer-row">
            <div className="ds-onboarding-spacer" />

            {/* Provider and model are both switchable before a project is
                open — the choice seeds the first thread rather than locking
                the user into whatever happened to be auto-detected. */}
            <Menu withinPortal position="top-end">
              <Menu.Target>
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<IconSparkles size={13} />}
                  rightSection={<IconChevronDown size={12} />}
                  data-testid="onboarding-agent-pill"
                >
                  {activeAgentName ?? "No agent detected"}
                </Button>
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
              position="top-end"
              closeOnItemClick
              onOpen={() => setModelQuery("")}
            >
              <Menu.Target>
                <Button
                  size="compact-xs"
                  variant="default"
                  leftSection={<IconCpu size={13} />}
                  rightSection={<IconChevronDown size={12} />}
                  disabled={!activeAgent}
                  data-testid="onboarding-model-pill"
                >
                  {modelLabel}
                </Button>
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
                      {m.id === (model ?? agentSelected) ? " ·" : ""}
                    </Menu.Item>
                  ))}
                  {filteredModels.length === 0 && modelQuery && (
                    <Menu.Item disabled data-testid="onboarding-models-no-matches">
                      No models match “{modelQuery}”.
                    </Menu.Item>
                  )}
                </Box>
              </Menu.Dropdown>
            </Menu>

            <ActionIcon
              radius="xl"
              aria-label="Send"
              onClick={submit}
              data-testid="onboarding-send"
            >
              <IconSend size={15} />
            </ActionIcon>
          </div>
          <div className="ds-onboarding-dir-row">
            <button
              className="ds-onboarding-dir-pick"
              onClick={onOpenProject}
              data-testid="onboarding-select-directory"
            >
              <IconFolderOpen size={13} /> Select a directory…
            </button>
            {/* Sending with text in the box opens the directory picker and
                does not carry the text into the project (Palisade is
                project-scoped — PRODUCT.md). Saying so beats letting the
                request look accepted and then vanish. */}
            {draft.trim() && (
              <span className="ds-onboarding-dir-hint">
                Pick a project folder first — this request isn't sent yet.
              </span>
            )}
          </div>
        </div>

        {/* Executor detection belongs here, not buried in Settings — a
            first-time user should not have to open a project and hit a dead
            end to learn nothing is installed. */}
        <div className="ds-onboarding-detect" data-testid="onboarding-detect">
          {detectedName ? (
            <>
              <span className="ds-onboarding-detect-dot ok" />
              Detected on this machine: <strong>{detectedName}</strong>
              <span className="ds-onboarding-detect-note">
                · switches automatically per machine
              </span>
            </>
          ) : (
            <>
              <span className="ds-onboarding-detect-dot bad" />
              No coding agent found on this machine — install Claude Code or
              Codex, then reopen Palisade.
            </>
          )}
        </div>

        <div className="ds-onboarding-cards">
          <button
            className="ds-onboarding-card"
            onClick={onOpenProject}
            data-testid="add-project"
          >
            <IconFolder size={19} />
            <span className="ds-onboarding-card-title">Open Project</span>
            <span className="ds-onboarding-card-body">
              Point Palisade at a local folder. Everything stays scoped to that
              project root.
            </span>
          </button>
          <button
            className="ds-onboarding-card"
            onClick={onCloneRepository}
            data-testid="clone-repository"
          >
            <IconGitFork size={19} />
            <span className="ds-onboarding-card-title">Clone Repository</span>
            <span className="ds-onboarding-card-body">
              Clone from a URL, then open it as a new project automatically.
            </span>
          </button>
        </div>

        {projects.length > 0 && (
          <>
            <h2 className="ds-section-heading">Recent Projects</h2>
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
                    aria-disabled={
                      openingHash && !opening ? true : undefined
                    }
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
                    <span className="ds-onboarding-recent-branch">
                      {opening ? (
                        <Loader size={12} />
                      ) : (
                        <IconGitBranch size={12} />
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}

      </div>
    </div>
  );
}
