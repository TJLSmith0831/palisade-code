import { describe, expect, it } from "vitest";
import "../App.css";

/**
 * Slice 1 — RED: CSS token system
 *
 * These tests verify that the :root custom properties match the
 * merged-design.json tokens. They read computed styles from a minimal
 * DOM element after importing the stylesheet.
 */

/** Read a :root custom property from the stylesheet's specified value. */
function rootVar(name: string): string {
  const rules = [...document.styleSheets]
    .flatMap((s) => {
      try { return [...s.cssRules]; } catch { return []; }
    });
  const rootRule = rules.find(
    (r) => r instanceof CSSStyleRule && r.selectorText === ":root"
  ) as CSSStyleRule | undefined;
  if (!rootRule) return "";
  return rootRule.style.getPropertyValue(name).trim();
}

describe("CSS token system (merged-design.json)", () => {
  // CSS parser normalizes whitespace in oklch(); use regex to match loosely.
  // The hue component may be a literal (most tokens) or `var(--accent-hue,
  // <literal>)` (the accent-derived tokens, swappable via the color-scheme
  // picker) — either form with the same literal hue satisfies the check.
  const ok = (name: string, l: string, c: string, h: string) => {
    const val = rootVar(name);
    const cEsc = c.replace(/\./g, "\\.");
    const hueEsc = `(?:${h}|var\\(--accent-hue,\\s*${h}\\))`;
    expect(val).toMatch(new RegExp(`oklch\\(${l}%\\s*${cEsc}\\s+${hueEsc}\\)`));
  };

  it("has the accent token set to Dragon Fire Green", () => ok("--accent", "88", "0.21", "145"));
  it("has the new chrome-bg token", () => ok("--chrome-bg", "15", "0.004", "250"));
  it("has the new editor-bg token", () => ok("--editor-bg", "20", "0.005", "250"));
  it("has the new backdrop token", () => ok("--backdrop", "11", "0.015", "145"));
  it("has the new active-row token", () => ok("--active-row", "24", "0.020", "145"));
  it("has the twilight-glow token", () => ok("--twilight-glow", "18", "0.03", "145"));
  it("has the success token", () => ok("--success", "72", "0.15", "160"));
  it("has the warn token", () => ok("--warn", "76", "0.15", "65"));
  it("has the danger token", () => ok("--danger", "64", "0.22", "25"));
  it("has the accent-on token", () => ok("--accent-on", "20", "0.03", "145"));
  it("has the surface-warm token", () => ok("--surface-warm", "26", "0.008", "250"));
  it("has the fg token", () => ok("--fg", "96", "0.003", "250"));
  it("has the muted token", () => ok("--muted", "66", "0.012", "250"));
  it("has the border token", () => ok("--border", "30", "0.010", "250"));
  it("has the bg token", () => ok("--bg", "18", "0.005", "250"));
  it("has the surface token", () => ok("--surface", "22", "0.006", "250"));

  it("sets base body font-size to 13px", () => {
    // jsdom applies body styles; verify the stylesheet rule exists
    const rules = [...document.styleSheets]
      .flatMap((s) => {
        try { return [...s.cssRules]; } catch { return []; }
      });
    const bodyRule = rules.find(
      (r) => r instanceof CSSStyleRule && r.selectorText.includes("body")
    ) as CSSStyleRule | undefined;
    expect(bodyRule).toBeDefined();
    expect(bodyRule!.style.fontSize).toBe("13px");
  });

  it("sets base body font-family to the sans stack", () => {
    const rules = [...document.styleSheets]
      .flatMap((s) => {
        try { return [...s.cssRules]; } catch { return []; }
      });
    const bodyRule = rules.find(
      (r) => r instanceof CSSStyleRule && r.selectorText.includes("body")
    ) as CSSStyleRule | undefined;
    expect(bodyRule).toBeDefined();
    expect(bodyRule!.style.fontFamily).toMatch(/system-ui/);
  });

  it("sets color-scheme to dark on :root", () => {
    const rules = [...document.styleSheets]
      .flatMap((s) => {
        try { return [...s.cssRules]; } catch { return []; }
      });
    const rootRule = rules.find(
      (r) => r instanceof CSSStyleRule && r.selectorText === ":root"
    ) as CSSStyleRule | undefined;
    expect(rootRule).toBeDefined();
    expect(rootRule!.style.colorScheme).toBe("dark");
  });
});
