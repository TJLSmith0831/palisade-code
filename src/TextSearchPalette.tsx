import { useEffect, useMemo, useState } from "react";
import { Checkbox, Group, Modal as MantineModal } from "@mantine/core";
import { fuzzyMatch } from "./fuzzyMatch";
import type { SearchOptions, TextSearchResult, TextMatch } from "./api";

const MAX_FILE_RESULTS = 20;
/** Long enough that typing a word doesn't walk the tree once per keystroke,
 * short enough that results feel like they arrive as you type. */
const SEARCH_DEBOUNCE_MS = 150;

type ResultItem = { kind: "file"; path: string } | { kind: "text"; match: TextMatch };

type Props = {
  files: string[];
  onSearchText: (query: string, options: SearchOptions) => Promise<TextSearchResult>;
  /** `line` opens the file scrolled to that match. */
  onSelect: (path: string, line?: number) => void;
  onClose: () => void;
};

/** Combined "find in files" — file-name fuzzy match (like the ⌘P palette) plus
 * file-content search, in one list, bound to ⌘⇧F. */
export default function TextSearchPalette({ files, onSearchText, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [textMatches, setTextMatches] = useState<TextMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [options, setOptions] = useState<SearchOptions>({
    regex: false,
    caseSensitive: false,
    wholeWord: false,
  });

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

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setTextMatches([]);
      setTruncated(false);
      setSearchError(null);
      return;
    }
    let cancelled = false;
    // Debounced: this walks the whole project, and a half-typed regex is
    // both expensive and guaranteed to be invalid.
    const timer = setTimeout(() => {
      setBusy(true);
      setSearchError(null);
      onSearchText(trimmed, options)
        .then((result) => {
          if (cancelled) return;
          setTextMatches(result.matches);
          setTruncated(result.truncated);
        })
        .catch((err) => {
          if (cancelled) return;
          setTextMatches([]);
          setTruncated(false);
          // Almost always a regex the user hasn't finished typing.
          setSearchError(String(err).replace(/^Error:\s*/, ""));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, options, onSearchText]);

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
    if (item.kind === "file") onSelect(item.path);
    // The line was already in the result; it just used to be thrown away.
    else onSelect(item.match.path, item.match.line);
    onClose();
  };

  return (
    <MantineModal
      opened
      onClose={onClose}
      title="Find in files"
      classNames={{ content: "file-palette" }}
      transitionProps={{ duration: 0 }}
    >
      <input
        data-autofocus
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
      <Group gap="md" mt="xs" mb="xs">
        <Checkbox
          size="xs"
          label="Aa"
          aria-label="Match case"
          checked={options.caseSensitive}
          // Read before the updater runs: React nulls `currentTarget`
          // once the handler returns, and the updater is called later.
          onChange={(e) => {
            const checked = e.currentTarget.checked;
            setOptions((o) => ({ ...o, caseSensitive: checked }));
          }}
          data-testid="search-case-sensitive"
        />
        <Checkbox
          size="xs"
          label="Whole word"
          checked={options.wholeWord}
          // Read before the updater runs: React nulls `currentTarget`
          // once the handler returns, and the updater is called later.
          onChange={(e) => {
            const checked = e.currentTarget.checked;
            setOptions((o) => ({ ...o, wholeWord: checked }));
          }}
          data-testid="search-whole-word"
        />
        <Checkbox
          size="xs"
          label=".*"
          aria-label="Regular expression"
          checked={options.regex}
          // Read before the updater runs: React nulls `currentTarget`
          // once the handler returns, and the updater is called later.
          onChange={(e) => {
            const checked = e.currentTarget.checked;
            setOptions((o) => ({ ...o, regex: checked }));
          }}
          data-testid="search-regex"
        />
      </Group>
      {searchError && (
        <div className="file-palette-error" data-testid="text-search-error">
          {searchError}
        </div>
      )}
      {truncated && (
        <div className="file-palette-empty" data-testid="text-search-truncated">
          Showing the first {textMatches.length} matches — narrow the search to see the rest.
        </div>
      )}
      {busy && (
        <div className="file-palette-error" data-testid="text-search-busy">
          Searching…
        </div>
      )}
      {query.trim() !== "" && !busy && !searchError && results.length === 0 && (
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
    </MantineModal>
  );
}
