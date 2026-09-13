import { useMemo, useState } from "react";
import {
  IconAppWindow,
  IconCircle,
  IconColumns,
  IconFileText,
  IconSearch,
} from "@tabler/icons-react";
import Palette from "./Palette";
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
  const results = useMemo(
    () => filterCommands(commands, query),
    [commands, query]
  );

  const run = (command: Command) => {
    onClose();
    command.run();
  };

  const emptyState = (
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
        <IconSearch size={17} aria-hidden="true" stroke={1.8} />
      </div>
      <div>
        <div style={{ color: "var(--fg)", fontSize: 13, fontWeight: 500 }}>
          No matching command
        </div>
        <div style={{ marginTop: 3, color: "var(--muted)", fontSize: 12 }}>
          Try searching for another command.
        </div>
      </div>
    </div>
  );

  return (
    <Palette
      title="Run a command"
      items={results}
      renderItem={(command, { active, onSelect, onMouseEnter }) => (
        <li
          key={command.id}
          className={active ? "active" : ""}
          onMouseEnter={onMouseEnter}
          onClick={onSelect}
          data-testid="command-palette-item"
          data-command={command.id}
          role="option"
          aria-selected={active}
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            minHeight: 44,
            padding: "0 14px 0 12px",
            color: active ? "var(--fg)" : "var(--muted)",
            background: active ? "var(--surface-warm)" : "transparent",
            borderBottom: "1px solid var(--border)",
            cursor: "pointer",
            boxSizing: "border-box",
          }}
        >
          {active && (
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

          <span
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "0 0 32px",
              width: 32,
              height: 32,
              marginRight: 8,
              color: active ? "var(--fg)" : "var(--muted)",
            }}
          >
            <CommandIcon group={command.group} />
          </span>

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
                color: active ? "var(--fg)" : "var(--muted)",
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
                  boxShadow: "var(--shadow-keycap)",
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
      )}
      onSelect={run}
      onClose={onClose}
      query={query}
      onQueryChange={(value) => {
        setQuery(value);
      }}
      placeholder="Type a command…"
      shortcutHint="⌘⇧P"
      emptyState={emptyState}
      className="file-palette"
      inputTestId="command-palette-input"
      resultsTestId="command-palette-results"
      footer={
        <div
          style={{
            display: "flex",
            alignItems: "center",
            minHeight: 40,
            padding: "8px 16px",
            color: "var(--muted)",
            fontSize: 11,
            boxSizing: "border-box",
          }}
        >
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
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
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
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
          <span style={{ margin: "0 9px", color: "var(--muted)" }}>·</span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
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
