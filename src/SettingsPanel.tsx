import { useEffect, useState, useRef } from "react";
import { Modal, Button, NumberInput, Select, Switch, SegmentedControl, Alert } from "@mantine/core";
import * as api from "./api";
import {
  COMPLETION_ENABLED_KEY,
  COMPLETION_KEYBINDING_KEY,
  persistCompletionEnabled,
  COMPLETION_SETTINGS_CHANGED_EVENT,
} from "./completion/GhostTextPlugin";
import { describeError } from "./errors";

export {
  COMPLETION_ENABLED_KEY,
  COMPLETION_KEYBINDING_KEY,
  COMPLETION_SETTINGS_CHANGED_EVENT,
};

// Personal display preferences — localStorage, not .palisade/project-settings.json.
export const ACCENT_HUE_KEY = "palisade:accentHue";
export const EDITOR_FONT_KEY = "palisade:editorFont";
export const EDITOR_FONT_SIZE_KEY = "palisade:editorFontSize";

export const EDITOR_FONT_CHANGED_EVENT = "palisade:editor-font-changed";

export const EDITOR_WRAP_KEY = "palisade:editorWrap";
export const EDITOR_WRAP_CHANGED_EVENT = "palisade:editor-wrap-changed";

export const PROJECT_SETTINGS_FILE = ".palisade/project-settings.json";

/* -------------------------------------------------------------------------- */
/* Accent colors                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Accent hues a user can pick for Agent Signal.
 *
 * --danger (25), --warn (65) and --success (160) own their hues, and an
 * accent that lands on one stops reading as "the agent is acting" and starts
 * reading as a status. Red sat at exactly 25 and Orange at 55, ten degrees
 * off warn; in light mode, where the accent shares the semantics' lightness
 * band, both were near-indistinguishable from the semantic they shadowed.
 * They are replaced by two hues with real clearance. See DESIGN.md,
 * "Reserved hues", for why the fix is hue and not lightness.
 *
 * Dragon Green stays at 145, fifteen degrees from --success, as a stated
 * exception: it is the product's identity colour, and --success only ever
 * draws as a thin chain-node border (DESIGN.md), never as a fill beside an
 * accent fill.
 */
