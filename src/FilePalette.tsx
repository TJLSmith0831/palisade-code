import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "./fuzzyMatch";

const MAX_RESULTS = 50;

type Props = {
  files: string[];
  onSelect: (path: string) => void;
  onClose: () => void;
  onCreate: (path: string) => Promise<void>;
  onRename: (from: string, to: string) => Promise<void>;
  onDelete: (path: string) => Promise<void>;
};

export default function FilePalette({ files, onSelect, onClose, onCreate, onRename, onDelete }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);

  const results = useMemo(() => {
    if (!query) return files.slice(0, MAX_RESULTS);
    const scored: { path: string; score: number }[] = [];
    for (const path of files) {
      const score = fuzzyMatch(query, path);
      if (score !== null) scored.push({ path, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((r) => r.path);
  }, [files, query]);

  // A pinned "create" row when the query names a file that doesn't exist yet.
  const canCreate = query.trim() !== "" && !files.includes(query.trim());
  const createLabel = query.trim();

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const select = (path: string) => {
    onSelect(path);
    onClose();
  };

  const runCreate = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      await onCreate(path);
      select(path);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const runRename = async (from: string, to: string) => {
    if (to.trim() === "" || to.trim() === from) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRename(from, to.trim());
      setRenaming(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async (path: string) => {
    setBusy(true);
    setError(null);
    try {
      await onDelete(path);
      setConfirmingDelete(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="commandbar file-palette" onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files, or type a new path to create one…"
          autoComplete="off"
          disabled={renaming !== null}
          data-testid="file-palette-input"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((i) => Math.min(i + 1, results.length - 1 + (canCreate ? 1 : 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              if (canCreate && activeIndex === results.length) {
                runCreate(createLabel);
                return;
              }
              const target = results[activeIndex];
              if (target) select(target);
            }
          }}
        />
        {error && (
          <div className="file-palette-error" data-testid="file-palette-error">
            {error}
          </div>
        )}
        <ul className="file-palette-results" data-testid="file-palette-results">
          {results.length === 0 && !canCreate && <li className="file-palette-empty">No matching files</li>}
          {canCreate && (
            <li
              className={`file-palette-create ${activeIndex === results.length ? "active" : ""}`}
              onMouseEnter={() => setActiveIndex(results.length)}
              onClick={() => runCreate(createLabel)}
              data-testid="file-palette-create"
            >
              + Create <strong>{createLabel}</strong>
            </li>
          )}
          {results.map((path, i) =>
            renaming === path ? (
              <li key={path} className="file-palette-renaming">
                <input
                  ref={renameInputRef}
                  defaultValue={path}
                  disabled={busy}
                  data-testid="file-palette-rename-input"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      runRename(path, event.currentTarget.value);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setRenaming(null);
                    }
                  }}
                />
              </li>
            ) : confirmingDelete === path ? (
              <li key={path} className="file-palette-confirm-delete">
                <span>Delete {path}?</span>
                <div className="spacer" />
                <button
                  className="danger"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    runDelete(path);
                  }}
                  data-testid="file-palette-confirm-delete-yes"
                >
                  Delete
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setConfirmingDelete(null);
                  }}
                  data-testid="file-palette-confirm-delete-no"
                >
                  Cancel
                </button>
              </li>
            ) : (
              <li
                key={path}
                className={i === activeIndex ? "active" : ""}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => select(path)}
                data-testid="file-palette-result"
              >
                <span className="file-palette-path">{path}</span>
                <div className="file-palette-row-actions">
                  <button
                    className="file-palette-row-action"
                    title="Rename or move"
                    onClick={(event) => {
                      event.stopPropagation();
                      setRenaming(path);
                    }}
                    data-testid="file-palette-rename"
                  >
                    ✎
                  </button>
                  <button
                    className="file-palette-row-action delete"
                    title="Delete"
                    onClick={(event) => {
                      event.stopPropagation();
                      setConfirmingDelete(path);
                    }}
                    data-testid="file-palette-delete"
                  >
                    ×
                  </button>
                </div>
              </li>
            ),
          )}
        </ul>
        <span className="hint">
          ↑↓ to navigate · Enter to open{canCreate ? " or create" : ""} · ✎ to rename/move · Esc to cancel
        </span>
      </div>
    </div>
  );
}
