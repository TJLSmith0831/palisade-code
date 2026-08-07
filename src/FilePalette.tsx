import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "./fuzzyMatch";

const MAX_RESULTS = 50;

type Props = {
  files: string[];
  onSelect: (path: string) => void;
  onClose: () => void;
};

export default function FilePalette({ files, onSelect, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const select = (path: string) => {
    onSelect(path);
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="commandbar file-palette" onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files by name…"
          autoComplete="off"
          data-testid="file-palette-input"
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
        <ul className="file-palette-results" data-testid="file-palette-results">
          {results.length === 0 && <li className="file-palette-empty">No matching files</li>}
          {results.map((path, i) => (
            <li
              key={path}
              className={i === activeIndex ? "active" : ""}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => select(path)}
              data-testid="file-palette-result"
            >
              {path}
            </li>
          ))}
        </ul>
        <span className="hint">↑↓ to navigate · Enter to open · Esc to cancel</span>
      </div>
    </div>
  );
}
