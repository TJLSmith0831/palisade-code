import { useEffect, useState } from "react";
import { Modal, Button, Switch } from "@mantine/core";
import * as api from "./api";
import {
  COMPLETION_ENABLED_KEY,
  COMPLETION_KEYBINDING_KEY,
  COMPLETION_SETTINGS_CHANGED_EVENT,
} from "./completion/GhostTextPlugin";

export {
  COMPLETION_ENABLED_KEY,
  COMPLETION_KEYBINDING_KEY,
  COMPLETION_SETTINGS_CHANGED_EVENT,
};

// Personal display preferences — localStorage, not .project-settings.json.
export const ACCENT_HUE_KEY = "floo:accentHue";
export const EDITOR_FONT_KEY = "floo:editorFont";
export const EDITOR_FONT_SIZE_KEY = "floo:editorFontSize";

export const EDITOR_FONT_CHANGED_EVENT = "floo:editor-font-changed";

export const EDITOR_WRAP_KEY = "floo:editorWrap";
export const EDITOR_WRAP_CHANGED_EVENT = "floo:editor-wrap-changed";

export const PROJECT_SETTINGS_FILE = ".project-settings.json";

/* -------------------------------------------------------------------------- */
/* Accent colors                                                              */
/* -------------------------------------------------------------------------- */

export const ACCENT_PRESETS = [
  { name: "Dragon Green", hue: 145 },
  { name: "Ocean Blue", hue: 250 },
  { name: "Violet", hue: 300 },
  { name: "Amber", hue: 95 },
  { name: "Rose", hue: 350 },
  { name: "Teal", hue: 190 },
  { name: "Red", hue: 25 },
  { name: "Orange", hue: 55 },
] as const;

/* -------------------------------------------------------------------------- */
/* Appearance colors                                                          */
/*                                                                            */
/* These are deliberately explicit rather than generated from accent hues.   */
/* Shell colors represent recognizable IDE/theme families.                    */
/* -------------------------------------------------------------------------- */

export type ThemeColor = {
  light: string;
  dark: string;
};

export type Appearance = {
  appShellColor?: ThemeColor;
  shellAccentColor?: ThemeColor;
  commentColor?: ThemeColor;
  codeTextColor?: ThemeColor;
};

type Preset = {
  name: string;
  light: string;
  dark: string;
};

/**
 * Shell backgrounds inspired by established editor palettes:
 *
 * One Light / One Dark
 * Nord
 * Solarized
 * Gruvbox
 * Catppuccin
 * Rosé Pine
 * Tokyo Night
 * Warm / GitHub
 */
export const SHELL_PRESETS: Preset[] = [
  {
    name: "Default",
    light: "#f7f8fa",
    dark: "#181a1d",
  },
  {
    name: "One Dark",
    light: "#fafafa",
    dark: "#282c34",
  },
  {
    name: "Nord",
    light: "#eceff4",
    dark: "#2e3440",
  },
  {
    name: "Solarized",
    light: "#fdf6e3",
    dark: "#002b36",
  },
  {
    name: "Gruvbox",
    light: "#fbf1c7",
    dark: "#282828",
  },
  {
    name: "Catppuccin",
    light: "#eff1f5",
    dark: "#1e1e2e",
  },
  {
    name: "Rosé Pine",
    light: "#faf4ed",
    dark: "#191724",
  },
  {
    name: "Tokyo Night",
    light: "#f1f3f8",
    dark: "#1a1b26",
  },
];

/**
 * Muted syntax-comment colors inspired by popular editor themes.
 *
 * Comments intentionally remain lower-contrast than executable code.
 */
export const COMMENT_PRESETS: Preset[] = [
  {
    name: "Default Gray",
    light: "#68727d",
    dark: "#6272a4",
  },
  {
    name: "Sage",
    light: "#5f6b5d",
    dark: "#a3be8c",
  },
  {
    name: "Slate",
    light: "#61707d",
    dark: "#7f8c8d",
  },
  {
    name: "Lavender",
    light: "#6d6875",
    dark: "#a6a0b5",
  },
  {
    name: "Warm Gray",
    light: "#756f64",
    dark: "#a3a29a",
  },
  {
    name: "Rose",
    light: "#7a666b",
    dark: "#b48e8e",
  },
  {
    name: "Teal",
    light: "#5f7775",
    dark: "#8fbcbb",
  },
  {
    name: "Purple",
    light: "#6b6680",
    dark: "#b39bc8",
  },
  {
    name: "Olive",
    light: "#697a62",
    dark: "#a3be8c",
  },
  {
    name: "Amber",
    light: "#7a6a4f",
    dark: "#d0b878",
  },
];

