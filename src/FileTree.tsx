import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "./api";

type Props = {
  projectHash: string;
  projectName: string;
  onSelectFile: (path: string) => void;
  activePath: string | null;
  /** Bump to force a full re-fetch after an out-of-band change (the file
   * palette's create/rename/delete) — collapses expanded dirs, same as a
   * project switch. Operations the tree performs on itself refresh just the
   * affected directory instead, without touching this. */
  refreshToken?: number;
  /** The tree's own create/rename/delete/move — so the caller can keep the
   * open editor tab and the file-palette cache in sync. */
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
  onFilesChanged?: () => void;
};

type Entry = api.DirEntry;

type ContextMenuState = {
  x: number;
  y: number;
  /** `null` targets the project root (background right-click). */
  target: { path: string; isDir: boolean } | null;
};

const dirOf = (path: string) => {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
};

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export default function FileTree({
  projectHash,
  projectName,
  onSelectFile,
  activePath,
  refreshToken,
  onPathRenamed,
  onPathDeleted,
  onFilesChanged,
}: Props) {
  const [roots, setRoots] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, Entry[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parentPath: string; kind: "file" | "folder" } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null); // "" = root/background
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setError(null);
    setExpanded(new Set());
    setChildren(new Map());
    api.listDirectory(projectHash, "").then(setRoots, (err) => setError(String(err)));
  }, [projectHash, refreshToken]);

  useEffect(() => {
    editInputRef.current?.focus();
    editInputRef.current?.select();
  }, [renaming, creating]);

  // A single directory's contents changed (create/rename/delete/move) —
  // re-fetch just that one instead of collapsing the whole tree.
  const refreshDir = useCallback(
    async (dirPath: string) => {
      try {
        const entries = await api.listDirectory(projectHash, dirPath);
        if (dirPath === "") setRoots(entries);
        else setChildren((prev) => new Map(prev).set(dirPath, entries));
      } catch (err) {
        setError(String(err));
      }
    },
    [projectHash],
  );

  const toggle = useCallback(
    async (entry: Entry) => {
      if (!entry.is_dir) {
        onSelectFile(entry.path);
        return;
      }
      const path = entry.path;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
      if (!children.has(path)) {
        try {
          const entries = await api.listDirectory(projectHash, path);
          setChildren((prev) => new Map(prev).set(path, entries));
        } catch (err) {
          setError(String(err));
        }
      }
    },
    [projectHash, children, onSelectFile],
  );

  const runRename = async (path: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === path.split("/").pop()) {
      setRenaming(null);
      return;
    }
    const to = joinPath(dirOf(path), trimmed);
    try {
      await api.renamePath(projectHash, path, to);
      setRenaming(null);
      await refreshDir(dirOf(path));
      onPathRenamed?.(path, to);
      onFilesChanged?.();
    } catch (err) {
      setError(String(err));
    }
  };

  const runDelete = async (path: string) => {
    try {
      await api.deletePath(projectHash, path);
      setConfirmingDelete(null);
      await refreshDir(dirOf(path));
      onPathDeleted?.(path);
      onFilesChanged?.();
    } catch (err) {
      setError(String(err));
    }
  };

  const runCreate = async (parentPath: string, kind: "file" | "folder", name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setCreating(null);
      return;
    }
    const path = joinPath(parentPath, trimmed);
    try {
      if (kind === "file") {
        await api.writeFileContent(projectHash, path, "");
      } else {
        await api.createDirectory(projectHash, path);
        setExpanded((prev) => new Set(prev).add(path));
      }
      setCreating(null);
      await refreshDir(parentPath);
      onFilesChanged?.();
      if (kind === "file") onSelectFile(path);
    } catch (err) {
      setError(String(err));
    }
  };

  const runMove = async (source: string, targetDir: string) => {
    const name = source.split("/").pop()!;
    const to = joinPath(targetDir, name);
    if (to === source) return; // dropped back onto its own parent
    if (targetDir === source || targetDir.startsWith(`${source}/`)) {
      setError("Can't move a folder into itself");
      return;
    }
    try {
      await api.renamePath(projectHash, source, to);
      await Promise.all([refreshDir(dirOf(source)), refreshDir(targetDir)]);
      onPathRenamed?.(source, to);
      onFilesChanged?.();
    } catch (err) {
      setError(String(err));
    }
  };

  const openCreate = (parentPath: string, kind: "file" | "folder") => {
    setMenu(null);
    if (parentPath && !expanded.has(parentPath)) {
      setExpanded((prev) => new Set(prev).add(parentPath));
    }
    if (parentPath && !children.has(parentPath)) {
      api.listDirectory(projectHash, parentPath).then(
        (entries) => setChildren((prev) => new Map(prev).set(parentPath, entries)),
        (err) => setError(String(err)),
      );
    }
    setCreating({ parentPath, kind });
  };

  const renderCreateInput = (depth: number) => (
    <div className="ds-tree-row editing" style={{ paddingLeft: 10 + depth * 12 }}>
      <input
        ref={editInputRef}
        defaultValue=""
        data-testid="tree-create-input"
        placeholder={creating?.kind === "folder" ? "Folder name" : "File name"}
        onKeyDown={(event) => {
          if (event.key === "Enter" && creating) {
            runCreate(creating.parentPath, creating.kind, event.currentTarget.value);
          } else if (event.key === "Escape") {
            setCreating(null);
          }
        }}
        onBlur={() => setCreating(null)}
      />
    </div>
  );

  const renderEntry = (entry: Entry, depth: number): ReactNode => {
    const isOpen = expanded.has(entry.path);
    const kids = children.get(entry.path) ?? [];
    const isActive = activePath === entry.path;
    const isDropTarget = entry.is_dir && dragOver === entry.path;

    if (confirmingDelete === entry.path) {
      return (
        <div
          key={entry.path}
          className="ds-tree-row confirm-delete"
          style={{ paddingLeft: 10 + depth * 12 }}
          data-testid="tree-confirm-delete"
        >
          <span>Delete {entry.name}?</span>
          <div className="spacer" />
          <button className="danger" onClick={() => runDelete(entry.path)} data-testid="tree-confirm-delete-yes">
            Delete
          </button>
          <button onClick={() => setConfirmingDelete(null)} data-testid="tree-confirm-delete-no">
            Cancel
          </button>
        </div>
      );
    }

    if (renaming === entry.path) {
      return (
        <div key={entry.path} className="ds-tree-row editing" style={{ paddingLeft: 10 + depth * 12 }}>
          <input
            ref={editInputRef}
            defaultValue={entry.name}
            data-testid="tree-rename-input"
            onKeyDown={(event) => {
              if (event.key === "Enter") runRename(entry.path, event.currentTarget.value);
              else if (event.key === "Escape") setRenaming(null);
            }}
            onBlur={() => setRenaming(null)}
          />
        </div>
      );
    }

    return (
      <div key={entry.path}>
        <div
          className={`ds-tree-row ${entry.is_dir ? "folder" : "file"} ${isActive ? "active" : ""} ${isDropTarget ? "drop-target" : ""}`}
          style={{ paddingLeft: 10 + depth * 12 }}
          onClick={() => toggle(entry)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setMenu({ x: event.clientX, y: event.clientY, target: { path: entry.path, isDir: entry.is_dir } });
          }}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData("text/plain", entry.path);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => {
            if (!entry.is_dir) return;
            event.preventDefault();
            setDragOver(entry.path);
          }}
          onDragLeave={() => setDragOver((prev) => (prev === entry.path ? null : prev))}
          onDrop={(event) => {
            if (!entry.is_dir) return;
            event.preventDefault();
            event.stopPropagation();
            setDragOver(null);
            const source = event.dataTransfer.getData("text/plain");
            if (source) runMove(source, entry.path);
          }}
          data-testid="tree-row"
        >
          <span className="ds-chevron">{entry.is_dir ? (isOpen ? "▾" : "▸") : "▸"}</span>
          <span className="ds-tree-label">{entry.name}</span>
        </div>
        {entry.is_dir && isOpen && kids.map((child) => renderEntry(child, depth + 1))}
        {entry.is_dir && isOpen && creating?.parentPath === entry.path && renderCreateInput(depth + 1)}
      </div>
    );
  };

  const menuItemsFor = (target: ContextMenuState["target"]) => {
    const parentPath = target ? (target.isDir ? target.path : dirOf(target.path)) : "";
    const items: { label: string; onSelect: () => void; danger?: boolean }[] = [
      { label: "New File", onSelect: () => openCreate(parentPath, "file") },
      { label: "New Folder", onSelect: () => openCreate(parentPath, "folder") },
    ];
    if (target) {
      items.push({
        label: "Rename",
        onSelect: () => {
          setMenu(null);
          setRenaming(target.path);
        },
      });
      items.push({
        label: "Delete",
        danger: true,
        onSelect: () => {
          setMenu(null);
          setConfirmingDelete(target.path);
        },
      });
    }
    return items;
  };

  return (
    <div className="ds-file-tree" data-testid="file-tree">
      <div className="ds-tree-header">{projectName}</div>
      <div
        className={`ds-tree-body ${dragOver === "" ? "drop-target" : ""}`}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, target: null });
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver("");
        }}
        onDragLeave={(event) => {
          if (event.target === event.currentTarget) setDragOver((prev) => (prev === "" ? null : prev));
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(null);
          const source = event.dataTransfer.getData("text/plain");
          if (source) runMove(source, "");
        }}
      >
        {error && <div className="ds-tree-error">{error}</div>}
        {creating?.parentPath === "" && renderCreateInput(0)}
        {roots.map((entry) => renderEntry(entry, 0))}
      </div>

      {menu && (
        <div className="context-menu-catcher" onClick={() => setMenu(null)} onContextMenu={(e) => e.preventDefault()}>
          <ul
            className="context-menu"
            style={{ top: menu.y, left: menu.x }}
            onClick={(event) => event.stopPropagation()}
            data-testid="tree-context-menu"
          >
            {menuItemsFor(menu.target).map((item) => (
              <li
                key={item.label}
                className={item.danger ? "danger" : ""}
                onClick={item.onSelect}
                data-testid="tree-context-menu-item"
              >
                {item.label}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
