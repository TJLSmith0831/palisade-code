import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tree, useTree, type RenderTreeNodePayload, type TreeNodeData } from "@mantine/core";
import * as api from "./api";
import { describeError } from "./errors";
import { NewFileIcon, NewFolderIcon } from "./icons";

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

/** Sentinel value for the inline "new file/folder" row. It is not a real
 * entry, but riding in the node list gets it rendered at the right depth by
 * the tree itself. Relative paths are `/`-joined and never start with a
 * colon, so this can't collide with one. */
const CREATE_NODE = ":new:";

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
  const [children, setChildren] = useState<Map<string, Entry[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parentPath: string; kind: "file" | "folder" } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null); // "" = root/background
  const [includeHidden, setIncludeHidden] = useState(false);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Expansion lives in the tree controller; selection stays controlled off the
  // `activePath` prop, so nothing here ever writes it.
  const selectedState = useMemo(() => (activePath ? [activePath] : []), [activePath]);
  const tree = useTree({ selectedState });
  const { expand, toggleExpanded } = tree;
  // Reached through a ref, never a dependency: useTree's methods are
  // useCallback'd on the expanded state, so depending on one re-runs the fetch
  // effect on every expand/collapse — which sets roots, re-renders, and loops.
  const treeRef = useRef(tree);
  treeRef.current = tree;

  useEffect(() => {
    setError(null);
    setChildren(new Map());
    treeRef.current.collapseAllNodes();
    api.listDirectory(projectHash, "", includeHidden).then(setRoots, (err) => setError(describeError(err)));
  }, [projectHash, refreshToken, includeHidden]);

  useEffect(() => {
    editInputRef.current?.focus();
    editInputRef.current?.select();
  }, [renaming, creating]);

  // A single directory's contents changed (create/rename/delete/move) —
  // re-fetch just that one instead of collapsing the whole tree.
  const refreshDir = useCallback(
    async (dirPath: string) => {
      try {
        const entries = await api.listDirectory(projectHash, dirPath, includeHidden);
        if (dirPath === "") setRoots(entries);
        else setChildren((prev) => new Map(prev).set(dirPath, entries));
      } catch (err) {
        setError(describeError(err));
      }
    },
    [projectHash, includeHidden],
  );

  const toggle = useCallback(
    async (entry: Entry) => {
      if (!entry.is_dir) {
        onSelectFile(entry.path);
        return;
      }
      const path = entry.path;
      toggleExpanded(path);
      if (!children.has(path)) {
        try {
          const entries = await api.listDirectory(projectHash, path, includeHidden);
          setChildren((prev) => new Map(prev).set(path, entries));
        } catch (err) {
          setError(describeError(err));
        }
      }
    },
    [projectHash, children, onSelectFile, includeHidden, toggleExpanded],
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
      setError(describeError(err));
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
      setError(describeError(err));
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
        expand(path);
      }
      setCreating(null);
      await refreshDir(parentPath);
      onFilesChanged?.();
      if (kind === "file") onSelectFile(path);
    } catch (err) {
      setError(describeError(err));
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
      setError(describeError(err));
    }
  };

  const openCreate = (parentPath: string, kind: "file" | "folder") => {
    setMenu(null);
    if (parentPath) expand(parentPath);
    if (parentPath && !children.has(parentPath)) {
      api.listDirectory(projectHash, parentPath, includeHidden).then(
        (entries) => setChildren((prev) => new Map(prev).set(parentPath, entries)),
        (err) => setError(describeError(err)),
      );
    }
    setCreating({ parentPath, kind });
  };

  // `Tree` re-runs `controller.initialize(data)` whenever this array's identity
  // changes, so it must stay memoized or every render loops.
  const nodes = useMemo(() => {
    const build = (entries: Entry[]): TreeNodeData[] =>
      entries.map((entry) => {
        if (!entry.is_dir) {
          return { value: entry.path, label: entry.name, nodeProps: { entry } };
        }
        const kids = build(children.get(entry.path) ?? []);
        if (creating?.parentPath === entry.path) {
          kids.push({ value: CREATE_NODE, label: "" });
        }
        return { value: entry.path, label: entry.name, nodeProps: { entry }, children: kids };
      });

    const top = build(roots);
    if (creating?.parentPath === "") top.unshift({ value: CREATE_NODE, label: "" });
    return top;
  }, [roots, children, creating]);

  const entriesByPath = useMemo(() => {
    const map = new Map<string, Entry>();
    const walk = (entries: Entry[]) => {
      for (const entry of entries) {
        map.set(entry.path, entry);
        if (entry.is_dir) walk(children.get(entry.path) ?? []);
      }
    };
    walk(roots);
    return map;
  }, [roots, children]);

  const createInput = () => (
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
  );

  const renderNode = (payload: RenderTreeNodePayload) => {
    const { node, expanded, elementProps } = payload;
    // Drop Mantine's own label styling/handlers — this row keeps the app's
    // `.ds-tree-row` treatment and its native drag-and-drop.
    const { className: _c, style: _s, onClick: _o, ...rest } = elementProps;

    if (node.value === CREATE_NODE) {
      return (
        <div {...rest} className="ds-tree-row editing">
          {createInput()}
        </div>
      );
    }

    const entry = node.nodeProps?.entry as Entry;

    if (confirmingDelete === entry.path) {
      return (
        <div {...rest} className="ds-tree-row confirm-delete" data-testid="tree-confirm-delete">
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
        <div {...rest} className="ds-tree-row editing">
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

    const isActive = activePath === entry.path;
    const isDropTarget = entry.is_dir && dragOver === entry.path;

    return (
      <div
        {...rest}
        className={`ds-tree-row ${entry.is_dir ? "folder" : "file"} ${isActive ? "active" : ""} ${isDropTarget ? "drop-target" : ""}`}
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
        <span className="ds-chevron">{entry.is_dir ? (expanded ? "▾" : "▸") : "▸"}</span>
        <span className="ds-tree-label">{entry.name}</span>
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
    } else {
      items.push({
        label: includeHidden ? "Hide Gitignored/Hidden Files" : "Show Gitignored/Hidden Files",
        onSelect: () => {
          setMenu(null);
          setIncludeHidden((prev) => !prev);
        },
      });
    }
    return items;
  };

  return (
    <div className="ds-file-tree" data-testid="file-tree">
      <div className="ds-tree-header">
        <span className="ds-tree-header-label">{projectName}</span>
        <div className="ds-tree-header-actions">
          <button
            className="ds-tree-header-action"
            title="New File"
            aria-label="New File"
            onClick={() => openCreate("", "file")}
            data-testid="tree-new-file"
          >
            <NewFileIcon />
          </button>
          <button
            className="ds-tree-header-action"
            title="New Folder"
            aria-label="New Folder"
            onClick={() => openCreate("", "folder")}
            data-testid="tree-new-folder"
          >
            <NewFolderIcon />
          </button>
        </div>
      </div>
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
        <Tree
          tree={tree}
          data={nodes}
          levelOffset={12}
          expandOnClick={false}
          expandOnSpace={false}
          renderNode={renderNode}
          // Mantine handles the arrow keys; Enter is unhandled and Space is
          // switched off above (it would otherwise swallow spaces typed into
          // the rename/create inputs). Reading `event.key` here rather than
          // `nativeEvent.code` keeps plain `keyDown` events working.
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            if ((event.target as HTMLElement).tagName === "INPUT") return;
            const row = (event.target as HTMLElement).closest<HTMLElement>("[data-value]");
            const entry = row && entriesByPath.get(row.dataset.value!);
            if (!entry) return;
            event.preventDefault();
            toggle(entry);
          }}
        />
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