export const ACCENT_PRESETS = [
  { name: "Dragon Green", hue: 145 },
  { name: "Ocean Blue", hue: 250 },
  { name: "Violet", hue: 300 },
  { name: "Amber", hue: 95 },
  { name: "Rose", hue: 350 },
  { name: "Teal", hue: 190 },
  { name: "Lime", hue: 120 },
  { name: "Magenta", hue: 325 },
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

export const GLOBAL_APPEARANCE_KEY = "palisade:appearance";

export function loadGlobalAppearance(): Appearance {
  try { return JSON.parse(localStorage.getItem(GLOBAL_APPEARANCE_KEY) || "{}"); }
  catch { return {}; }
}

export function mergeAppearance(defaults: Appearance, overrides: Appearance): Appearance {
  const result: Appearance = {};
  for (const key of ["appShellColor", "shellAccentColor", "commentColor", "codeTextColor"] as const) {
    if (defaults[key] || overrides[key]) result[key] = { ...defaults[key], ...overrides[key] } as ThemeColor;
  }
  return result;
}

export async function loadAppearance(projectHash: string): Promise<Appearance> {
  return mergeAppearance(loadGlobalAppearance(), projectHash ? await loadProjectAppearance(projectHash) : {});
}

async function loadProjectAppearance(projectHash: string): Promise<Appearance> {
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
  await api.saveAppearance(projectHash, appearance);
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
  const [globalAppearance, setGlobalAppearance] = useState(loadGlobalAppearance);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const [scope, setScope] = useState(projectHash ? "project" : "global");
  const displayedAppearance = scope === "global" ? globalAppearance : mergeAppearance(globalAppearance, appearance);

  useEffect(() => {
    if (!projectHash) {
      setAppearance({});
      return;
    }

    let cancelled = false;

    loadProjectAppearance(projectHash).then((a) => {
      if (!cancelled) {
        setAppearance(a);
        applyAppearance(mergeAppearance(loadGlobalAppearance(), a));
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
    void persistCompletionEnabled(enabled, api.setCompletionEnabled);
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

  const updateAppearance = async (next: Appearance) => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      if (scope === "global") {
        localStorage.setItem(GLOBAL_APPEARANCE_KEY, JSON.stringify(next));
        setGlobalAppearance(next);
        applyAppearance(mergeAppearance(next, appearance));
      } else {
        await saveAppearance(projectHash, next);
        setAppearance(next);
        applyAppearance(mergeAppearance(globalAppearance, next));
      }
    } catch (error) {
      setSaveError(`${describeError(error, { action: "save that appearance" })}. Try again.`);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  const pickColor = (category: keyof Appearance, theme: "light" | "dark", value: string) => {
    const current = scope === "global" ? globalAppearance : appearance;
    updateAppearance({ ...current, [category]: { ...current[category], [theme]: value } });
  };

  const resetAppearance = () => updateAppearance({});

  /* ------------------------------------------------------------------------ */
  /* Design tokens                                                            */
  /* ------------------------------------------------------------------------ */

  /* These were a second, hand-picked hex palette that shadowed the real
     tokens: it never followed light mode (the modal stayed dark on a light
     shell), and its accent was computed at 65% lightness against the token's
     88%, so the accent picker previewed a visibly different green from the
     one it applied. Pointing them at the tokens keeps every call site below
     unchanged while putting the modal back on the app's single palette. */
  const panel = "var(--bg)";
  const border = "var(--border)";
  const borderSubtle = "color-mix(in oklab, var(--border), transparent 45%)";
  const text = "var(--fg)";
  const muted = "var(--muted)";
  const dim = "color-mix(in oklab, var(--muted), transparent 30%)";
  const accent = "var(--accent)";

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
    const selected = displayedAppearance[category]?.[theme];

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
                disabled={saving}
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
      radius="md"
      transitionProps={{
        duration: 120,
        transition: "fade",
      }}
      data-testid="settings-panel"
      closeButtonProps={{ "aria-label": "Close settings" }}
      styles={{
        overlay: {
          background: "var(--scrim)",
          backdropFilter: "blur(5px)",
        },
        content: {
          background: panel,
          border: `1px solid ${border}`,
          boxShadow: "var(--shadow-lift)",
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
          fontSize: 16,
          fontWeight: 500,
          letterSpacing: "-0.025em",
        },
        close: {
          width: 32,
          height: 32,
          color: "var(--muted)",
          borderRadius: 6,
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
            paddingBottom: 16,
            marginBottom: 16,
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
                    background: `oklch(var(--accent-l) var(--accent-c) ${preset.hue})`,
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

        {saveError && <Alert color="danger" role="alert" mb="sm">{saveError}</Alert>}
        <SegmentedControl
          aria-label="Appearance scope"
          value={scope}
          onChange={setScope}
          disabled={saving}
          fullWidth
          mb="sm"
          data={[
            { value: "project", label: "This project", disabled: !projectHash },
            { value: "global", label: "Global defaults" },
          ]}
        />
        <p style={{ color: "var(--muted)", fontSize: 12 }}>
          {scope === "project" ? "Project colors override your global defaults. Reset to inherit your defaults again." : "Default colors for all projects. Existing project overrides take priority."}
        </p>
        <section
          style={{
            paddingBottom: 16,
            marginBottom: 16,
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
        {/* Panel surfaces                                                    */}
        {/*                                                                   */}
        {/* Named "Shell accent" until it was noticed the override drives     */}
        {/* --surface/--surface-warm/--editor-bg, not an accent — so it sat   */}
        {/* next to "App shell" showing the same eight background swatches    */}
        {/* under a label that promised a different kind of colour.           */}
        {/* ---------------------------------------------------------------- */}

        <section
          style={{
            paddingBottom: 16,
            marginBottom: 16,
            borderBottom: `1px solid ${borderSubtle}`,
          }}
        >
          <div style={sectionLabel}>Panel &amp; editor surface</div>

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
            paddingBottom: 16,
            marginBottom: 16,
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
            paddingBottom: 16,
            marginBottom: 16,
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
            paddingBottom: 16,
            marginBottom: 16,
            borderBottom: `1px solid ${borderSubtle}`,
          }}
        >
          <Button
            size="xs"
            variant="default"
            onClick={resetAppearance}
            loading={saving}
            data-testid="reset-appearance-button"
            fullWidth
          >
            {scope === "project" ? "Reset to global defaults" : "Reset to built-in colors"}
          </Button>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Editor font                                                       */}
        {/* ---------------------------------------------------------------- */}

        <section
          style={{
            paddingBottom: 16,
            marginBottom: 16,
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
            <Select
              id="editorFontSelect"
              flex={1}
              allowDeselect={false}
              value={editorFont}
              onChange={(value) => value && setEditorFont(value)}
              data={FONT_PRESETS.map((preset) => ({
                value: preset.value,
                label: preset.name,
              }))}
              aria-label="Editor font"
              data-testid="editor-font-select"
            />

            <NumberInput
              id="editorFontSize"
              w={96}
              min={MIN_FONT_SIZE}
              max={MAX_FONT_SIZE}
              clampBehavior="strict"
              suffix=" px"
              value={editorFontSize}
              aria-label="Editor font size"
              onChange={(value) => setEditorFontSize(Number(value))}
              data-testid="editor-font-size-input"
            />


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
            paddingBottom: 16,
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

          <Switch
            checked={editorWrap}
            onChange={(event) => setEditorWrap(event.currentTarget.checked)}
            data-testid="editor-wrap-toggle"
            aria-label="Wrap long lines"
          />
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* AI completion                                                      */}
        {/* ---------------------------------------------------------------- */}

        <section
          style={{
            paddingBottom: 16,
            marginBottom: 16,
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
              {/* The bundled local model, named as Palisade ships it. The .gguf
                  on disk keeps its upstream Qwen filename so the base model
                  stays traceable — this is the product-facing name only. */}
              <div style={{ marginTop: 3, color: dim, fontSize: 11 }}>
                Model: palisade-flash-v1 (runs locally, nothing leaves the
                machine)
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
          <Select
            id="completion-keybinding-select"
            w="100%"
            allowDeselect={false}
            value={completionKeybinding}
            onChange={(value) => value && handleCompletionKeybinding(value)}
            disabled={!completionEnabled}
            data={[
              { value: "Alt-Tab", label: "Option / Alt + Tab" },
              { value: "Tab", label: "Tab" },
            ]}
            aria-label="Accept suggestion keybinding"
            data-testid="completion-keybinding-select"
          />
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* Project settings                                                   */}
        {/* ---------------------------------------------------------------- */}

        {/* Agent and model are per thread, chosen in the composer — a
            first-run reviewer opened Settings looking for them and found
            only colours and fonts. Say where they live rather than making
            them look missing. */}
        <p
          style={{ margin: "0 0 10px", fontSize: 12, color: "var(--muted)" }}
          data-testid="settings-agent-note"
        >
          Looking for the agent or model? Those are per conversation — pick
          them in the composer at the bottom of the chat.
        </p>

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
            fontFamily: "var(--mono)",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Edit .palisade/project-settings.json
          <span style={{ fontSize: 13 }}>→</span>
        </button>

        {/* ---------------------------------------------------------------- */}
        {/* Footer                                                             */}
        {/* ---------------------------------------------------------------- */}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginTop: 16,
            color: dim,
            fontFamily: "var(--mono)",
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
