import { useCallback, useEffect, useState } from "react";
import { ActionIcon, Button, Loader, Menu, Stack, Text, Textarea, Tooltip } from "@mantine/core";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconGitBranch,
  IconMinus,
  IconPlus,
  IconRefresh,
  IconSparkles,
} from "@tabler/icons-react";
import * as api from "./api";
import type { FileStatus, LogEntry } from "./api";
import { relativeTime } from "./SessionList";

// Amendment 7's Source Control panel: the primary git surface, behind the
// left rail's Source Control icon. Built from mockup.html's #panel-git.
//
// Status chips reuse the existing semantic tokens (--warn modified,
// --success added/untracked) and always carry their letter, so color is
// never the only signal (DESIGN.md's One Accent Rule + pair-color-with-text).

/** Git's two-char porcelain code → the single letter the chip shows. */
export function statusChip(code: string): { letter: string; tone: string } {
  const trimmed = code.trim();
  if (trimmed === "??" || trimmed.startsWith("A")) {
    return { letter: trimmed === "??" ? "U" : "A", tone: "success" };
  }
  if (trimmed.startsWith("D")) return { letter: "D", tone: "bad" };
  return { letter: "M", tone: "warn" };
}

/**
 * Whether the file has something in the index. Porcelain's *first* column is
 * the index and the second is the working tree, so " M" (edited, unstaged)
 * and "M " (staged) differ only by position — reading the trimmed code would
 * make every change look staged.
 */
export function isStaged(code: string): boolean {
  const index = code[0] ?? " ";
  return index !== " " && index !== "?";
}

/** `src-tauri/src/lsp.rs` → `{ name: "lsp.rs", dir: "src-tauri/src" }`. */
export function splitPath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { name: path, dir: "" }
    : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

