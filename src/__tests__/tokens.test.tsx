import { describe, expect, it } from "vitest";
import "../App.css";

/**
 * Slice 1 — RED: CSS token system
 *
 * These tests verify that the :root custom properties match the
 * merged-design.json tokens. They read computed styles from a minimal
 * DOM element after importing the stylesheet.
 */

/** All CSSStyleRules across stylesheets, including those nested inside
 * @media blocks (returned with their parent selector context preserved —
 * a rule inside `@media (prefers-color-scheme: light)` still has its own
 * `selectorText`, e.g. `:root:not([data-theme])`). */
function allStyleRules(): CSSStyleRule[] {
  const walk = (rules: CSSRule[]): CSSStyleRule[] =>
    rules.flatMap((r) => {
      if (r instanceof CSSStyleRule) return [r];
      if (r instanceof CSSMediaRule) return walk([...r.cssRules]);
      return [];
    });
  return [...document.styleSheets].flatMap((s) => {
    try {
      return walk([...s.cssRules]);
    } catch {
      return [];
    }
  });
}

/** Read a :root custom property from the stylesheet's specified value. */
function rootVar(name: string): string {
  const rootRule = allStyleRules().find((r) => r.selectorText === ":root");
  if (!rootRule) return "";
  return rootRule.style.getPropertyValue(name).trim();
}

/** Read a custom property from a specific selector's rule (e.g.
 * `:root[data-theme="light"]` or `:root:not([data-theme])`). Returns "" if
 * no rule with that exact selector declares the property. */
function varInSelector(selectorText: string, name: string): string {
  const rule = allStyleRules().find((r) => r.selectorText === selectorText);
  if (!rule) return "";
  return rule.style.getPropertyValue(name).trim();
}

describe("CSS token system (merged-design.json)", () => {
  // CSS parser normalizes whitespace in oklch(); use regex to match loosely.
  // The hue component may be a literal (most tokens) or `var(--accent-hue,
  // <literal>)` (the accent-derived tokens, swappable via the color-scheme
  // picker) — either form with the same literal hue satisfies the check.
  // Chroma is matched by value, not spelling: Prettier drops trailing zeros
  // (`0.020` -> `0.02`), which CSS treats as the same number.
  const ok = (name: string, l: string, c: string, h: string) => {
    const val = rootVar(name);
    const cEsc = c.replace(/0+$/, "").replace(/\./g, "\\.") + "0*";
    const hueEsc = `(?:${h}|var\\(--accent-hue,\\s*${h}\\))`;
    expect(val).toMatch(new RegExp(`oklch\\(${l}%\\s*${cEsc}\\s+${hueEsc}\\)`));
  };

  it("has the accent token set to Dragon Fire Green", () =>
    ok("--accent", "88", "0.21", "145"));
  it("has the chrome-bg token wrapped in the app-shell dark override fallback", () => {
    const val = rootVar("--chrome-bg");
    expect(val).toMatch(
      /var\(--app-shell-dark-override,\s*oklch\(15%\s*0\.0040*\s+250\)\)/
    );
  });
  it("has the new editor-bg token", () =>
    ok("--editor-bg", "20", "0.005", "250"));
  it("has the new backdrop token", () =>
    ok("--backdrop", "11", "0.015", "145"));
  it("has the new active-row token", () =>
    ok("--active-row", "24", "0.020", "145"));
  it("has the twilight-glow token", () =>
    ok("--twilight-glow", "18", "0.03", "145"));
  it("has the success token", () => ok("--success", "72", "0.15", "160"));
  it("has the warn token", () => ok("--warn", "76", "0.15", "65"));
  it("has the danger token", () => ok("--danger", "64", "0.22", "25"));
  it("has the accent-on token", () => ok("--accent-on", "20", "0.03", "145"));
  it("has the surface-warm token", () =>
    ok("--surface-warm", "26", "0.008", "250"));
  it("has the fg token", () => ok("--fg", "96", "0.003", "250"));
  it("has the muted token", () => ok("--muted", "66", "0.012", "250"));
  it("has the border token", () => ok("--border", "30", "0.010", "250"));
  it("has the bg token", () => ok("--bg", "18", "0.005", "250"));
  it("has the surface token", () => ok("--surface", "22", "0.006", "250"));

  it("sets base body font-size to 13px", () => {
    // jsdom applies body styles; verify the stylesheet rule exists
    const rules = [...document.styleSheets].flatMap((s) => {
      try {
        return [...s.cssRules];
      } catch {
        return [];
      }
    });
    const bodyRule = rules.find(
      (r) => r instanceof CSSStyleRule && r.selectorText.includes("body")
    ) as CSSStyleRule | undefined;
    expect(bodyRule).toBeDefined();
    expect(bodyRule!.style.fontSize).toBe("13px");
  });

  it("sets base body font-family to the sans stack", () => {
    const rules = [...document.styleSheets].flatMap((s) => {
      try {
        return [...s.cssRules];
      } catch {
        return [];
      }
    });
    const bodyRule = rules.find(
      (r) => r instanceof CSSStyleRule && r.selectorText.includes("body")
    ) as CSSStyleRule | undefined;
    expect(bodyRule).toBeDefined();
    expect(bodyRule!.style.fontFamily).toMatch(/system-ui/);
  });

  it("sets color-scheme to dark on :root", () => {
    const rules = [...document.styleSheets].flatMap((s) => {
      try {
        return [...s.cssRules];
      } catch {
        return [];
      }
    });
    const rootRule = rules.find(
      (r) => r instanceof CSSStyleRule && r.selectorText === ":root"
    ) as CSSStyleRule | undefined;
    expect(rootRule).toBeDefined();
    expect(rootRule!.style.colorScheme).toBe("dark");
  });
});

