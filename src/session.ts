/**
 * What the editor was showing, per project, so relaunching lands you back
 * where you were rather than on an empty pane.
 *
 * localStorage rather than the Rust store: this is personal UI state, the
 * same call `palisade:layout:<hash>:*` already makes, and it means no IPC on
 * the project-switch path.
 */

export const sessionKey = (projectHash: string) => `palisade:session:${projectHash}`;

export type EditorSession = {
  /** Open tabs, in tab-bar order. */
  openPaths: string[];
  activePath: string | null;
  /** Cursor offset per path, so a restored tab opens where you left it. */
  cursors: Record<string, number>;
  expandedDirs: string[];
  centerShell: "vibe" | "editor";
  diffOpen: boolean;
  includeHidden: boolean;
};

const EMPTY: EditorSession = {
  openPaths: [],
  activePath: null,
  cursors: {},
  expandedDirs: [],
  centerShell: "editor",
  diffOpen: false,
  includeHidden: false,
};

/** Narrow an unknown parse result to the shape we expect, field by field.
 * A session written by an older build (or hand-edited) should cost you the
 * fields that changed, not the whole restore. */
function coerce(raw: unknown): EditorSession {
  if (typeof raw !== "object" || raw === null) return { ...EMPTY };
  const value = raw as Record<string, unknown>;

  const openPaths = Array.isArray(value.openPaths)
    ? value.openPaths.filter((p): p is string => typeof p === "string")
    : [];
  const activePath =
    typeof value.activePath === "string" && openPaths.includes(value.activePath)
      ? value.activePath
      : (openPaths[openPaths.length - 1] ?? null);

  const cursors: Record<string, number> = {};
  if (typeof value.cursors === "object" && value.cursors !== null) {
    for (const [path, offset] of Object.entries(value.cursors)) {
      if (typeof offset === "number" && Number.isFinite(offset) && offset >= 0) {
        cursors[path] = offset;
      }
    }
  }

  return {
    openPaths,
    activePath,
    cursors,
    expandedDirs: Array.isArray(value.expandedDirs)
      ? value.expandedDirs.filter((d): d is string => typeof d === "string")
      : [],
    centerShell: value.centerShell === "vibe" ? "vibe" : "editor",
    diffOpen: value.diffOpen === true,
    includeHidden: value.includeHidden === true,
  };
}

export function loadSession(projectHash: string): EditorSession {
  try {
    const raw = localStorage.getItem(sessionKey(projectHash));
    return raw ? coerce(JSON.parse(raw)) : { ...EMPTY };
  } catch {
    // Corrupt JSON is not worth failing a project switch over.
    return { ...EMPTY };
  }
}

export function saveSession(projectHash: string, session: EditorSession) {
  try {
    localStorage.setItem(sessionKey(projectHash), JSON.stringify(session));
  } catch {
    // Storage full or disabled — the app works fine without a restore.
  }
}

export function clearSession(projectHash: string) {
  localStorage.removeItem(sessionKey(projectHash));
}
