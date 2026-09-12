import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const css = readFileSync(resolve(root, "src/App.css"), "utf8");

/**
 * The three blocks that define the theme. Anything elevation-shaped has to be
 * declared in all three, or one theme inherits the other's value silently —
 * which is exactly how `--scrim` shipped as 68% black on a near-white ground.
 */
const THEME_BLOCKS = [
  { name: ":root (dark)", re: /^:root \{$/m },
  { name: "@media prefers-color-scheme: light", re: /^ {2}:root:not\(\[data-theme\]\) \{$/m },
  { name: ':root[data-theme="light"]', re: /^:root\[data-theme="light"\] \{$/m },
];

/** The body of the theme block whose opening selector `re` matches. */
const blockBody = (re: RegExp): string => {
  const at = css.search(re);
  expect(at, `theme block ${re} not found in App.css`).toBeGreaterThan(-1);
  const from = css.indexOf("{", at);
  let depth = 0;
  for (let i = from; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(from, i);
    }
  }
  throw new Error(`unterminated theme block ${re}`);
};

const ELEVATION_TOKENS = [
  "--scrim",
  "--shadow-float",
  "--shadow-lift",
  "--shadow-overlay",
  "--shadow-keycap",
];

describe("elevation is tokenised, and the tokens flip with the theme", () => {
  // `--scrim` was defined once, in the dark `:root`, and never redefined in
  // either light block — so light mode dimmed its modals with 68% black. Six
  // box-shadows and four inline TSX shadows had the same bug in a quieter
  // form: hardcoded black, at an alpha tuned for a dark ground.
  it.each(ELEVATION_TOKENS)("%s is declared in every theme block", (token) => {
    for (const { name, re } of THEME_BLOCKS) {
      expect(blockBody(re), `${token} missing from ${name}`).toContain(`${token}:`);
    }
  });

  it("the light blocks do not merely repeat the dark values", () => {
    const dark = blockBody(THEME_BLOCKS[0].re);
    const light = blockBody(THEME_BLOCKS[1].re);
    for (const token of ELEVATION_TOKENS) {
      const pick = (body: string) =>
        body.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1].trim();
      expect(pick(light), `${token} is the same in light and dark`).not.toBe(pick(dark));
    }
  });

  it("no rule spells a shadow or scrim as raw black", () => {
    const offenders = css
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(
        ([, line]) =>
          /rgba\(\s*0\s*,\s*0\s*,\s*0/.test(line) &&
          // The token definitions themselves are the one place black is spelled.
          !ELEVATION_TOKENS.some((t) => line.includes(`${t}:`))
      )
      .map(([n, line]) => `App.css:${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  it("no component spells a shadow inline", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(resolve(root, "src"))) {
      // icons.tsx is third-party language brand artwork, intentional per its
      // own comment at icons.tsx:53-56.
      if (!/\.tsx?$/.test(file) || file === "icons.tsx") continue;
      const body = readFileSync(resolve(root, "src", file), "utf8");
      body.split("\n").forEach((line, i) => {
        if (/rgba\(\s*0\s*,\s*0\s*,\s*0/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("the app's own chrome is painted from tokens, not literals", () => {
  // SettingsPanel.tsx:647 held `color: "#9ca3ab"` — the only non-theme hex in
  // the app's own chrome, and the one the bundled detector kept flagging.
  //
  // Scoped deliberately to hexes in a *style property* position. The app has
  // three legitimate hex tables that are data, not chrome, and banning those
  // would be wrong: icons.tsx's language brand colours (intentional per
  // icons.tsx:53-56), SettingsPanel's user-pickable appearance palette, and
  // GraphView's node-category colours. None of them theme; all of them are
  // chosen values a user or a language owns.
  const STYLE_HEX = /\b(color|background|backgroundColor|border|borderColor|outline|fill|stroke|boxShadow)\s*:\s*"#[0-9a-fA-F]{3,8}"/;

  /** Literals that are correct, each for a reason that is not "we forgot". */
  const JUSTIFIED: Record<string, RegExp> = {
    // Language brand colours, keyed by extension. Not ours to theme.
    "icons.tsx": /.*/,
    // The dev-server preview iframe. It hosts an arbitrary web page, which
    // expects a white canvas under it; tinting that to --bg would recolour
    // the user's own site rather than the app's chrome.
    "PreviewPane.tsx": /background: "#fff"/,
  };

  it("no component hardcodes a hex in a style property", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(resolve(root, "src"))) {
      if (!/\.tsx?$/.test(file)) continue;
      const allowed = JUSTIFIED[file];
      readFileSync(resolve(root, "src", file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (!STYLE_HEX.test(line)) return;
          if (allowed?.test(line)) return;
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe("accent presets clear the hues the semantics own", () => {
  // ACCENT_PRESETS shipped Red at hue 25 — identical to --danger — so picking
  // it made Agent Signal indistinguishable from Danger. Orange at 55 sat ten
  // degrees off --warn. See DESIGN.md, "The Reserved Hue Rule", for why the
  // fix is hue rather than lightness.
  const settings = readFileSync(resolve(root, "src/SettingsPanel.tsx"), "utf8");

  /** `--danger: oklch(L% C H)` etc., read from the dark :root. */
  const semanticHue = (token: string): number => {
    const m = css.match(new RegExp(`${token}: oklch\\([\\d.]+% [\\d.]+ (\\d+)\\)`));
    expect(m, `${token} not found in App.css`).not.toBeNull();
    return Number(m![1]);
  };

  const presets = [...settings.matchAll(/\{ name: "([^"]+)", hue: (\d+) \}/g)].map(
    (m) => ({ name: m[1], hue: Number(m[2]) })
  );

  /** Shortest distance between two hue angles, in degrees. */
  const apart = (a: number, b: number) => {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  };

  // Dragon Green is the product's identity colour and --success draws only as
  // a thin chain-node border, never as a fill beside an accent fill. Stated in
  // DESIGN.md as a knowing exception, not an oversight.
  const GRANDFATHERED = new Set(["Dragon Green"]);

  it("reads the eight presets and the three semantic hues", () => {
    expect(presets).toHaveLength(8);
    expect([semanticHue("--danger"), semanticHue("--warn"), semanticHue("--success")]).toEqual([
      25, 65, 160,
    ]);
  });

  it("keeps every selectable accent at least 30 degrees off every semantic", () => {
    const semantics = {
      "--danger": semanticHue("--danger"),
      "--warn": semanticHue("--warn"),
      "--success": semanticHue("--success"),
    };
    const collisions: string[] = [];
    for (const preset of presets) {
      if (GRANDFATHERED.has(preset.name)) continue;
      for (const [token, hue] of Object.entries(semantics)) {
        const gap = apart(preset.hue, hue);
        if (gap < 30) collisions.push(`${preset.name} (${preset.hue}) is ${gap}° from ${token}`);
      }
    }
    expect(collisions).toEqual([]);
  });
});

describe("type and radius stay on the declared scales", () => {
  const design = readFileSync(resolve(root, "DESIGN.md"), "utf8");

  /** Every `fontSize: "Npx"` DESIGN.md's front matter declares. */
  const RAMP = new Set(
    [...design.matchAll(/fontSize: "(\d+)px"/g)].map((m) => Number(m[1]))
  );
  /** Mantine's radius remap in main.tsx is the shape scale, verbatim. */
  const RADII = new Set([4, 6, 8, 12, 9999]);

  it("DESIGN.md still declares the ramp this test measures against", () => {
    expect([...RAMP].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 16, 21]);
  });

  it("no rule in App.css sets an off-ramp font-size", () => {
    const offenders = css
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => {
        const m = line.match(/font-size:\s*([\d.]+)px/);
        return m !== null && !RAMP.has(Number(m[1]));
      })
      .map(([n, line]) => `App.css:${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  it("no rule in App.css sets an off-scale border-radius", () => {
    const offenders = css
      .split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => {
        const m = line.match(/border-radius:\s*([^;]+);/);
        if (!m || m[1].includes("var(") || m[1].includes("%")) return false;
        return m[1]
          .split(/\s+/)
          .some((part) => /^[\d.]+px$/.test(part) && !RADII.has(Number(part.slice(0, -2))));
      })
      .map(([n, line]) => `App.css:${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  it("no component sets an off-ramp fontSize inline", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(resolve(root, "src"))) {
      if (!/\.tsx?$/.test(file)) continue;
      readFileSync(resolve(root, "src", file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = line.match(/fontSize:\s*"?([\d.]+)(?:px)?"?[,\s}]/);
          if (m && !RAMP.has(Number(m[1]))) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