describe("Appearance override tokens (app shell / shell accent / code colors)", () => {
  // The shell is split into two concepts:
  // - app shell: outer black frame / chrome / backdrop (`--chrome-bg`, `--bg`, `--backdrop`)
  // - shell accent: raised inner panels like the editor surface (`--editor-bg`, `--surface`, `--surface-warm`)
  // Each theme block must wrap those vars in override fallbacks so applyAppearance()
  // can switch them independently from JS without rewriting CSS.
  const okOverride = (
    selector: string,
    name: string,
    overrideKey: string,
    l: string,
    c: string,
    h: string
  ) => {
    const val = varInSelector(selector, name);
    const cEsc = c.replace(/0+$/, "").replace(/\./g, "\\.") + "0*";
    expect(val).toMatch(
      new RegExp(
        `var\\(--${overrideKey},\\s*oklch\\(${l}%\\s*${cEsc}\\s+${h}\\)\\)`
      )
    );
  };

  it("wraps --chrome-bg in an app-shell dark override in :root", () =>
    okOverride(
      ":root",
      "--chrome-bg",
      "app-shell-dark-override",
      "15",
      "0.004",
      "250"
    ));
  it("wraps --chrome-bg in an app-shell light override in :root:not([data-theme])", () =>
    okOverride(
      ":root:not([data-theme])",
      "--chrome-bg",
      "app-shell-light-override",
      "97",
      "0.004",
      "250"
    ));
  it("wraps --bg in an app-shell dark override in :root", () =>
    okOverride(
      ":root",
      "--bg",
      "app-shell-dark-override",
      "18",
      "0.005",
      "250"
    ));
  it("wraps --bg in an app-shell light override in :root:not([data-theme])", () =>
    okOverride(
      ":root:not([data-theme])",
      "--bg",
      "app-shell-light-override",
      "99",
      "0.003",
      "250"
    ));
  it("wraps --backdrop in an app-shell dark override in :root", () => {
    const val = varInSelector(":root", "--backdrop");
    expect(val).toMatch(
      /var\(--app-shell-dark-override,\s*oklch\(11%\s*0\.0150*\s+var\(--accent-hue,\s*145\)\)\)/
    );
  });

  it("wraps --editor-bg in a shell-accent dark override in :root", () =>
    okOverride(
      ":root",
      "--editor-bg",
      "shell-accent-dark-override",
      "20",
      "0.005",
      "250"
    ));
  it("wraps --surface in a shell-accent dark override in :root", () =>
    okOverride(
      ":root",
      "--surface",
      "shell-accent-dark-override",
      "22",
      "0.006",
      "250"
    ));
  it("wraps --surface-warm in a shell-accent dark override in :root", () =>
    okOverride(
      ":root",
      "--surface-warm",
      "shell-accent-dark-override",
      "26",
      "0.008",
      "250"
    ));
  it("wraps --editor-bg in a shell-accent light override in :root:not([data-theme])", () =>
    okOverride(
      ":root:not([data-theme])",
      "--editor-bg",
      "shell-accent-light-override",
      "98",
      "0.003",
      "250"
    ));

  // --code-comment defaults: dark 66% 0.012 250 (matches --muted), light 46% 0.012 250.
  it("defines --code-comment with a dark override in :root", () =>
    okOverride(
      ":root",
      "--code-comment",
      "code-comment-dark-override",
      "66",
      "0.012",
      "250"
    ));
  it("defines --code-comment with a light override in :root:not([data-theme])", () =>
    okOverride(
      ":root:not([data-theme])",
      "--code-comment",
      "code-comment-light-override",
      "46",
      "0.012",
      "250"
    ));
  it("defines --code-comment with a light override in :root[data-theme=light]", () =>
    okOverride(
      ':root[data-theme="light"]',
      "--code-comment",
      "code-comment-light-override",
      "46",
      "0.012",
      "250"
    ));

  // --code-text defaults: dark 96% 0.003 250 (matches --fg), light 20% 0.006 250.
  it("defines --code-text with a dark override in :root", () =>
    okOverride(
      ":root",
      "--code-text",
      "code-text-dark-override",
      "96",
      "0.003",
      "250"
    ));
  it("defines --code-text with a light override in :root:not([data-theme])", () =>
    okOverride(
      ":root:not([data-theme])",
      "--code-text",
      "code-text-light-override",
      "20",
      "0.006",
      "250"
    ));
  it("defines --code-text with a light override in :root[data-theme=light]", () =>
    okOverride(
      ':root[data-theme="light"]',
      "--code-text",
      "code-text-light-override",
      "20",
      "0.006",
      "250"
    ));
});

