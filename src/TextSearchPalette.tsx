import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "./fuzzyMatch";
import type { TextMatch } from "./api";
import Modal from "./Modal";

const MAX_FILE_RESULTS = 20;

type ResultItem = { kind: "file"; path: string } | { kind: "text"; match: TextMatch };

type Props = {
  files: string[];
  onSearchText: (query: string) => Promise<TextMatch[]>;
  onSelect: (path: string) => void;
  onClose: () => void;
};

/** Combined "find in files" — file-name fuzzy match (like the ⌘P palette) plus
 * file-content search, in one list, bound to ⌘⇧F. */
export default function TextSearchPalette({ files, onSearchText, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [textMatches, setTextMatches] = useState<TextMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const fileResults = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const scored: { path: string; score: number }[] = [];
    for (const path of files) {
      const score = fuzzyMatch(trimmed, path);
      if (score !== null) scored.push({ path, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_FILE_RESULTS).map((r) => r.path);
  }, [files, query]);

  // Debounced only by React's own event batching — the backend already caps
  // results, and project trees here are small enough that this stays snappy.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setTextMatches([]);
      return;
    }
    let cancelled = false;
    setBusy(true);
    onSearchText(trimmed)
      .then((matches) => {
        if (!cancelled) setTextMatches(matches);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, onSearchText]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const results: ResultItem[] = useMemo(
    () => [
      ...fileResults.map((path): ResultItem => ({ kind: "file", path })),
      ...textMatches.map((match): ResultItem => ({ kind: "text", match })),
    ],
    [fileResults, textMatches],
  );

  const select = (item: ResultItem) => {
    onSelect(item.kind === "file" ? item.path : item.match.path);
    onClose();
  };

  return (
    <Modal onClose={onClose} label="Find in files">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search files and file contents…"
        autoComplete="off"
        data-testid="text-search-input"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, results.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const target = results[activeIndex];
            if (target) select(target);
          }
        }}
      />
      {busy && (
        <div className="file-palette-error" data-testid="text-search-busy">
          Searching…
        </div>
      )}
      {query.trim() !== "" && !busy && results.length === 0 && (
        <div className="file-palette-empty" data-testid="text-search-empty">
          No matches
        </div>
      )}
      {fileResults.length > 0 && (
        <ul className="file-palette-results" data-testid="text-search-file-results">
          {fileResults.map((path, i) => (
            <li
              key={path}
              className={i === activeIndex ? "active" : ""}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => select({ kind: "file", path })}
              data-testid="text-search-file-result"
            >
              <span className="file-palette-path">{path}</span>
            </li>
          ))}
        </ul>
      )}
      {textMatches.length > 0 && (
        <ul className="file-palette-results" data-testid="text-search-text-results">
          {textMatches.map((match, i) => {
            const index = fileResults.length + i;
            return (
              <li
                key={`${match.path}:${match.line}:${i}`}
                className={index === activeIndex ? "active" : ""}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select({ kind: "text", match })}
                data-testid="text-search-text-result"
              >
                <span className="file-palette-path">
                  {match.path}:{match.line}
                </span>
                <span className="ds-text-search-snippet">{match.text}</span>
              </li>
            );
          })}
        </ul>
      )}
      <span className="hint">↑↓ to navigate · Enter to open · Esc to cancel</span>
    </Modal>
  );
}
