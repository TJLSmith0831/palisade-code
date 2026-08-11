import { useMemo, useState } from "react";
import { Modal as MantineModal } from "@mantine/core";
import {
  IconAppWindow,
  IconCircle,
  IconColumns,
  IconFileText,
} from "@tabler/icons-react";
import { filterCommands, formatChord, type Command } from "./commands";

type Props = {
  commands: Command[];
  onClose: () => void;
};

function CommandIcon({ group }: { group: string }) {
  const normalized = group.toLowerCase();

  if (normalized === "go") {
    return <IconFileText size={19} aria-hidden="true" />;
  }

  if (normalized === "tabs") {
    return <IconColumns size={19} aria-hidden="true" />;
  }

  if (normalized === "view") {
    return <IconAppWindow size={19} aria-hidden="true" />;
  }

  return <IconCircle size={19} aria-hidden="true" />;
}

/** ⌘⇧P — every action in the app, searchable. */
export default function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(
    () => filterCommands(commands, query),
    [commands, query]
  );

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
      centered
      size={680}
      padding={0}
      radius="md"
      classNames={{
        content: "file-palette",
      }}
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
          margin: "4px 16px 12px",
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
            stroke: "var(--muted)",
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
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          placeholder="Type a command…"
          autoComplete="off"
          spellCheck={false}
          data-testid="command-palette-input"
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

              const target = results[active];

              if (target) {
                run(target);
              }
            }
          }}
          style={{
            width: "100%",
            height: 48,
            padding: "0 74px 0 42px",
            color: "var(--fg)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 7,
            outline: "none",
            fontFamily: "inherit",
            fontSize: 15,
            lineHeight: "48px",
            boxSizing: "border-box",
          }}
        />

        <kbd
          style={{
            position: "absolute",
            right: 9,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            height: 28,
            padding: "0 8px",
            color: "var(--muted)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            fontFamily: "inherit",
            fontSize: 11,
            fontWeight: 500,
          }}
        >
          ⌘⇧P
        </kbd>
      </div>

      {/* Results */}
      {results.length === 0 ? (
        <div
          className="file-palette-empty"
          data-testid="command-palette-empty"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            minHeight: 96,
            margin: "0 8px",
            padding: 18,
            color: "var(--muted)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 36,
              height: 36,
              color: "var(--muted)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              flexShrink: 0,
            }}
          >
            <svg
              viewBox="0 0 24 24"
              aria-hidden="true"
              style={{
                width: 17,
                height: 17,
                fill: "none",
                stroke: "currentColor",
                strokeWidth: 1.8,
                strokeLinecap: "round",
              }}
            >
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4 4" />
            </svg>
          </div>

          <div>
            <div
              style={{
                color: "var(--fg)",
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              No matching command
            </div>

            <div
              style={{
                marginTop: 3,
                color: "var(--muted)",
                fontSize: 12,
              }}
            >
              Try searching for another command.
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            margin: "0 8px",
            overflow: "hidden",
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--surface)",
          }}
        >
          <ul
            className="file-palette-results"
            data-testid="command-palette-results"
            role="listbox"
            style={{
              display: "flex",
              flexDirection: "column",
              maxHeight: 386,
              margin: 0,
              padding: 0,
              overflowY: "auto",
              listStyle: "none",
            }}
          >
            {results.map((command, i) => {
              const isActive = i === active;

              return (
                <li
                  key={command.id}
                  className={isActive ? "active" : ""}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => run(command)}
                  data-testid="command-palette-item"
                  data-command={command.id}
                  role="option"
                  aria-selected={isActive}
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    minHeight: 50,
                    padding: "0 14px 0 12px",
                    color: isActive ? "var(--fg)" : "var(--muted)",
                    background: isActive
                      ? "var(--surface-warm)"
                      : "transparent",
                    borderBottom:
                      i === results.length - 1
                        ? "none"
                        : "1px solid var(--border)",
                    cursor: "pointer",
                    boxSizing: "border-box",
                  }}
                >
                  {isActive && (
                    <span
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: 0,
                        width: 2,
                        background: "var(--accent)",
                      }}
                    />
                  )}

                  {/* Icon */}
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flex: "0 0 32px",
                      width: 32,
                      height: 32,
                      marginRight: 8,
                      color: isActive ? "var(--fg)" : "var(--muted)",
                    }}
                  >
                    <CommandIcon group={command.group} />
                  </span>

                  {/* Command name */}
                  <span
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      minWidth: 0,
                      flex: 1,
                      gap: 5,
                    }}
                  >
                    <span
                      style={{
                        color: isActive ? "var(--fg)" : "var(--muted)",
                        fontSize: 13,
                        fontWeight: 500,
                      }}
                    >
                      {command.group}
                    </span>

                    <span
                      style={{
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: "inherit",
                        fontSize: 13,
                        fontWeight: 450,
                      }}
                    >
                      {command.label}
                    </span>
                  </span>

                  {/* Shortcut */}
                  {command.chord && (
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 3,
                        flexShrink: 0,
                        marginLeft: 16,
                      }}
                    >
                      <kbd
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          minWidth: 22,
                          height: 24,
                          padding: "0 6px",
                          color: "var(--muted)",
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderBottomColor: "var(--border)",
                          borderRadius: 5,
                          boxShadow: "0 1px 0 rgba(0,0,0,.25)",
                          fontFamily: "inherit",
                          fontSize: 11,
                          fontWeight: 500,
                          lineHeight: 1,
                          whiteSpace: "pre",
                        }}
                      >
                        {formatChord(command.chord)}
                      </kbd>
                    </span>
                  )}
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
          minHeight: 52,
          padding: "10px 16px",
          color: "var(--muted)",
          fontSize: 11,
          boxSizing: "border-box",
        }}
      >
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

          <span>run</span>
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
