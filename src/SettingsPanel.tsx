import { useState } from "react";
import { Modal, Switch } from "@mantine/core";

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

export const ACCENT_PRESETS = [
  { name: "Dragon Green", hue: 145 },
  { name: "Ocean Blue", hue: 250 },
  { name: "Violet", hue: 300 },
  { name: "Amber", hue: 95 },
  { name: "Rose", hue: 350 },
  { name: "Teal", hue: 190 },
] as const;

export const FONT_PRESETS = [
  { name: "Default", value: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Monaco, Consolas, monospace" },
  { name: "JetBrains Mono", value: "'JetBrains Mono', ui-monospace, monospace" },
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
  return Number.isFinite(stored) && stored >= MIN_FONT_SIZE && stored <= MAX_FONT_SIZE
    ? stored
    : DEFAULT_EDITOR_FONT_SIZE;
}

type Props = {
  onOpenProjectSettings: () => void;
  onClose: () => void;
};

export default function SettingsPanel({ onOpenProjectSettings, onClose }: Props) {
  const [accentHue, setAccentHueState] = useState(loadAccentHue);
  const [editorFont, setEditorFontState] = useState(loadEditorFont);
  const [editorFontSize, setEditorFontSizeState] = useState(loadEditorFontSize);
  const [editorWrap, setEditorWrapState] = useState(loadEditorWrap);

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
    if (!Number.isFinite(size) || size < MIN_FONT_SIZE || size > MAX_FONT_SIZE) return;
    setEditorFontSizeState(size);
    localStorage.setItem(EDITOR_FONT_SIZE_KEY, String(size));
    window.dispatchEvent(new Event(EDITOR_FONT_CHANGED_EVENT));
  };

  return (
    <Modal opened onClose={onClose} title="Settings" className="settings-panel" data-testid="settings-panel">
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
