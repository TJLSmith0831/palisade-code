import { useEffect, useMemo, useState } from "react";
import { Modal as MantineModal } from "@mantine/core";
import { fuzzyMatch } from "./fuzzyMatch";
import type { SearchOptions, TextMatch } from "./api";

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
  const [activeIndex, setActiveIndex] = useState(0);
  const [focused, setFocused] = useState(false);

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

      if (score !== null) {
        scored.push({ path, score });
      }
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
      ...fileResults.map((path): ResultItem => ({
        kind: "file",
        path,
      })),
      ...textMatches.map((match): ResultItem => ({
        kind: "text",
        match,
      })),
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
    setOptions((current) => ({
      ...current,
      [key]: !current[key],
    }));
  };

  const fileIcon = (path: string) => {
    const extension = path.split(".").pop()?.toLowerCase();

    if (extension === "py") {
      return (
        <svg
          viewBox="0 0 24 24"
          style={{
            width: 18,
            height: 18,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.6,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          }}
          aria-hidden="true"
        >
          <path d="M12 3c-3.2 0-3.5 1.8-3.5 3.5V9h7v1.5H8.5C5.5 10.5 4 12 4 15s1.5 4 4.5 4H10v-3h-2c-.8 0-1.5-.7-1.5-1.5S7.2 13 8 13h7.5c3 0 4.5-1.5 4.5-4.5V7c0-2.5-1.5-4-4-4h-4z" />
          <circle cx="10.5" cy="6" r=".7" fill="currentColor" />
        </svg>
      );
    }

    if (
      ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(extension ?? "")
    ) {
      return (
        <svg
          viewBox="0 0 24 24"
          style={{
            width: 18,
            height: 18,
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.6,
            strokeLinecap: "round",
            strokeLinejoin: "round",
          }}
          aria-hidden="true"
        >
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <circle cx="9" cy="9" r="1.5" />
          <path d="m5 17 4-4 3 3 2-2 5 5" />
        </svg>
      );
    }

    return (
      <svg
        viewBox="0 0 24 24"
        style={{
          width: 18,
          height: 18,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
        aria-hidden="true"
      >
        <path d="M6 3.5h8l4 4V20.5H6z" />
        <path d="M14 3.5v4h4" />
        <path d="M9 12h6M9 15.5h6" />
      </svg>
    );
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
        borderRadius: 5,
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
          borderRadius: 3,
          fontSize: 10,
          lineHeight: 1,
        }}
      >
        {checked ? "✓" : ""}
      </span>

      <span>{label}</span>
    </button>
  );

  return (
    <MantineModal
      opened
      onClose={onClose}
      title="Find in files"
      centered
      size={680}
      padding={0}
      radius="md"
      transitionProps={{
        duration: 120,
        transition: "fade",
      }}
      styles={{
        overlay: {
          backgroundColor: "rgba(0, 0, 0, 0.68)",
          backdropFilter: "blur(5px)",
        },
        content: {
          background: "var(--bg)",
          border: "1px solid var(--border)",
          boxShadow: "0 24px 80px rgba(0,0,0,.55), 0 8px 24px rgba(0,0,0,.35)",
          overflow: "hidden",
        },
        header: {
          minHeight: 58,
          padding: "16px 18px 10px 20px",
          background: "var(--bg)",
          borderBottom: 0,
        },
        title: {
          color: "var(--fg)",
          fontSize: 15,
          fontWeight: 600,
          letterSpacing: "-0.01em",
        },
        close: {
          width: 30,
          height: 30,
          color: "var(--muted)",
          borderRadius: 6,
        },
        body: {
          padding: 0,
          background: "var(--bg)",
        },
      }}
    >
      {/* Search */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          margin: "4px 16px 8px",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          style={{
            position: "absolute",
            left: 14,
            width: 18,
            height: 18,
            fill: "none",
            stroke: focused ? "var(--accent)" : "var(--muted)",
            strokeWidth: 1.8,
            pointerEvents: "none",
          }}
        >
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>

        <input
          data-autofocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Search files and file contents"
          autoComplete="off"
          spellCheck={false}
          data-testid="text-search-input"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();

              if (results.length > 0) {
                setActiveIndex((i) => Math.min(i + 1, results.length - 1));
              }
            } else if (event.key === "ArrowUp") {
              event.preventDefault();

              if (results.length > 0) {
                setActiveIndex((i) => Math.max(i - 1, 0));
              }
            } else if (event.key === "Enter") {
              event.preventDefault();

              const target = results[activeIndex];

              if (target) {
                select(target);
              }
            }
          }}
          style={{
            width: "100%",
            height: 48,
            padding: "0 16px 0 42px",
            color: "var(--fg)",
            background: "var(--surface)",
            border: `1px solid ${focused ? "var(--accent)" : "var(--border)"}`,
            borderRadius: 7,
            outline: "none",
            boxSizing: "border-box",
            fontFamily: "inherit",
            fontSize: 15,
            lineHeight: "48px",
            boxShadow: focused ? "0 0 0 1px rgba(110,168,255,.12)" : "none",
          }}
        />
      </div>

      {/* Search options */}
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

      {/* Status */}
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

      {/* Empty state */}
      {query.trim() !== "" && !busy && !searchError && results.length === 0 && (
        <div
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
      )}

      {/* File results */}
      {fileResults.length > 0 && (
        <div
          style={{
            margin: "0 8px 10px",
            overflow: "hidden",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--surface)",
          }}
        >
          <ul
            style={{
              display: "flex",
              flexDirection: "column",
              maxHeight: 300,
              margin: 0,
              padding: 4,
              overflowY: "auto",
              listStyle: "none",
            }}
          >
            {fileResults.map((path, i) => {
              const isActive = i === activeIndex;

              return (
                <li
                  key={path}
                  className={isActive ? "active" : ""}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() =>
                    select({
                      kind: "file",
                      path,
                    })
                  }
                  data-testid="text-search-file-result"
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    minHeight: 36,
                    padding: "0 10px",
                    color: isActive ? "var(--fg)" : "var(--muted)",
                    background: isActive
                      ? "var(--surface-warm)"
                      : "transparent",
                    borderRadius: 5,
                    cursor: "pointer",
                    fontSize: 13,
                    boxSizing: "border-box",
                  }}
                >
                  {isActive && (
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
                      color: isActive ? "var(--fg)" : "var(--muted)",
                    }}
                  >
                    {fileIcon(path)}
                  </span>

                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {path}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Content matches */}
      {textMatches.length > 0 && (
        <div
          style={{
            margin: "0 8px 10px",
            overflow: "hidden",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--surface)",
          }}
        >
          <ul
            style={{
              display: "flex",
              flexDirection: "column",
              maxHeight: 280,
              margin: 0,
              padding: 4,
              overflowY: "auto",
              listStyle: "none",
            }}
          >
            {textMatches.map((match, i) => {
              const index = fileResults.length + i;
              const isActive = index === activeIndex;

              return (
                <li
                  key={`${match.path}:${match.line}:${i}`}
                  className={isActive ? "active" : ""}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() =>
                    select({
                      kind: "text",
                      match,
                    })
                  }
                  data-testid="text-search-text-result"
                  style={{
                    position: "relative",
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                    minHeight: 52,
                    padding: "7px 10px 7px 12px",
                    color: isActive ? "var(--fg)" : "var(--muted)",
                    background: isActive
                      ? "var(--surface-warm)"
                      : "transparent",
                    borderRadius: 5,
                    cursor: "pointer",
                    boxSizing: "border-box",
                  }}
                >
                  {isActive && (
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
                      color: isActive ? "var(--fg)" : "var(--muted)",
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
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
                      color: isActive ? "var(--fg)" : "var(--muted)",
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      fontSize: 11,
                    }}
                  >
                    {match.text}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Footer */}
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
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
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

        <span
          style={{
            margin: "0 9px",
            color: "var(--muted)",
          }}
        >
          ·
        </span>

        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
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

        <span
          style={{
            margin: "0 9px",
            color: "var(--muted)",
          }}
        >
          ·
        </span>

        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
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
    </MantineModal>
  );
}