function Section({
  id,
  title,
  count,
  open,
  onToggle,
  actions,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="ds-sc-section" data-testid={`sc-${id}-section`}>
      <div className="ds-sc-section-head">
        <button
          className="ds-sc-section-toggle"
          onClick={onToggle}
          aria-expanded={open}
          data-testid={`sc-toggle-${id}`}
        >
          {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          {title}
          {count !== undefined && <span className="ds-sc-count">{count}</span>}
        </button>
        {actions}
      </div>
      {open && children}
    </section>
  );
}

function FileRow({
  file,
  action,
  onOpen,
  onAction,
}: {
  file: FileStatus;
  action: "stage" | "unstage";
  onOpen: () => void;
  onAction: () => void;
}) {
  const { name, dir } = splitPath(file.path);
  const chip = statusChip(file.code);
  return (
    // The whole row opens the file, not just the filename: the row *looks*
    // clickable (it has a hover state and a pointer cursor), so a click on
    // the padding beside the name did nothing and read as unresponsive.
    <div
      className="ds-sc-file"
      data-testid="sc-file"
      onClick={onOpen}
      role="presentation"
    >
      <button
        className="ds-sc-file-open"
        onClick={(event) => {
          // The row handler already does this; without stopping here it
          // fires twice.
          event.stopPropagation();
          onOpen();
        }}
        title={file.path}
      >
        <span className="ds-sc-file-text">
          <span className="ds-sc-fname">{name}</span>
          <span className="ds-sc-fpath">{dir}</span>
        </span>
      </button>
      <Tooltip
        label={action === "stage" ? "Stage this file" : "Unstage this file"}
        withinPortal
      >
        <ActionIcon
          variant="subtle"
          size="sm"
          aria-label={`${action === "stage" ? "Stage" : "Unstage"} ${file.path}`}
          onClick={(event) => {
            // Staging is not opening — the row handler must not also fire.
            event.stopPropagation();
            onAction();
          }}
          data-testid={`sc-${action}-${file.path}`}
        >
          {action === "stage" ? <IconPlus size={14} /> : <IconMinus size={14} />}
        </ActionIcon>
      </Tooltip>
      <span
        className={`ds-sc-status ds-sc-status-${chip.tone}`}
        aria-label={`status ${chip.letter}`}
      >
        {chip.letter}
      </span>
    </div>
  );
}

export default function SourceControlPanel({
  projectHash,
  threadId,
  branch,
  refreshToken,
  onOpenFile,
  onReviewWorkingChanges,
  onError,
}: {
  projectHash: string;
  /** The active thread, so Generate drafts with the provider/model the user
   *  picked in the chat pane rather than whatever was auto-detected. */
  threadId?: string | null;
  branch: string;
  /** Bumped by the app whenever the working tree may have changed. */
  refreshToken?: number;
  onOpenFile: (path: string) => void;
  /** Sends the working diff to the active agent as a chat turn. */
  onReviewWorkingChanges: () => void;
  onError: (message: unknown) => void;
}) {
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  // GIT-20/GIT-21: a non-git project made every reload reject identically
  // ("fatal: not a git repository") from both gitStatus and gitLog, each
  // separately calling onError — a burst of duplicate toasts with no way to
  // stop them, and no way to actually init the repo from the UI. Detected
  // once per reload and shown as a single graceful prompt instead.
  const [notARepo, setNotARepo] = useState(false);
  const [initializing, setInitializing] = useState(false);
  /** `[ahead, behind]` against the upstream, or null when there isn't one. */
  const [aheadBehind, setAheadBehind] = useState<[number, number] | null>(null);
  /** Distinguishes "level with upstream" from "there is no upstream" —
   *  both show no counts, but only one is worth explaining. */
  const [hasUpstream, setHasUpstream] = useState(true);
  const [message, setMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [openSections, setOpenSections] = useState({
    staged: true,
    changes: true,
    graph: true,
  });

  const toggle = (key: keyof typeof openSections) =>
    setOpenSections((s) => ({ ...s, [key]: !s[key] }));

  const reload = useCallback(() => {
    api
      .gitStatus(projectHash)
      .then((value) => {
        setNotARepo(false);
        setFiles(value);
      })
      .catch((err) => {
        if (/not a git repository/i.test(String(err))) {
          setNotARepo(true);
          return;
        }
        onError(err);
      });
    api
      .gitLog(projectHash, 12)
      .then(setLog)
      .catch((err) => {
        // "Not a git repository" is reported once already, via gitStatus
        // above — a second identical toast from the same cause is noise.
        if (/not a git repository/i.test(String(err))) return;
        onError(err);
      });
    // No upstream is a normal state, not an error — no counts, no banner.
    api.gitAheadBehind(projectHash).then(
      (value) => {
        setAheadBehind(value);
        setHasUpstream(value !== null);
      },
      () => {
        setAheadBehind(null);
        setHasUpstream(false);
      }
    );
  }, [projectHash, onError]);

  useEffect(reload, [reload, refreshToken]);

  const [ahead, behind] = aheadBehind ?? [0, 0];
  const staged = files.filter((f) => isStaged(f.code));
  const unstaged = files.filter((f) => !isStaged(f.code));

  const act = (run: Promise<unknown>) => run.then(reload).catch(onError);

  /** Git takes an exclusive lock on the index, so staging N files is N
   *  sequential calls. `Promise.all` raced them and half failed with
   *  "Unable to create '.git/index.lock': File exists". */
  const forEachSequentially = async (
    entries: FileStatus[],
    run: (path: string) => Promise<unknown>
  ) => {
    for (const entry of entries) await run(entry.path);
  };

  const generate = () => {
    setGenerating(true);
    api
      .draftCommitMessage(projectHash, threadId ?? null)
      .then(setMessage)
      .catch(onError)
      .finally(() => setGenerating(false));
  };

  const commit = () => {
    if (!message.trim() || staged.length === 0) return;
    setCommitting(true);
    api
      .gitCommit(projectHash, message.trim())
      .then(() => {
        setMessage("");
        reload();
      })
      .catch(onError)
      .finally(() => setCommitting(false));
  };

  return (
    <div className="ds-sc" data-testid="source-control-panel">
      <div className="ds-panel-head">
        <span>Source Control</span>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" size="sm" aria-label="More actions">
              <IconDots size={15} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {/* fetch/pull/push live here rather than as primary buttons —
                Amendment 7 supersedes the old git-btn cluster. */}
            <Menu.Item
              onClick={() => act(api.gitFetch(projectHash))}
            >
              Fetch
            </Menu.Item>
            {!hasUpstream && (
              <Menu.Item disabled data-testid="sc-no-upstream">
                No upstream yet — Push will set one
              </Menu.Item>
            )}
            <Menu.Item
              onClick={() => act(api.gitPull(projectHash))}
              data-testid="sc-pull"
            >
              Pull{behind > 0 ? ` ${behind}` : ""}
            </Menu.Item>
            <Menu.Item
              onClick={() => act(api.gitPush(projectHash))}
              data-testid="sc-push"
            >
              Push{ahead > 0 ? ` ${ahead}` : ""}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>

      {notARepo ? (
        <div className="ds-panel-body">
          <Stack gap="xs" p="xs" data-testid="sc-not-a-repo">
            <Text size="xs" c="dimmed">
              This folder isn't a git repository yet.
            </Text>
            <Button
              size="xs"
              variant="default"
              loading={initializing}
              data-testid="sc-git-init"
              onClick={() => {
                setInitializing(true);
                api
                  .gitInit(projectHash)
                  .then(() => {
                    setNotARepo(false);
                    reload();
                  })
                  .catch(onError)
                  .finally(() => setInitializing(false));
              }}
            >
              Initialize repository
            </Button>
          </Stack>
        </div>
      ) : (
      <div className="ds-panel-body">
        <div className="ds-sc-commit-box">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) {
                e.preventDefault();
                commit();
              }
            }}
            placeholder={`Message (⌘Enter to commit on ${branch})`}
            aria-label="Commit message"
            rows={3}
            data-testid="sc-commit-message"
          />
          <Button
            className="ds-sc-generate"
            size="compact-xs"
            variant="light"
            leftSection={
              generating ? <Loader size={11} /> : <IconSparkles size={13} />
            }
            disabled={generating}
            onClick={generate}
            data-testid="sc-generate"
          >
            {generating ? "Drafting…" : "Generate"}
          </Button>
        </div>

        <Button
          fullWidth
          leftSection={<IconCheck size={14} />}
          disabled={!message.trim() || staged.length === 0 || committing}
          onClick={commit}
          data-testid="sc-commit"
        >
          Commit{staged.length > 0 ? ` ${staged.length}` : ""}
        </Button>
        <Button
          fullWidth
          variant="default"
          mt={6}
          leftSection={<IconSparkles size={14} />}
          onClick={onReviewWorkingChanges}
          data-testid="sc-review"
        >
          Review Working Changes
        </Button>

        <Section
          id="staged"
          title="Staged Changes"
          count={staged.length}
          open={openSections.staged}
          onToggle={() => toggle("staged")}
          actions={
            staged.length > 0 && (
              <Tooltip label="Unstage all" withinPortal>
                <ActionIcon
                  variant="subtle"
                  size="sm"
                  aria-label="Unstage all"
                  onClick={() =>
                    act(
                      forEachSequentially(staged, (path) =>
                        api.gitUnstageFile(projectHash, path)
                      )
                    )
                  }
                  data-testid="sc-unstage-all"
                >
                  <IconMinus size={15} />
                </ActionIcon>
              </Tooltip>
            )
          }
        >
          {staged.length === 0 && <p className="empty">Nothing staged.</p>}
          {staged.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              action="unstage"
              onOpen={() => onOpenFile(file.path)}
              onAction={() => act(api.gitUnstageFile(projectHash, file.path))}
            />
          ))}
        </Section>

        <Section
          id="changes"
          title="Changes"
          count={unstaged.length}
          open={openSections.changes}
          onToggle={() => toggle("changes")}
          actions={
            <div className="ds-sc-row-icons">
              {unstaged.length > 0 && (
                <Tooltip label="Stage all" withinPortal>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label="Stage all"
                    onClick={() =>
                      act(
                        forEachSequentially(unstaged, (path) =>
                          api.gitStageFile(projectHash, path)
                        )
                      )
                    }
                    data-testid="sc-stage-all"
                  >
                    <IconCheck size={15} />
                  </ActionIcon>
                </Tooltip>
              )}
              <Tooltip label="Refresh" withinPortal>
                <ActionIcon
                  variant="subtle"
                  size="sm"
                  aria-label="Refresh"
                  onClick={reload}
                  data-testid="sc-refresh"
                >
                  <IconRefresh size={15} />
                </ActionIcon>
              </Tooltip>
            </div>
          }
        >
          {unstaged.length === 0 && <p className="empty">No changes.</p>}
          {unstaged.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              action="stage"
              onOpen={() => onOpenFile(file.path)}
              onAction={() => act(api.gitStageFile(projectHash, file.path))}
            />
          ))}
        </Section>

        <Section
          id="graph"
          title="Graph"
          open={openSections.graph}
          onToggle={() => toggle("graph")}
        >
          <div className="ds-sc-graph" data-testid="sc-graph">
            {log.length === 0 && <p className="empty">No commits yet.</p>}
            {log.map((entry, index) => (
              <div
                key={entry.hash}
                className={`ds-sc-commit${index === 0 ? " current" : ""}`}
              >
                <div className="ds-sc-commit-dot" />
                <div className="ds-sc-commit-text">
                  <span className="ds-sc-commit-msg">{entry.subject}</span>
                  <span className="ds-sc-commit-meta">
                    {entry.author}
                    {entry.date ? ` · ${relativeTime(entry.date)}` : ""}
                  </span>
                </div>
                {index === 0 && (
                  <span className="ds-sc-branch-badge">
                    <IconGitBranch size={11} />
                    {branch}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Section>
      </div>
      )}
    </div>
  );
}
