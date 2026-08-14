import { useMemo, useState } from "react";
import { Button, TextInput } from "@mantine/core";
import { IconPlus, IconSearch } from "@tabler/icons-react";
import type { Project, ThreadMeta } from "./api";

// Amendment 3's Vibe-only session list: the browse/search surface, distinct
// from the in-conversation thread-tab strip (which stays as the quick
// switcher). Hidden entirely in the Editor preset.

/** A short age label. Clamps future timestamps — clock skew across machines
 *  must never render "-3m ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function filterThreads(threads: ThreadMeta[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return threads;
  return threads.filter((t) => t.title.toLowerCase().includes(needle));
}

export default function SessionList({
  threads,
  projects,
  activeProject,
  activeThread,
  liveThreadIds,
  onNewThread,
  onSelect,
}: {
  threads: ThreadMeta[];
  projects: Project[];
  activeProject: Project | undefined;
  activeThread: ThreadMeta | undefined;
  /** Threads with a live/busy session — drives the accent dot. */
  liveThreadIds: Set<string>;
  onNewThread: () => void;
  onSelect: (thread: ThreadMeta) => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => filterThreads(threads, query), [threads, query]);

  // Group headers are the workspace name — Floo already has a workspace
  // picker, so this is not an invented "Spaces" concept.
  const groups = useMemo(() => {
    const byHash = new Map<string, ThreadMeta[]>();
    for (const thread of visible) {
      const list = byHash.get(thread.projectHash) ?? [];
      list.push(thread);
      byHash.set(thread.projectHash, list);
    }
    return [...byHash.entries()].map(([hash, list]) => ({
      hash,
      name:
        projects.find((p) => p.hash === hash)?.displayName ??
        activeProject?.displayName ??
        "Workspace",
      list,
    }));
  }, [visible, projects, activeProject]);

  return (
    <aside className="ds-sessions" data-testid="session-list" aria-label="Threads">
      <Button
        variant="default"
        fullWidth
        leftSection={<IconPlus size={14} />}
        onClick={onNewThread}
        data-testid="session-new-thread"
      >
        New thread
      </Button>

      <TextInput
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
        placeholder="Search threads…"
        aria-label="Search threads"
        leftSection={<IconSearch size={14} />}
        mt={8}
        data-testid="session-search"
      />

      <div className="ds-sessions-list">
        {visible.length === 0 && <p className="empty">No threads.</p>}
        {groups.map((group) => (
          <div key={group.hash}>
            <h2 className="ds-section-heading">{group.name}</h2>
            {group.list.map((thread) => (
              <div
                key={thread.id}
                className={`ds-session-item${
                  thread.id === activeThread?.id ? " active" : ""
                }`}
                role="button"
                tabIndex={0}
                aria-current={thread.id === activeThread?.id}
                onClick={() => onSelect(thread)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(thread);
                  }
                }}
                data-testid="session-item"
              >
                <div className="ds-session-title">{thread.title}</div>
                <div className="ds-session-meta">
                  {relativeTime(thread.updatedAt)}
                </div>
                {liveThreadIds.has(thread.id) && (
                  <span
                    className="ds-session-dot"
                    aria-label="session running"
                  />
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
