import { useEffect, useState } from "react";
import { TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import * as api from "./api";
import type { TextMatch } from "./api";

// The Search rail panel. Reuses the existing `search_text` backend that the
// ⌘⇧F palette already calls — this is a second surface onto the same search,
// not a second search implementation.

export default function SearchPanel({
  projectHash,
  onOpenMatch,
  onError,
}: {
  projectHash: string;
  onOpenMatch: (path: string, line: number) => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<TextMatch[]>([]);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setMatches([]);
      setTruncated(false);
      return;
    }
    // Debounced so a typed query doesn't walk the tree on every keystroke.
    const timer = setTimeout(() => {
      api
        .searchText(projectHash, needle)
        .then((result) => {
          setMatches(result.matches);
          setTruncated(result.truncated);
        })
        .catch(onError);
    }, 200);
    return () => clearTimeout(timer);
  }, [query, projectHash, onError]);

  return (
    <>
      <div className="ds-panel-head">Search</div>
      <div className="ds-panel-body">
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search files…"
          aria-label="Search files"
          leftSection={<IconSearch size={14} />}
          data-testid="search-panel-input"
        />
        {query.trim() && matches.length === 0 && (
          <p className="empty">No matches.</p>
        )}
        {matches.map((match) => (
          <div
            key={`${match.path}:${match.line}`}
            className="ds-search-hit"
            role="button"
            tabIndex={0}
            onClick={() => onOpenMatch(match.path, match.line)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenMatch(match.path, match.line);
              }
            }}
            data-testid="search-hit"
          >
            <span className="ds-search-hit-path">
              {match.path}:{match.line}
            </span>
            <span className="ds-search-hit-text">{match.text.trim()}</span>
          </div>
        ))}
        {truncated && <p className="hint">More matches than shown.</p>}
      </div>
    </>
  );
}
