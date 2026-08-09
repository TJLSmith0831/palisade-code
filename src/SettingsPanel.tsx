import { useEffect, useState } from "react";
import { Modal, Switch } from "@mantine/core";
import * as api from "./api";

// Personal display preferences (D24 precedent: layout is personal, not
// project config) — localStorage, not .project-settings.json.
export const ACCENT_HUE_KEY = "floo:accentHue";
export const EDITOR_FONT_KEY = "floo:editorFont";
export const EDITOR_FONT_SIZE_KEY = "floo:editorFontSize";
/** Dispatched on `window` whenever the editor font/size changes, so a
 * mounted `FileEditorPane` can reconfigure live instead of waiting for the
 * next file switch. */
export const EDITOR_FONT_CHANGED_EVENT = "floo:editor-font-changed";
export const EDITOR_WRAP_KEY = "floo:editorWrap";
/** Same idea as EDITOR_FONT_CHANGED_EVENT: lets a mounted editor
 * reconfigure its wrap compartment without waiting for a file switch. */
export const EDITOR_WRAP_CHANGED_EVENT = "floo:editor-wrap-changed";

/** Project-scoped settings file (Rust-owned keys: formatOnSave,
 * executorOverride). The appearance key below is frontend-only and
 * round-trips safely because serde ignores unknown fields. Duplicated as
 * a literal in App.tsx — a one-line const in two files beats a circular
 * import between App.tsx and SettingsPanel.tsx. */
export const PROJECT_SETTINGS_FILE = ".project-settings.json";

export const ACCENT_PRESETS = [
  { name: "Dragon Green", hue: 145 },
  { name: "Ocean Blue", hue: 250 },
  { name: "Violet", hue: 300 },
  { name: "Amber", hue: 95 },
  { name: "Rose", hue: 350 },
  { name: "Teal", hue: 190 },
] as const;

// --- Appearance (project-scoped OKLCH color pickers) ----------------------
//
// Three categories — shell (chrome background), code comment, code text —
// each with independent light/dark values. Swatches reuse the existing
// ACCENT_PRESETS hues plus a chroma-0 "Default" entry, wrapped in a
// per-category lightness/chroma envelope that stays within the existing
// token ranges (--chrome-bg, --muted, --fg) so contrast is preserved.

export type ThemeColor = { light: string; dark: string };
export type Appearance = {
  shellColor?: ThemeColor;
  commentColor?: ThemeColor;
  codeTextColor?: ThemeColor;
};

type Preset = { name: string; light: string; dark: string };

/** Build a preset list from ACCENT_PRESETS plus a chroma-0 Default, using
 * the given lightness/chroma envelope per theme. The Default entry uses
 * chroma 0 (pure gray) so it's visually distinct from any named hue that
 * happens to share its hue angle (e.g. Ocean Blue is also hue 250). */
function buildPresets(env: {
  lightL: number;
  lightC: number;
  darkL: number;
  darkC: number;
}): Preset[] {
  return [{ name: "Default", hue: 250 }, ...ACCENT_PRESETS].map((p, i) => ({
    name: p.name,
    light:
      i === 0
        ? `oklch(${env.lightL}% 0 ${p.hue})`
        : `oklch(${env.lightL}% ${env.lightC} ${p.hue})`,
    dark:
      i === 0
        ? `oklch(${env.darkL}% 0 ${p.hue})`
        : `oklch(${env.darkL}% ${env.darkC} ${p.hue})`,
  }));
}

// Shell: matches --chrome-bg envelopes (dark 15% 0.004, light 97% 0.004).
export const SHELL_PRESETS = buildPresets({
  lightL: 97,
  lightC: 0.004,
  darkL: 15,
  darkC: 0.004,
});
// Comment: matches --muted envelopes (dark 66% 0.012, light 46% 0.012).
export const COMMENT_PRESETS = buildPresets({
  lightL: 46,
  lightC: 0.012,
  darkL: 66,
  darkC: 0.012,
});
// Code text: matches --fg envelopes (dark 96% 0.003, light 20% 0.006).
export const CODE_TEXT_PRESETS = buildPresets({
  lightL: 20,
  lightC: 0.006,
  darkL: 96,
  darkC: 0.003,
});

