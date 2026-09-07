import { useEffect, useMemo, useRef, useState } from "react";
import Palette from "./Palette";
import { describeError } from "./errors";
import { scorePath } from "./fuzzyMatch";
import { RenameIcon, DeleteIcon } from "./icons";

const MAX_RESULTS = 50;

type Props = {
  files: string[];
  onSelect: (path: string) => void;
  onClose: () => void;
  onCreate: (path: string) => Promise<void>;
  onRename: (from: string, to: string) => Promise<void>;
  onDelete: (path: string) => Promise<void>;
};

type PaletteItem =
  { kind: "create"; path: string } | { kind: "file"; path: string };

export default function FilePalette({
  files,
  onSelect,
  onClose,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);

  const results = useMemo(() => {
    if (!query) return files.slice(0, MAX_RESULTS);
    const scored: { path: string; score: number }[] = [];
    for (const path of files) {
      const score = scorePath(query, path);
      if (score !== null) scored.push({ path, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((r) => r.path);
  }, [files, query]);

  const canCreate = query.trim() !== "" && !files.includes(query.trim());
  const createLabel = query.trim();

  const items: PaletteItem[] = useMemo(() => {
    const base: PaletteItem[] = results.map((path) => ({ kind: "file", path }));
    if (canCreate) {
      base.push({ kind: "create", path: createLabel });
    }
    return base;
  }, [results, canCreate, createLabel]);

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
      setError(describeError(err));
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
      setError(describeError(err));
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
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const status = error ? (
    <div className="file-palette-error" data-testid="file-palette-error">
      {error}
    </div>
  ) : null;

  const emptyState =
    results.length === 0 && !canCreate ? (
      <div
        className="file-palette-empty"
        data-testid="file-palette-empty"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 96,
          margin: "0 8px",
          color: "var(--muted)",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        No matching files
      </div>
    ) : null;

  return (
    <Palette
      title="File palette"
      items={items}
      renderItem={(item, { active, onMouseEnter }) => {
        if (item.kind === "create") {
          return (
            <li
              key={`create:${item.path}`}
              className={`file-palette-create ${active ? "active" : ""}`}
              onMouseEnter={onMouseEnter}
              onClick={() => runCreate(item.path)}
              data-testid="file-palette-create"
            >
              + Create <strong>{item.path}</strong>
            </li>
          );
        }

        const path = item.path;
        if (renaming === path) {
          return (
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
          );
        }

        if (confirmingDelete === path) {
          return (
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
          );
        }

        return (
          <li
            key={path}
            className={active ? "active" : ""}
            onMouseEnter={onMouseEnter}
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
                <RenameIcon />
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
                <DeleteIcon />
              </button>
            </div>
          </li>
        );
      }}
      onSelect={(item) => {
        if (item.kind === "create") {
          runCreate(item.path);
        } else {
          select(item.path);
        }
      }}
      onClose={onClose}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search files, or type a new path to create one…"
      inputAriaLabel="Search files"
      inputTestId="file-palette-input"
      resultsTestId="file-palette-results"
      resultsClassName="file-palette-results"
      inputDisabled={renaming !== null}
      className="file-palette"
      autoFocus
      status={status}
      emptyState={emptyState}
      footer={
        <span className="hint">
          ↑↓ to navigate · Enter to open{canCreate ? " or create" : ""} · Esc
          to cancel
        </span>
      }
    />
  );
}