describe("Icon button sizing", () => {
  it("matches DESIGN.md's documented 32px panel-toggle icon button", () => {
    const rules = [...document.styleSheets].flatMap((s) => {
      try {
        return [...s.cssRules];
      } catch {
        return [];
      }
    });
    const rule = rules.find(
      (r) => r instanceof CSSStyleRule && r.selectorText === ".ds-icon-btn"
    ) as CSSStyleRule | undefined;
    expect(rule).toBeDefined();
    expect(rule!.style.height).toBe("32px");
  });
});

describe("Responsive breakpoints", () => {
  it("never hides the file explorer with display:none (its toggle button would go dead — it only controls margin-left)", () => {
    const allRules = [...document.styleSheets].flatMap((s) => {
      try {
        return [...s.cssRules];
      } catch {
        return [];
      }
    });
    const mediaRules = allRules.filter(
      (r): r is CSSMediaRule => r instanceof CSSMediaRule
    );
    const navRailDisplayNoneRules = mediaRules
      .flatMap((r) => [...r.cssRules])
      .filter(
        (r): r is CSSStyleRule =>
          r instanceof CSSStyleRule &&
          r.selectorText === ".ds-nav-rail" &&
          r.style.display === "none"
      );
    expect(navRailDisplayNoneRules).toHaveLength(0);
  });
});
