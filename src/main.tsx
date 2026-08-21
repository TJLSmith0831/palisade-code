import React from "react";
import ReactDOM from "react-dom/client";
import {
  MantineProvider,
  createTheme,
  localStorageColorSchemeManager,
  type CSSVariablesResolver,
} from "@mantine/core";
import "@mantine/core/styles.css";
import App from "./App";
import { THEME_KEY } from "./hooks/useAppShell";

// DESIGN.md's three semantic status hues, registered as real Mantine colour
// keys so a component writes `color="danger"` and gets Mantine's own variant
// maths. Passing a raw `var(--danger)` string to `color` instead makes
// Mantine treat it as an unparseable custom colour: `parseThemeColor` can't
// read a channel out of an unresolved custom property, so `variant="light"`
// loses its tint and the control renders as a default grey. The ten-step
// tuple is what `MantineColorsTuple` requires; every step points at the one
// token because the shades that actually get painted are overridden in the
// resolver below, next to the accent ramp.
const statusTuple = (token: string) =>
  Array.from({ length: 10 }, () => `var(${token})`) as unknown as [
    string, string, string, string, string,
    string, string, string, string, string
  ];

// Radius/font tokens mirror DESIGN.md's documented scale (rounded, typography).
const theme = createTheme({
  radius: { xs: "4px", sm: "6px", md: "8px", lg: "12px", xl: "9999px" },
  fontFamily:
    '"Geist Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
  // Defers to App.css's `--mono` rather than restating the stack: it was one
  // of five near-identical copies that had already drifted apart, and it led
  // with a webfont the app ships no file for.
  fontFamilyMonospace: "var(--mono)",
  colors: {
    success: statusTuple("--success"),
    danger: statusTuple("--danger"),
    warn: statusTuple("--warn"),
    neutral: statusTuple("--muted"),
  },
});

// Point Mantine's own CSS variables at the app's existing OKLCH tokens (App.css :root)
// instead of duplicating them as a hex palette — keeps the live accent-hue picker
// (SettingsPanel's applyAccentHue) and the data-theme light/dark cascade as the single
// source of truth; Mantine components just inherit from it.
// `theme.primaryColor` defaults to "blue", and Mantine's variant styles
// resolve through `--mantine-color-blue-*` rather than the
// `--mantine-primary-color-*` aliases. Without these, every
// `variant="light"`/`"outline"`/`"filled"` control renders Mantine blue — a
// second brand chromatic colour, which DESIGN.md's One Accent Rule forbids.
// These must also be repeated in the light/dark blocks below: Mantine emits
// its own colour-scheme-scoped definitions, which outrank a bare `:root`.
const accentPrimaryRamp = {
  "--mantine-color-blue-filled": "var(--accent)",
  "--mantine-color-blue-filled-hover":
    "color-mix(in oklab, var(--accent), black 8%)",
  "--mantine-color-blue-light":
    "color-mix(in oklab, var(--accent), transparent 84%)",
  "--mantine-color-blue-light-hover":
    "color-mix(in oklab, var(--accent), transparent 70%)",
  "--mantine-color-blue-light-color": "var(--accent)",
  "--mantine-color-blue-outline": "var(--accent)",
  "--mantine-color-blue-outline-hover":
    "color-mix(in oklab, var(--accent), transparent 88%)",
  "--mantine-color-blue-contrast": "var(--accent-on)",
};

// The same shape as `accentPrimaryRamp`, applied to each status hue. Mantine
// emits `--mantine-color-<key>-0..9` from the tuple above; these are the
// variables its variant styles actually read, so they are the ones that have
// to carry the real token and the light-variant tint.
const statusRamp = (key: string, token: string) => ({
  [`--mantine-color-${key}-filled`]: `var(${token})`,
  [`--mantine-color-${key}-filled-hover`]: `color-mix(in oklab, var(${token}), black 8%)`,
  [`--mantine-color-${key}-light`]: `color-mix(in oklab, var(${token}), transparent 84%)`,
  [`--mantine-color-${key}-light-hover`]: `color-mix(in oklab, var(${token}), transparent 70%)`,
  [`--mantine-color-${key}-light-color`]: `var(${token})`,
  [`--mantine-color-${key}-outline`]: `var(${token})`,
  [`--mantine-color-${key}-outline-hover`]: `color-mix(in oklab, var(${token}), transparent 88%)`,
  [`--mantine-color-${key}-contrast`]: "var(--accent-on)",
});

const statusRamps = {
  ...statusRamp("success", "--success"),
  ...statusRamp("danger", "--danger"),
  ...statusRamp("warn", "--warn"),
  ...statusRamp("neutral", "--muted"),
};

const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    "--mantine-color-body": "var(--bg)",
    "--mantine-color-text": "var(--fg)",
    "--mantine-color-error": "var(--danger)",
    "--mantine-color-success": "var(--success)",
    "--mantine-color-placeholder": "var(--muted)",
    "--mantine-color-dimmed": "var(--muted)",
    "--mantine-color-anchor": "var(--accent)",
    "--mantine-color-default": "var(--surface)",
    "--mantine-color-default-hover": "var(--surface-warm)",
    "--mantine-color-default-color": "var(--fg)",
    "--mantine-color-default-border": "var(--border)",
    "--mantine-color-disabled": "var(--surface)",
    "--mantine-color-disabled-color": "var(--muted)",
    "--mantine-color-disabled-border": "var(--border)",
    "--mantine-primary-color-filled": "var(--accent)",
    "--mantine-primary-color-filled-hover": "var(--accent)",
    "--mantine-primary-color-light":
      "color-mix(in oklab, var(--accent), transparent 80%)",
    "--mantine-primary-color-light-hover":
      "color-mix(in oklab, var(--accent), transparent 65%)",
    "--mantine-primary-color-light-color": "var(--accent)",
    "--mantine-primary-color-contrast": "var(--accent-on)",
    ...accentPrimaryRamp,
    ...statusRamps,
  },
  light: { ...accentPrimaryRamp, ...statusRamps },
  dark: { ...accentPrimaryRamp, ...statusRamps },
});

// Reuses the app's own theme key/values ("auto" | "light" | "dark") so Mantine's color
// scheme and the app's data-theme attribute (set in App.tsx) read one shared value.
const colorSchemeManager = localStorageColorSchemeManager({ key: THEME_KEY });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      colorSchemeManager={colorSchemeManager}
      defaultColorScheme="auto"
    >
      <App />
    </MantineProvider>
  </React.StrictMode>
);
