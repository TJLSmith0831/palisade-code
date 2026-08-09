import { useMemo, useState } from "react";
import { Modal as MantineModal } from "@mantine/core";
import { filterCommands, formatChord, type Command } from "./commands";

type Props = {
  commands: Command[];
  onClose: () => void;
};

/** ⌘⇧P — every action in the app, searchable.
 *
 * Built on the same Mantine Modal + filtered list the file and find-in-files
 * palettes use, rather than a second palette idiom sitting next to them. */
export default function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const active = Math.min(activeIndex, Math.max(results.length - 1, 0));

  const run = (command: Command) => {
    onClose();
    command.run();
  };

  return (
    <MantineModal
      opened
      onClose={onClose}
      title="Run a command"
      classNames={{ content: "file-palette" }}
      transitionProps={{ duration: 0 }}
    >
      <input
        data-autofocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
        }}
        placeholder="Type a command…"
        autoComplete="off"
        data-testid="command-palette-input"
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
            const target = results[active];
            if (target) run(target);
          }
        }}
      />
      {results.length === 0 ? (
        <div className="file-palette-empty" data-testid="command-palette-empty">
          No matching command
        </div>
      ) : (
        <ul className="file-palette-results" data-testid="command-palette-results">
          {results.map((command, i) => (
            <li
              key={command.id}
              className={i === active ? "active" : ""}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => run(command)}
              data-testid="command-palette-item"
              data-command={command.id}
            >
              <span className="file-palette-path">
                <span className="ds-command-group">{command.group}:</span> {command.label}
              </span>
              {command.chord && (
                <span className="ds-command-chord">{formatChord(command.chord)}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <span className="hint">↑↓ to navigate · Enter to run · Esc to cancel</span>
    </MantineModal>
  );
}
