import { useEffect, useMemo, useState } from "react";
import {
  IconBrandPython,
  IconCheck,
  IconFileText,
  IconPhoto,
} from "@tabler/icons-react";
import Palette from "./Palette";
import { fuzzyMatch } from "./fuzzyMatch";
import type { SearchOptions, TextMatch } from "./api";
import { describeError } from "./errors";

const MAX_FILE_RESULTS = 20;

/**
 * Long enough that typing a word doesn't walk the tree once per keystroke,
 * short enough that results feel like they arrive as you type.
 */
const SEARCH_DEBOUNCE_MS = 150;

type ResultItem =
  { kind: "file"; path: string } | { kind: "text"; match: TextMatch };

type Props = {
  files: string[];
  onSearchText: (
    query: string,
    options: SearchOptions
  ) => Promise<{
    matches: TextMatch[];
    truncated: boolean;
  }>;
  /** `line` opens the file scrolled to that match. */
  onSelect: (path: string, line?: number) => void;
  onClose: () => void;
};

/**
 * Combined "find in files" — file-name fuzzy match plus file-content search,
 * in one palette, bound to ⌘⇧F.
 */
export default function TextSearchPalette({
  files,
  onSearchText,
  onSelect,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [textMatches, setTextMatches] = useState<TextMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    return scored.slice(0, MAX_FILE_RESULTS).map((result) => result.path);
  }, [files, query]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setTextMatches([]);
      setTruncated(false);
      setSearchError(null);
      setBusy(false);
      return;
    }

    let cancelled = false;
    setBusy(true);
    setSearchError(null);

    const timer = setTimeout(() => {
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
          setSearchError(describeError(err, { action: "run that search" }));
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

  const items: ResultItem[] = useMemo(
    () => [
      ...fileResults.map((path): ResultItem => ({ kind: "file", path })),
      ...textMatches.map((match): ResultItem => ({ kind: "text", match })),
    ],
    [fileResults, textMatches]
  );

  const select = (item: ResultItem) => {
    if (item.kind === "file") {
      onSelect(item.path);
    } else {
      onSelect(item.match.path, item.match.line);
    }
    onClose();
  };

  const toggleOption = (key: keyof SearchOptions) => {
    setOptions((current) => ({ ...current, [key]: !current[key] }));
  };

  const fileIcon = (path: string) => {
    const extension = path.split(".").pop()?.toLowerCase();

    if (extension === "py") {
      return <IconBrandPython size={18} stroke={1.6} aria-hidden="true" />;
    }

    if (
      ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension ?? "")
    ) {
      return <IconPhoto size={18} stroke={1.6} aria-hidden="true" />;
    }

    return <IconFileText size={18} stroke={1.6} aria-hidden="true" />;
  };

  const OptionToggle = ({
    label,
    checked,
    testId,
    ariaLabel,
    onChange,
  }: {
    label: string;
    checked: boolean;
    testId: string;
    ariaLabel?: string;
    onChange: () => void;
  }) => (
    <button
      type="button"
      onClick={onChange}
      aria-label={ariaLabel}
      aria-pressed={checked}
      data-testid={testId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        height: 30,
        padding: "0 8px",
        color: checked ? "var(--fg)" : "var(--muted)",
        background: checked ? "var(--surface-warm)" : "transparent",
        border: `1px solid ${checked ? "var(--border)" : "transparent"}`,
        borderRadius: 4,
        cursor: "pointer",
        fontFamily: "inherit",
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 16,
          height: 16,
          color: checked ? "var(--fg)" : "var(--muted)",
          background: checked ? "var(--surface-warm)" : "var(--surface)",
          border: `1px solid ${checked ? "var(--border)" : "var(--border)"}`,
          borderRadius: 4,
          lineHeight: 1,
        }}
      >
        {checked && <IconCheck size={10} stroke={2.5} />}
      </span>
      <span>{label}</span>
    </button>
  );

  const status = (
    <>
      {(busy || searchError || truncated) && (
        <div
          style={{
            margin: "0 20px 10px",
            color: searchError ? "var(--danger)" : "var(--muted)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {busy && "Searching…"}
          {!busy && searchError && (
            <span data-testid="text-search-error">{searchError}</span>
          )}
          {!busy && !searchError && truncated && (
            <span data-testid="text-search-truncated">
              Showing the first {textMatches.length} matches — narrow the search
              to see the rest.
            </span>
          )}
        </div>
      )}
    </>
  );

  const emptyState =
    query.trim() !== "" && !busy && !searchError && items.length === 0 ? (
      <div
        data-testid="text-search-empty"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 92,
          margin: "0 8px",
          color: "var(--muted)",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        No matches
      </div>
    ) : null;

  return (
    <Palette
      title="Find in files"
      items={items}
      renderItem={(item, { active, onSelect, onMouseEnter }) => {
        if (item.kind === "file") {
          return (
            <li
              key={item.path}
              className={active ? "active" : ""}
              onMouseEnter={onMouseEnter}
              onClick={onSelect}
              data-testid="text-search-file-result"
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                minHeight: 32,
                padding: "0 10px",
                color: active ? "var(--fg)" : "var(--muted)",
                background: active ? "var(--surface-warm)" : "transparent",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 13,
                boxSizing: "border-box",
              }}
            >
              {active && (
                <span
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 5,
                    bottom: 5,
                    width: 2,
                    background: "var(--accent)",
                    borderRadius: 2,
                  }}
                />
              )}
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 28,
                  marginRight: 4,
                  color: active ? "var(--fg)" : "var(--muted)",
                }}
              >
                {fileIcon(item.path)}
              </span>
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.path}
              </span>
            </li>
          );
        }

        const match = item.match;
        return (
          <li
            key={`${match.path}:${match.line}`}
            className={active ? "active" : ""}
            onMouseEnter={onMouseEnter}
            onClick={onSelect}
            data-testid="text-search-text-result"
            style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              gap: 3,
              minHeight: 44,
              padding: "7px 10px 7px 12px",
              color: active ? "var(--fg)" : "var(--muted)",
              background: active ? "var(--surface-warm)" : "transparent",
              borderRadius: 4,
              cursor: "pointer",
              boxSizing: "border-box",
            }}
          >
            {active && (
              <span
                style={{
                  position: "absolute",
                  left: 0,
                  top: 5,
                  bottom: 5,
                  width: 2,
                  background: "var(--accent)",
                  borderRadius: 2,
                }}
              />
            )}
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: active ? "var(--fg)" : "var(--muted)",
                fontFamily:
                  "var(--mono)",
                fontSize: 11,
                fontWeight: 500,
              }}
            >
              {match.path}:{match.line}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: active ? "var(--fg)" : "var(--muted)",
                fontFamily:
                  "var(--mono)",
                fontSize: 11,
              }}
            >
              {match.text}
            </span>
          </li>
        );
      }}
      onSelect={select}
      onClose={onClose}
      query={query}
      onQueryChange={setQuery}
      placeholder="Search files and file contents"
      inputTestId="text-search-input"
      resultsTestId="text-search-results"
      header={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            margin: "0 16px 8px",
          }}
        >
          <OptionToggle
            label="Aa"
            checked={options.caseSensitive}
            ariaLabel="Match case"
            testId="search-case-sensitive"
            onChange={() => toggleOption("caseSensitive")}
          />
          <OptionToggle
            label="Whole word"
            checked={options.wholeWord}
            testId="search-whole-word"
            onChange={() => toggleOption("wholeWord")}
          />
          <OptionToggle
            label=".*"
            checked={options.regex}
            ariaLabel="Regular expression"
            testId="search-regex"
            onChange={() => toggleOption("regex")}
          />
        </div>
      }
      status={status}
      emptyState={emptyState}
      footer={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            minHeight: 48,
            padding: "9px 16px",
            color: "var(--muted)",
            fontSize: 11,
            boxSizing: "border-box",
          }}
        >
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <kbd
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 19,
                height: 19,
                padding: "0 4px",
                color: "var(--muted)",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 4,
                fontFamily: "inherit",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              ↑
            </kbd>
            <kbd
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 19,
                height: 19,
                padding: "0 4px",
                color: "var(--muted)",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 4,
                fontFamily: "inherit",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              ↓
            </kbd>
            <span>navigate</span>
          </span>
          <span style={{ margin: "0 9px", color: "var(--muted)" }}>·</span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <kbd
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 19,
                height: 19,
                padding: "0 5px",
                color: "var(--muted)",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 4,
                fontFamily: "inherit",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              ↵
            </kbd>
            <span>open</span>
          </span>
          <span style={{ margin: "0 9px", color: "var(--muted)" }}>·</span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <kbd
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 19,
                height: 19,
                padding: "0 5px",
                color: "var(--muted)",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 4,
                fontFamily: "inherit",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              Esc
            </kbd>
            <span>cancel</span>
          </span>
        </div>
      }
    />
  );
}