/**
 * Base editor text colors.
 *
 * These are intentionally closer to foreground colors than comment colors,
 * but still offer meaningful warm/cool alternatives.
 */
export const CODE_TEXT_PRESETS: Preset[] = [
  {
    name: "Default",
    light: "#17191c",
    dark: "#f2f4f7",
  },
  {
    name: "Cool",
    light: "#17202b",
    dark: "#d7e2e8",
  },
  {
    name: "Mint",
    light: "#17241f",
    dark: "#b8e6d5",
  },
  {
    name: "Blue",
    light: "#172035",
    dark: "#b9cbf5",
  },
  {
    name: "Rose",
    light: "#271a21",
    dark: "#f2c8c4",
  },
  {
    name: "Pink",
    light: "#271a24",
    dark: "#e8b8d0",
  },
  {
    name: "Warm",
    light: "#282018",
    dark: "#f0dcc1",
  },
  {
    name: "Amber",
    light: "#282414",
    dark: "#f2dd92",
  },
];

/* -------------------------------------------------------------------------- */
/* Appearance persistence                                                     */
/* -------------------------------------------------------------------------- */

export function applyAppearance(appearance: Appearance) {
  const set = (key: string, value?: string) =>
    value
      ? document.documentElement.style.setProperty(key, value)
      : document.documentElement.style.removeProperty(key);

  set("--app-shell-light-override", appearance.appShellColor?.light);
  set("--app-shell-dark-override", appearance.appShellColor?.dark);
  set("--shell-accent-light-override", appearance.shellAccentColor?.light);
  set("--shell-accent-dark-override", appearance.shellAccentColor?.dark);

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
    const appearance = (raw.appearance ?? {}) as Appearance & {
      shellColor?: ThemeColor;
    };

    return {
      appShellColor: appearance.appShellColor ?? appearance.shellColor,
      shellAccentColor: appearance.shellAccentColor,
      commentColor: appearance.commentColor,
      codeTextColor: appearance.codeTextColor,
    };
  } catch {
    return {};
  }
}

async function saveAppearance(projectHash: string, appearance: Appearance) {
  let parsed: Record<string, unknown> = {};

  try {
    parsed = JSON.parse(
      await api.readFileContent(projectHash, PROJECT_SETTINGS_FILE)
    );
  } catch {
    // File missing or malformed — start fresh.
  }

  parsed.appearance = appearance;

  await api.writeFileContent(
    projectHash,
    PROJECT_SETTINGS_FILE,
    JSON.stringify(parsed, null, 2) + "\n"
  );
}

