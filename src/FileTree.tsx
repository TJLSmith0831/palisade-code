import { useCallback, useEffect, useState } from "react";
import * as api from "./api";

type Props = {
  projectHash: string;
  projectName: string;
  onSelectFile: (path: string) => void;
  activePath: string | null;
};

type Entry = api.DirEntry;

export default function FileTree({ projectHash, projectName, onSelectFile, activePath }: Props) {
  const [roots, setRoots] = useState<Entry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Map<string, Entry[]>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setExpanded(new Set());
    setChildren(new Map());
    api.listDirectory(projectHash, "").then(setRoots, (err) => setError(String(err)));
  }, [projectHash]);

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

  const renderEntry = (entry: Entry, depth: number) => {
    const isOpen = expanded.has(entry.path);
    const kids = children.get(entry.path) ?? [];
    const isActive = activePath === entry.path;

    return (
      <div key={entry.path}>
        <div
          className={`ds-tree-row ${entry.is_dir ? "folder" : "file"} ${isActive ? "active" : ""}`}
          style={{ paddingLeft: 10 + depth * 12 }}
          onClick={() => toggle(entry)}
          data-testid="tree-row"
        >
          <span className="ds-chevron">
            {entry.is_dir ? (isOpen ? "▾" : "▸") : "▸"}
          </span>
          <span className="ds-tree-label">{entry.name}</span>
        </div>
        {entry.is_dir && isOpen && kids.map((child) => renderEntry(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="ds-file-tree" data-testid="file-tree">
      <div className="ds-tree-header">{projectName}</div>
      <div className="ds-tree-body">
        {error && <div className="ds-tree-error">{error}</div>}
        {roots.map((entry) => renderEntry(entry, 0))}
      </div>
    </div>
  );
}
