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