/* -------------------------------------------------------------------------- */
/* Editor settings                                                            */
/* -------------------------------------------------------------------------- */

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
  {
    name: "Fira Code",
    value: "'Fira Code', ui-monospace, monospace",
  },
  {
    name: "Menlo",
    value: "Menlo, ui-monospace, monospace",
  },
  {
    name: "SF Mono",
    value: "'SF Mono', ui-monospace, monospace",
  },
  {
    name: "Consolas",
    value: "Consolas, ui-monospace, monospace",
  },
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

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

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
  const [completionEnabled, setCompletionEnabledState] = useState(
    () => localStorage.getItem(COMPLETION_ENABLED_KEY) !== "false"
  );
  const [completionKeybinding, setCompletionKeybindingState] = useState(
    () => localStorage.getItem(COMPLETION_KEYBINDING_KEY) || "Alt-Tab"
  );
  const [appearance, setAppearance] = useState<Appearance>({});

  useEffect(() => {
    if (!projectHash) {
      setAppearance({});
      return;
    }

    let cancelled = false;

    loadAppearance(projectHash).then((a) => {
      if (!cancelled) {
        setAppearance(a);
        applyAppearance(a);
      }
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

  const handleCompletionEnabled = (enabled: boolean) => {
    setCompletionEnabledState(enabled);
    localStorage.setItem(COMPLETION_ENABLED_KEY, String(enabled));
    void api.setCompletionEnabled(enabled).catch(() => {
      // best-effort backend sync
    });
    window.dispatchEvent(new Event(COMPLETION_SETTINGS_CHANGED_EVENT));
  };

  const handleCompletionKeybinding = (keybinding: string | null) => {
    if (!keybinding) return;
    setCompletionKeybindingState(keybinding);
    localStorage.setItem(COMPLETION_KEYBINDING_KEY, keybinding);
    void api.setCompletionKeybinding(keybinding).catch(() => {
      // best-effort backend sync
    });
    window.dispatchEvent(new Event(COMPLETION_SETTINGS_CHANGED_EVENT));
  };

  const setEditorFontSize = (size: number) => {
    if (
      !Number.isFinite(size) ||
      size < MIN_FONT_SIZE ||
      size > MAX_FONT_SIZE
    ) {
      return;
    }

    setEditorFontSizeState(size);
    localStorage.setItem(EDITOR_FONT_SIZE_KEY, String(size));

    window.dispatchEvent(new Event(EDITOR_FONT_CHANGED_EVENT));
  };

  const pickColor = (
    category: keyof Appearance,
    theme: "light" | "dark",
    value: string
  ) => {
    const current = appearance[category] ?? {};

    const next: Appearance = {
      ...appearance,
      [category]: {
        ...current,
        [theme]: value,
      },
    };

    setAppearance(next);
    applyAppearance(next);

    if (projectHash) {
      void saveAppearance(projectHash, next);
    }
  };

  const resetAppearance = () => {
    const next: Appearance = {};
    setAppearance(next);
    applyAppearance(next);

    if (projectHash) {
      void saveAppearance(projectHash, next);
    }
  };

  /* ------------------------------------------------------------------------ */
  /* Design tokens                                                            */
  /* ------------------------------------------------------------------------ */

  const panel = "#202224";
  const field = "#17191c";
  const border = "#33373c";
  const borderSubtle = "#2a2e33";
  const text = "#e5e7eb";
  const muted = "#9299a2";
  const dim = "#686f78";
  const accent = `oklch(65% 0.18 ${accentHue})`;

  const sectionLabel = {
    color: text,
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    marginBottom: 10,
  } as const;

  const rowLabel = {
    width: 46,
    flexShrink: 0,
    color: muted,
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.07em",
  };

  const swatchSize = 32;

  const SwatchRow = ({
    label,
    presets,
    theme,
    category,
    testId,
  }: {
    label: string;
    presets: Preset[];
    theme: "light" | "dark";
    category: keyof Appearance;
    testId: string;
  }) => {
    const selected = appearance[category]?.[theme];

    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          minHeight: 42,
        }}
      >
        <span style={rowLabel}>{label}</span>

        <div
          data-testid={testId}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {presets.map((preset) => {
            const value = preset[theme];
            const active = selected === value;

            return (
              <button
                key={`${preset.name}-${theme}`}
                type="button"
                title={preset.name}
                aria-label={`${label} ${preset.name}`}
                aria-pressed={active}
                onClick={() => pickColor(category, theme, value)}
                data-testid={`${testId}-swatch`}
                style={{
                  position: "relative",
                  width: swatchSize,
                  height: swatchSize,
                  padding: 0,
                  flexShrink: 0,
                  border: active
                    ? `2px solid ${text}`
                    : `1px solid rgba(255,255,255,.08)`,
                  outline: active ? `2px solid ${accent}` : "none",
                  outlineOffset: 1,
                  borderRadius: "50%",
                  background: value,
                  cursor: "pointer",
                  boxSizing: "border-box",
                  transition: "transform 100ms ease, box-shadow 100ms ease",
                }}
              />
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title="Settings"
      centered
      size={700}
      padding={0}
      radius={14}
      transitionProps={{
        duration: 120,
        transition: "fade",
      }}
      data-testid="settings-panel"
      styles={{
        overlay: {
          background: "rgba(0, 0, 0, .68)",
          backdropFilter: "blur(5px)",
        },
        content: {
          background: panel,
          border: `1px solid ${border}`,
          boxShadow: "0 28px 80px rgba(0,0,0,.55), 0 8px 28px rgba(0,0,0,.35)",
          overflow: "hidden",
        },
        header: {
          minHeight: 62,
          padding: "0 18px 0 22px",
          background: panel,
          borderBottom: `1px solid ${borderSubtle}`,
        },
        title: {
          color: text,
          fontSize: 17,
          fontWeight: 500,
          letterSpacing: "-0.025em",
        },
        close: {
          width: 32,
          height: 32,
          color: "#9ca3ab",
          borderRadius: 7,
        },
        body: {
          padding: 0,
          background: panel,
        },
      }}
    >
      <div
        style={{
          maxHeight: "calc(100vh - 110px)",
          overflowY: "auto",
          padding: "18px 22px 16px",
        }}
      >
        {/* ---------------------------------------------------------------- */}
        {/* Color scheme                                                     */}
        {/* ---------------------------------------------------------------- */}

        <section
          style={{
            paddingBottom: 18,
            marginBottom: 18,
            borderBottom: `1px solid ${borderSubtle}`,
          }}
        >
          <div style={sectionLabel}>Color scheme</div>

          <div
            data-testid="accent-swatches"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            {ACCENT_PRESETS.map((preset) => {
              const active = accentHue === preset.hue;

              return (
                <button
                  key={preset.hue}
                  type="button"
                  title={preset.name}
                  aria-label={preset.name}
                  aria-pressed={active}
                  onClick={() => setAccentHue(preset.hue)}
                  data-testid="accent-swatch"
                  style={{
                    width: 34,
                    height: 34,
                    padding: 0,
                    borderRadius: "50%",
                    border: active
                      ? `2px solid ${text}`
                      : "2px solid transparent",
                    outline: active ? `2px solid ${accent}` : "none",
                    outlineOffset: 1,
                    background: `oklch(65% 0.18 ${preset.hue})`,
                    cursor: "pointer",
                    boxSizing: "border-box",
                  }}
                />
              );
            })}
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* App shell                                                         */}
        {/* ---------------------------------------------------------------- */}

        <section
          style={{
            paddingBottom: 18,
            marginBottom: 18,
            borderBottom: `1px solid ${borderSubtle}`,
          }}
        >
          <div style={sectionLabel}>App shell</div>

          <SwatchRow
            label="Light"
            presets={SHELL_PRESETS}
            theme="light"
            category="appShellColor"
            testId="app-shell-swatches-light"
          />

          <SwatchRow
            label="Dark"
            presets={SHELL_PRESETS}
            theme="dark"
            category="appShellColor"
            testId="app-shell-swatches-dark"
          />
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Shell accent                                                      */}
        {/* ---------------------------------------------------------------- */}

        <section
          style={{
            paddingBottom: 18,
            marginBottom: 18,
            borderBottom: `1px solid ${borderSubtle}`,
          }}
        >
          <div style={sectionLabel}>Shell accent</div>

          <SwatchRow
            label="Light"
            presets={SHELL_PRESETS}
            theme="light"
            category="shellAccentColor"
            testId="shell-accent-swatches-light"
          />

          <SwatchRow
            label="Dark"
            presets={SHELL_PRESETS}
            theme="dark"
            category="shellAccentColor"
            testId="shell-accent-swatches-dark"
          />
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Code comments                                                     */}
        {/* ---------------------------------------------------------------- */}

        <section
          style={{
            paddingBottom: 18,
            marginBottom: 18,
            borderBottom: `1px solid ${borderSubtle}`,
          }}
        >
          <div style={sectionLabel}>Code comments</div>

          <SwatchRow
            label="Light"
            presets={COMMENT_PRESETS}
            theme="light"
            category="commentColor"
            testId="comment-swatches-light"
          />

          <SwatchRow
            label="Dark"
            presets={COMMENT_PRESETS}
            theme="dark"
            category="commentColor"
            testId="comment-swatches-dark"
          />
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Code text                                                         */}
        {/* ---------------------------------------------------------------- */}

        <section
          style={{
            paddingBottom: 18,
            marginBottom: 18,
            borderBottom: `1px solid ${borderSubtle}`,
          }}
        >
          <div style={sectionLabel}>Code text</div>

          <SwatchRow
            label="Light"
            presets={CODE_TEXT_PRESETS}
            theme="light"
            category="codeTextColor"
            testId="text-swatches-light"
          />

          <SwatchRow
            label="Dark"
            presets={CODE_TEXT_PRESETS}
            theme="dark"
            category="codeTextColor"
            testId="text-swatches-dark"
          />
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Reset appearance                                                  */}
        {/* ---------------------------------------------------------------- */}

        <section
          style={{
            paddingBottom: 18,
            marginBottom: 18,
            borderBottom: `1px solid ${borderSubtle}`,
          }}
        >
          <Button
            size="xs"
            variant="default"
            onClick={resetAppearance}
            data-testid="reset-appearance-button"
            fullWidth
          >
            Reset to default
          </Button>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Editor font                                                       */}
        {/* ---------------------------------------------------------------- */}

        <section
          style={{
            paddingBottom: 18,
            marginBottom: 18,
            borderBottom: `1px solid ${borderSubtle}`,
          }}
        >
          <div style={sectionLabel}>Editor font</div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <select
              id="editorFontSelect"
              value={editorFont}
              onChange={(event) => setEditorFont(event.target.value)}
              data-testid="editor-font-select"
              style={{
                flex: 1,
                minWidth: 0,
                height: 42,
                padding: "0 12px",
                color: text,
                background: field,
                border: `1px solid ${border}`,
                borderRadius: 7,
                outline: "none",
                fontFamily: "inherit",
                fontSize: 13,
                cursor: "pointer",
                boxSizing: "border-box",
              }}
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
              onChange={(event) =>
                setEditorFontSize(Number(event.target.value))
              }
              data-testid="editor-font-size-input"
              style={{
                width: 72,
                height: 42,
                padding: "0 10px",
                color: text,
                background: field,
                border: `1px solid ${border}`,
                borderRadius: 7,
                outline: "none",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 13,
                textAlign: "center",
                boxSizing: "border-box",
              }}
            />

            <span
              style={{
                color: muted,
                fontSize: 12,
                width: 18,
              }}
            >
              px
            </span>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Wrap                                                               */}
        {/* ---------------------------------------------------------------- */}

        <section
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingBottom: 18,
            marginBottom: 16,
            borderBottom: `1px solid ${borderSubtle}`,
          }}
        >
          <div>
            <div
              style={{
                color: text,
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              Wrap long lines
            </div>

            <div
              style={{
                marginTop: 3,
                color: dim,
                fontSize: 11,
              }}
            >
              Soft-wrap lines that exceed the editor width
            </div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={editorWrap}
            aria-label="Wrap long lines"
            onClick={() => setEditorWrap(!editorWrap)}
            data-testid="editor-wrap-toggle"
            style={{
              position: "relative",
              width: 42,
              height: 24,
              padding: 2,
              flexShrink: 0,
              border: "none",
              borderRadius: 999,
              background: editorWrap ? accent : "#343940",
              cursor: "pointer",
              transition: "background 120ms ease",
              boxSizing: "border-box",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 4,
                left: editorWrap ? 22 : 4,
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "#fff",
                boxShadow: "0 1px 3px rgba(0,0,0,.35)",
                transition: "left 120ms ease",
              }}
            />
          </button>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* AI completion                                                      */}
        {/* ---------------------------------------------------------------- */}

        <section
          style={{
            paddingBottom: 18,
            marginBottom: 18,
            borderBottom: `1px solid ${borderSubtle}`,
          }}
        >
          <div style={sectionLabel}>AI completion</div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 12,
            }}
          >
            <div>
              <div
                style={{
                  color: text,
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                Inline suggestions
              </div>
              <div
                style={{
                  marginTop: 3,
                  color: dim,
                  fontSize: 11,
                }}
              >
                Show ghost-text FIM completions while typing
              </div>
            </div>

            <Switch
              checked={completionEnabled}
              onChange={(event) =>
                handleCompletionEnabled(event.currentTarget.checked)
              }
              data-testid="completion-enabled-switch"
              aria-label="Enable inline AI completions"
            />
          </div>

          <label
            htmlFor="completion-keybinding-select"
            style={{
              display: "block",
              color: dim,
              fontSize: 11,
              marginBottom: 6,
            }}
          >
            Accept suggestion
          </label>
          <select
            id="completion-keybinding-select"
            value={completionKeybinding}
            onChange={(event) => handleCompletionKeybinding(event.target.value)}
            disabled={!completionEnabled}
            data-testid="completion-keybinding-select"
            style={{
              flex: 1,
              width: "100%",
              height: 42,
              padding: "0 12px",
              color: text,
              background: field,
              border: `1px solid ${border}`,
              borderRadius: 7,
              outline: "none",
              fontFamily: "inherit",
              fontSize: 13,
              cursor: completionEnabled ? "pointer" : "not-allowed",
              boxSizing: "border-box",
            }}
          >
            <option value="Alt-Tab">Option / Alt + Tab</option>
            <option value="Tab">Tab</option>
          </select>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Project settings                                                   */}
        {/* ---------------------------------------------------------------- */}

        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenProjectSettings();
          }}
          data-testid="open-project-settings"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: 0,
            color: accent,
            background: "transparent",
            border: "none",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Edit .project-settings.json
          <span style={{ fontSize: 14 }}>→</span>
        </button>

        {/* ---------------------------------------------------------------- */}
        {/* Footer                                                             */}
        {/* ---------------------------------------------------------------- */}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginTop: 18,
            color: dim,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 11,
          }}
        >
          <kbd
            style={{
              padding: "2px 6px",
              color: muted,
              background: "transparent",
              border: `1px solid ${border}`,
              borderRadius: 4,
              fontFamily: "inherit",
              fontSize: 10,
            }}
          >
            Esc
          </kbd>

          <span style={{ marginLeft: 7 }}>to close</span>
        </div>
      </div>
    </Modal>
  );
}