export function applyAppearance(appearance: Appearance) {
  const set = (key: string, value?: string) =>
    value
      ? document.documentElement.style.setProperty(key, value)
      : document.documentElement.style.removeProperty(key);
  set("--chrome-bg-light-override", appearance.shellColor?.light);
  set("--chrome-bg-dark-override", appearance.shellColor?.dark);
  set("--code-comment-light-override", appearance.commentColor?.light);
  set("--code-comment-dark-override", appearance.commentColor?.dark);
  set("--code-text-light-override", appearance.codeTextColor?.light);
  set("--code-text-dark-override", appearance.codeTextColor?.dark);
}

export async function loadAppearance(projectHash: string): Promise<Appearance> {
  try {
    const raw = JSON.parse(
      await api.readFileContent(projectHash, PROJECT_SETTINGS_FILE)
    );
    return raw.appearance ?? {};
  } catch {
    return {}; // missing/malformed file — same tolerance as the Rust loader
  }
}

async function saveAppearance(projectHash: string, appearance: Appearance) {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(
      await api.readFileContent(projectHash, PROJECT_SETTINGS_FILE)
    );
  } catch {
    /* file missing or malformed — start fresh */
  }
  parsed.appearance = appearance;
  await api.writeFileContent(
    projectHash,
    PROJECT_SETTINGS_FILE,
    JSON.stringify(parsed, null, 2) + "\n"
  );
}

export const FONT_PRESETS = [
  {
    name: "Default",
    value:
      "'Geist Mono', 'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, Monaco, Consolas, monospace",
  },
  {
    name: "JetBrains Mono",
    value: "'JetBrains Mono', ui-monospace, monospace",
  },
  { name: "Fira Code", value: "'Fira Code', ui-monospace, monospace" },
  { name: "Menlo", value: "Menlo, ui-monospace, monospace" },
  { name: "SF Mono", value: "'SF Mono', ui-monospace, monospace" },
  { name: "Consolas", value: "Consolas, ui-monospace, monospace" },
] as const;

export const DEFAULT_ACCENT_HUE: number = ACCENT_PRESETS[0].hue;
export const DEFAULT_EDITOR_FONT: string = FONT_PRESETS[0].value;
export const DEFAULT_EDITOR_FONT_SIZE = 12;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

