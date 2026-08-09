import React from "react";
import ReactDOM from "react-dom/client";
import {
  MantineProvider,
  createTheme,
  localStorageColorSchemeManager,
  type CSSVariablesResolver,
} from "@mantine/core";
import "@mantine/core/styles.css";
import App, { THEME_KEY } from "./App";

// Radius/font tokens mirror DESIGN.md's documented scale (rounded, typography).
const theme = createTheme({
  radius: { xs: "4px", sm: "6px", md: "8px", lg: "12px", xl: "9999px" },
  fontFamily:
    '"Geist Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif',
  fontFamilyMonospace:
    '"Geist Mono", "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace',
});

// Point Mantine's own CSS variables at the app's existing OKLCH tokens (App.css :root)
// instead of duplicating them as a hex palette — keeps the live accent-hue picker
// (SettingsPanel's applyAccentHue) and the data-theme light/dark cascade as the single
// source of truth; Mantine components just inherit from it.
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
  },
  light: {},
  dark: {},
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
