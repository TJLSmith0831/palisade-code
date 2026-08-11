import { useEffect, useMemo, useState } from "react";
import { Modal as MantineModal } from "@mantine/core";

type RenderItemContext = {
  active: boolean;
  onSelect: () => void;
  onMouseEnter: () => void;
};

type PaletteProps<T> = {
  title: string;
  /** All selectable items, in display order. */
  items: T[];
  /** Render one row. Receives interaction helpers and the active flag.
   * The returned element must carry its own `key`. */
  renderItem: (item: T, context: RenderItemContext) => React.ReactNode;
  /** Called when the user activates the active item (Enter or click). */
  onSelect: (item: T) => void;
  /** Called when the palette is dismissed (Escape, modal close). */
  onClose: () => void;
  /** Controlled query value. */
  query: string;
  /** Query change handler. The palette resets the active index on change. */
  onQueryChange: (query: string) => void;
  /** Placeholder for the search input. */
  placeholder?: string;
  /** Optional shortcut badge shown inside the input. */
  shortcutHint?: string;
  /** Optional content rendered between the input and results (e.g. toggles). */
  header?: React.ReactNode;
  /** Optional status line shown above results (e.g. busy / error / truncated). */
  status?: React.ReactNode;
  /** Content shown when there are no items and no status. */
  emptyState?: React.ReactNode;
  /** Optional footer; defaults to the standard keyboard hints. */
  footer?: React.ReactNode;
  /** Optional class name added to the modal content (e.g. `file-palette`). */
  className?: string;
  /** Optional class name added to the results `<ul>`. */
  resultsClassName?: string;
  /** Optional accessible label for the search input. */
  inputAriaLabel?: string;
  /** Optional data-testid for the search input. */
  inputTestId?: string;
  /** Optional data-testid for the results list. */
  resultsTestId?: string;
  /** Whether the palette should autofocus the input on open. */
  autoFocus?: boolean;
  /** Whether the search input is disabled (e.g. while a row is being renamed). */
  inputDisabled?: boolean;
};

const defaultFooter = (
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
    <KeyHint keys={["↑", "↓"]} label="navigate" />
    <span style={{ margin: "0 9px", color: "var(--muted)" }}>·</span>
    <KeyHint keys={["↵"]} label="select" />
    <span style={{ margin: "0 9px", color: "var(--muted)" }}>·</span>
    <KeyHint keys={["Esc"]} label="cancel" />
  </div>
);

function KeyHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      {keys.map((key) => (
        <kbd
          key={key}
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
          {key}
        </kbd>
      ))}
      <span>{label}</span>
    </span>
  );
}

/**
 * Shared modal palette: search input, keyboard-navigated results list, and
 * footer. Consumers own the query, the item list, and how each row renders.
 */
export default function Palette<T>({
  title,
  items,
  renderItem,
  onSelect,
  onClose,
  query,
  onQueryChange,
  placeholder = "Search…",
  shortcutHint,
  header,
  status,
  emptyState,
  footer = defaultFooter,
  className,
  resultsClassName,
  inputAriaLabel,
  inputTestId,
  resultsTestId,
  autoFocus = true,
  inputDisabled = false,
}: PaletteProps<T>) {
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const activeCount = items.length;
  const active = activeCount > 0 ? Math.min(activeIndex, activeCount - 1) : -1;

  useEffect(() => {
    setActiveIndex(0);
  }, [query, items.length]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (activeCount > 0) {
        setActiveIndex((i) => Math.min(i + 1, activeCount - 1));
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (activeCount > 0) {
        setActiveIndex((i) => Math.max(i - 1, 0));
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = active >= 0 ? items[active] : undefined;
      if (target) {
        onSelect(target);
      }
    }
  };

  const results = useMemo(
    () =>
      items.map((item, index) =>
        renderItem(item, {
          active: index === active,
          onSelect: () => onSelect(item),
          onMouseEnter: () => setActiveIndex(index),
        })
      ),
    [items, active, renderItem, onSelect]
  );

  return (
    <MantineModal
      opened
      onClose={onClose}
      title={title}
      centered
      size={680}
      padding={0}
      radius="md"
      classNames={className ? { content: className } : undefined}
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
            stroke: focused ? "var(--accent)" : "var(--muted)",
            strokeWidth: 1.8,
            pointerEvents: "none",
          }}
        >
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>

        <input
          data-autofocus={autoFocus ? "" : undefined}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          disabled={inputDisabled}
          aria-label={inputAriaLabel}
          data-testid={inputTestId}
          onKeyDown={handleKeyDown}
          style={{
            width: "100%",
            height: 48,
            padding: shortcutHint ? "0 74px 0 42px" : "0 16px 0 42px",
            color: "var(--fg)",
            background: "var(--surface)",
            border: `1px solid ${focused ? "var(--accent)" : "var(--border)"}`,
            borderRadius: 7,
            outline: "none",
            fontFamily: "inherit",
            fontSize: 15,
            lineHeight: "48px",
            boxSizing: "border-box",
            boxShadow: focused ? "0 0 0 1px rgba(110,168,255,.12)" : "none",
          }}
        />

        {shortcutHint && (
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
            {shortcutHint}
          </kbd>
        )}
      </div>

      {header}
      {status}

      {results.length > 0 ? (
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
            data-testid={resultsTestId}
            role="listbox"
            className={resultsClassName}
            style={
              resultsClassName
                ? undefined
                : {
                    display: "flex",
                    flexDirection: "column",
                    maxHeight: 386,
                    margin: 0,
                    padding: 4,
                    overflowY: "auto",
                    listStyle: "none",
                  }
            }
          >
            {results}
          </ul>
        </div>
      ) : (
        emptyState
      )}

      {footer}
    </MantineModal>
  );
}