export function loadAccentHue(): number {
  const stored = Number(localStorage.getItem(ACCENT_HUE_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_ACCENT_HUE;
}

export function applyAccentHue(hue: number) {
  document.documentElement.style.setProperty("--accent-hue", String(hue));
  localStorage.setItem(ACCENT_HUE_KEY, String(hue));
}

export function loadEditorFont(): string {
  return localStorage.getItem(EDITOR_FONT_KEY) || DEFAULT_EDITOR_FONT;
}

/** Off by default: code is written to a column, and soft-wrapping it by
 * default hides that the line is long. */
export function loadEditorWrap(): boolean {
  return localStorage.getItem(EDITOR_WRAP_KEY) === "1";
}

export function loadEditorFontSize(): number {
  const stored = Number(localStorage.getItem(EDITOR_FONT_SIZE_KEY));
  return Number.isFinite(stored) &&
    stored >= MIN_FONT_SIZE &&
    stored <= MAX_FONT_SIZE
    ? stored
    : DEFAULT_EDITOR_FONT_SIZE;
}

type Props = {
  projectHash: string;
  onOpenProjectSettings: () => void;
  onClose: () => void;
};

export default function SettingsPanel({
  projectHash,
  onOpenProjectSettings,
  onClose,
}: Props) {
  const [accentHue, setAccentHueState] = useState(loadAccentHue);
  const [editorFont, setEditorFontState] = useState(loadEditorFont);
  const [editorFontSize, setEditorFontSizeState] = useState(loadEditorFontSize);
  const [editorWrap, setEditorWrapState] = useState(loadEditorWrap);
  const [appearance, setAppearance] = useState<Appearance>({});

  // Load project-scoped appearance on mount / project switch. An empty
  // projectHash (no project open) skips the read entirely.
  useEffect(() => {
    if (!projectHash) {
      setAppearance({});
      return;
    }
    let cancelled = false;
    loadAppearance(projectHash).then((a) => {
      if (!cancelled) setAppearance(a);
    });
    return () => {
      cancelled = true;
    };
  }, [projectHash]);

  const setAccentHue = (hue: number) => {
    setAccentHueState(hue);
    applyAccentHue(hue);
  };

  const setEditorFont = (value: string) => {
    setEditorFontState(value);
    localStorage.setItem(EDITOR_FONT_KEY, value);
    window.dispatchEvent(new Event(EDITOR_FONT_CHANGED_EVENT));
  };

  const setEditorWrap = (wrap: boolean) => {
    setEditorWrapState(wrap);
    localStorage.setItem(EDITOR_WRAP_KEY, wrap ? "1" : "0");
    window.dispatchEvent(new Event(EDITOR_WRAP_CHANGED_EVENT));
  };

  const setEditorFontSize = (size: number) => {
    if (!Number.isFinite(size) || size < MIN_FONT_SIZE || size > MAX_FONT_SIZE)
      return;
    setEditorFontSizeState(size);
    localStorage.setItem(EDITOR_FONT_SIZE_KEY, String(size));
    window.dispatchEvent(new Event(EDITOR_FONT_CHANGED_EVENT));
  };

  /** Pick a color for one category/theme, apply it live, and persist the
   * merged appearance to .project-settings.json. Mirrors the accent-swatch
   * handler's click → apply → persist shape, just async on the persist leg. */
  const pickColor = (
    category: keyof Appearance,
    theme: "light" | "dark",
    value: string
  ) => {
    const current = appearance[category] ?? {};
    const next: Appearance = {
      ...appearance,
      [category]: { ...current, [theme]: value },
    };
    setAppearance(next);
    applyAppearance(next);
    if (projectHash) void saveAppearance(projectHash, next);
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title="Settings"
      className="settings-panel"
      data-testid="settings-panel"
    >
      <div className="settings-section">
        <label>Color scheme</label>
        <div className="accent-swatches" data-testid="accent-swatches">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.hue}
              className={`accent-swatch ${accentHue === preset.hue ? "active" : ""}`}
              style={{ background: `oklch(65% 0.18 ${preset.hue})` }}
              title={preset.name}
              aria-label={preset.name}
              aria-pressed={accentHue === preset.hue}
              onClick={() => setAccentHue(preset.hue)}
              data-testid="accent-swatch"
            />
          ))}
        </div>
      </div>

      <div className="settings-section">
        <label>Shell color</label>
        <div className="appearance-row">
          <span className="appearance-row-label">Light</span>
          <div className="accent-swatches" data-testid="shell-swatches-light">
            {SHELL_PRESETS.map((preset, i) => (
              <button
                key={`${preset.name}-${i}`}
                className={`accent-swatch ${appearance.shellColor?.light === preset.light ? "active" : ""}`}
                style={{ background: preset.light }}
                title={preset.name}
                aria-label={`Shell light ${preset.name}`}
                aria-pressed={appearance.shellColor?.light === preset.light}
                onClick={() => pickColor("shellColor", "light", preset.light)}
                data-testid="shell-swatch-light"
              />
            ))}
          </div>
        </div>
        <div className="appearance-row">
          <span className="appearance-row-label">Dark</span>
          <div className="accent-swatches" data-testid="shell-swatches-dark">
            {SHELL_PRESETS.map((preset, i) => (
              <button
                key={`${preset.name}-${i}`}
                className={`accent-swatch ${appearance.shellColor?.dark === preset.dark ? "active" : ""}`}
                style={{ background: preset.dark }}
                title={preset.name}
                aria-label={`Shell dark ${preset.name}`}
                aria-pressed={appearance.shellColor?.dark === preset.dark}
                onClick={() => pickColor("shellColor", "dark", preset.dark)}
                data-testid="shell-swatch-dark"
              />
            ))}
          </div>
        </div>
      </div>

      <div className="settings-section">
        <label>Code comments</label>
        <div className="appearance-row">
          <span className="appearance-row-label">Light</span>
          <div className="accent-swatches" data-testid="comment-swatches-light">
            {COMMENT_PRESETS.map((preset, i) => (
              <button
                key={`${preset.name}-${i}`}
                className={`accent-swatch ${appearance.commentColor?.light === preset.light ? "active" : ""}`}
                style={{ background: preset.light }}
                title={preset.name}
                aria-label={`Comment light ${preset.name}`}
                aria-pressed={appearance.commentColor?.light === preset.light}
                onClick={() => pickColor("commentColor", "light", preset.light)}
                data-testid="comment-swatch-light"
              />
            ))}
          </div>
        </div>
        <div className="appearance-row">
          <span className="appearance-row-label">Dark</span>
          <div className="accent-swatches" data-testid="comment-swatches-dark">
            {COMMENT_PRESETS.map((preset, i) => (
              <button
                key={`${preset.name}-${i}`}
                className={`accent-swatch ${appearance.commentColor?.dark === preset.dark ? "active" : ""}`}
                style={{ background: preset.dark }}
                title={preset.name}
                aria-label={`Comment dark ${preset.name}`}
                aria-pressed={appearance.commentColor?.dark === preset.dark}
                onClick={() => pickColor("commentColor", "dark", preset.dark)}
                data-testid="comment-swatch-dark"
              />
            ))}
          </div>
        </div>
      </div>

      <div className="settings-section">
        <label>Code text</label>
        <div className="appearance-row">
          <span className="appearance-row-label">Light</span>
          <div className="accent-swatches" data-testid="text-swatches-light">
            {CODE_TEXT_PRESETS.map((preset, i) => (
              <button
                key={`${preset.name}-${i}`}
                className={`accent-swatch ${appearance.codeTextColor?.light === preset.light ? "active" : ""}`}
                style={{ background: preset.light }}
                title={preset.name}
                aria-label={`Code text light ${preset.name}`}
                aria-pressed={appearance.codeTextColor?.light === preset.light}
                onClick={() =>
                  pickColor("codeTextColor", "light", preset.light)
                }
                data-testid="text-swatch-light"
              />
            ))}
          </div>
        </div>
        <div className="appearance-row">
          <span className="appearance-row-label">Dark</span>
          <div className="accent-swatches" data-testid="text-swatches-dark">
            {CODE_TEXT_PRESETS.map((preset, i) => (
              <button
                key={`${preset.name}-${i}`}
                className={`accent-swatch ${appearance.codeTextColor?.dark === preset.dark ? "active" : ""}`}
                style={{ background: preset.dark }}
                title={preset.name}
                aria-label={`Code text dark ${preset.name}`}
                aria-pressed={appearance.codeTextColor?.dark === preset.dark}
                onClick={() => pickColor("codeTextColor", "dark", preset.dark)}
                data-testid="text-swatch-dark"
              />
            ))}
          </div>
        </div>
      </div>

      <div className="settings-section">
        <label htmlFor="editorFontSelect">Editor font</label>
        <div className="settings-row">
          <select
            id="editorFontSelect"
            value={editorFont}
            onChange={(event) => setEditorFont(event.target.value)}
            data-testid="editor-font-select"
          >
            {FONT_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.name}
              </option>
            ))}
          </select>
          <input
            id="editorFontSize"
            type="number"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            value={editorFontSize}
            aria-label="Editor font size"
            onChange={(event) => setEditorFontSize(Number(event.target.value))}
            data-testid="editor-font-size-input"
          />
          <span className="settings-unit">px</span>
        </div>
      </div>

      <div className="settings-section">
        <Switch
          label="Wrap long lines"
          checked={editorWrap}
          onChange={(event) => setEditorWrap(event.currentTarget.checked)}
          data-testid="editor-wrap-toggle"
        />
      </div>

      <div className="settings-section">
        <button
          className="settings-link"
          onClick={() => {
            onClose();
            onOpenProjectSettings();
          }}
          data-testid="open-project-settings"
        >
          Edit .project-settings.json →
        </button>
      </div>

      <span className="hint">Esc to close</span>
    </Modal>
  );
}
