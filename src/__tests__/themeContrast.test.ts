import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/App.css"), "utf8");
const main = readFileSync(resolve(process.cwd(), "src/main.tsx"), "utf8");

/** Every `--name: oklch(L% ...)` declaration in App.css, in file order. */
const lightnessOf = (token: string): number[] =>
  [...css.matchAll(new RegExp(`${token}:\\s*oklch\\((\\d+(?:\\.\\d+)?)%`, "g"))].map(
    (m) => Number(m[1])
  );

describe("the shell's palette actually reaches Mantine", () => {
  // Measured in the running app: all fourteen tokens the resolver overrode
  // were still Mantine's stock values. `variables` is emitted into a plain
  // `:root`, and Mantine injects its own `:root` defaults at runtime, which
  // land later and win at equal specificity. The scheme buckets are emitted
  // under a scheme-scoped selector, which outranks it. Menus drew #2e2e2e
  // instead of --surface, disabled text drew #696969 at 2.5:1, and links drew
  // Mantine's stock blue instead of the accent.
  it("passes the shell tokens through the light and dark buckets, not only variables", () => {
    expect(main).toMatch(/light:\s*shellTokens/);
    expect(main).toMatch(/dark:\s*shellTokens/);
    for (const token of [
      "--mantine-color-default",
      "--mantine-color-disabled-color",
      "--mantine-color-anchor",
      "--mantine-primary-color-contrast",
    ]) {
      expect(main).toContain(`"${token}"`);
    }
  });

  // Mantine decides a filled control's text color while building the element
  // and writes it as an inline CSS variable no stylesheet can outrank. It
  // computes that from the fill's luminance, which it cannot measure when the
  // fill is `var(--accent)` — so it fell back to white, and every filled
  // primary control drew white on light green at about 1.4:1.
  it("answers filled-variant ink through the variant colors resolver", () => {
    expect(main).toMatch(/variantColorResolver/);
    expect(main).toMatch(/color:\s*"var\(--accent-on\)"/);
  });

  it("keeps --accent and --accent-on far enough apart to read", () => {
    // The accent fill's lightness moved into --accent-l when --accent was
    // derived from it, so the settings swatches could preview the real
    // colour. Same number, one indirection further out.
    const accent = [...css.matchAll(/--accent-l:\s*(\d+(?:\.\d+)?)%/g)].map((m) =>
      Number(m[1])
    );
    const ink = lightnessOf("--accent-on");
    expect(accent.length).toBeGreaterThan(0);
    expect(ink.length).toBe(accent.length);
    // Each themed pair, not just the first: a light fill takes dark ink and a
    // dark fill takes light ink, and 40 points of lightness is the floor.
    accent.forEach((fill, i) => {
      expect(Math.abs(fill - ink[i])).toBeGreaterThanOrEqual(40);
    });
  });
});
