/**
 * Every action the app exposes, in one list.
 *
 * The command palette and the global keyboard handler both read this, so a
 * shortcut is declared once instead of being written into a keydown switch
 * and then described again somewhere the user can find it.
 */

export type Command = {
  id: string;
  label: string;
  /** Grouping shown in the palette. */
  group: string;
  /** Chord like "Mod+Shift+P". `Mod` is Cmd on macOS, Ctrl elsewhere. */
  chord?: string;
  /** Extra words to match on in the palette, never displayed. */
  keywords?: string;
  /** Hidden from the palette when false — still bound to its chord. */
  enabled?: boolean;
  run: () => void;
};

/** Human-facing chord, e.g. "⌘⇧P". macOS-only app, so no platform branch. */
export function formatChord(chord: string): string {
  return chord
    .split("+")
    .map((part) => {
      switch (part.toLowerCase()) {
        case "mod":
          return "⌘";
        case "shift":
          return "⇧";
        case "alt":
          return "⌥";
        case "ctrl":
          return "⌃";
        case "tab":
          return "⇥";
        case "backtick":
          return "`";
        case "backslash":
          return "\\";
        default:
          return part.toUpperCase();
      }
    })
    .join("");
}

/** Whether a keydown matches `chord`. Compares the *physical* key for
 * letters so a chord doesn't stop working under a different layout, and
 * requires modifiers to match exactly — otherwise "Mod+P" would also fire
 * on "Mod+Shift+P" and open two things at once. */
export function matchesChord(event: KeyboardEvent, chord: string): boolean {
  const parts = chord.split("+").map((p) => p.toLowerCase());
  const wantMod = parts.includes("mod");
  const wantShift = parts.includes("shift");
  const wantAlt = parts.includes("alt");
  const wantCtrl = parts.includes("ctrl");

  const mod = event.metaKey || (event.ctrlKey && !wantCtrl);
  if (wantMod !== mod) return false;
  if (wantShift !== event.shiftKey) return false;
  if (wantAlt !== event.altKey) return false;
  if (wantCtrl && !event.ctrlKey) return false;

  const key = parts[parts.length - 1];
  switch (key) {
    case "tab":
      return event.key === "Tab";
    case "backtick":
      return event.key === "`";
    case "backslash":
      return event.key === "\\";
    default:
      return event.key.toLowerCase() === key;
  }
}

/** Commands matching `query`, in list order. An empty query returns all of
 * them, so opening the palette is also a way to see what exists. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const trimmed = query.trim().toLowerCase();
  const available = commands.filter((command) => command.enabled !== false);
  if (!trimmed) return available;
  return available.filter((command) =>
    `${command.group} ${command.label} ${command.keywords ?? ""}`
      .toLowerCase()
      .includes(trimmed)
  );
}
