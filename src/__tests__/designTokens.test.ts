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

describe("the mode cards do not fight their own pointer handler", () => {
  // App.tsx's mousemove handler writes card.style.transform every frame —
  // perspective + tilt + the same translateY(-2px) — so the CSS :hover
  // transform never survived to paint. The 3D tilt and glow are deliberate
  // and stay; only the dead CSS rule is scoped away, to :focus-visible,
  // where no pointer handler runs and the lift is the whole effect.

  it("leaves transform to the pointer handler on hover", () => {
    const shared = css.match(
      /\.ds-mode-card:hover,\n\.ds-mode-card:focus-visible \{([^}]*)\}/
    );
    expect(shared, "the shared hover/focus rule is gone").not.toBeNull();
    expect(shared![1]).not.toContain("transform:");
  });

  it("still lifts the card for keyboard focus", () => {
    expect(css).toMatch(
      /\n\.ds-mode-card:focus-visible \{\n {2}transform: translateY\(-2px\);\n\}/
    );
  });

  it("keeps the tilt the pointer handler draws", () => {
    const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
    expect(app).toContain("perspective(1000px) rotateX(");
  });
});

describe("every var() the app reads names a token the app defines", () => {
  // --fg-dim was read with no fallback, so the rule painted nothing at all;
  // --warning and --hover-bg were read with a hardcoded colour as the
  // fallback, so six rules across App.css, breakpointGutter.ts and
  // testGutter.ts had been quietly bypassing the theme since they were
  // written. None of the three was ever declared anywhere.
  //
  // Scoped to var()s with no fallback, which is where an undeclared token is
  // unambiguously a bug. A var() that does carry a fallback still cannot
  // smuggle in an off-theme colour — the raw-black and hex rules above catch
  // that — and a few tokens are deliberately reserved with a fallback
  // standing in until something publishes them (--label-offset on a
  // CodeMirror label row, --vibe-chat-w on the chat pane).
  const DEFINED = new Set(
    [...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1])
  );

  /** Tokens written at runtime by a component rather than declared in CSS. */
  const RUNTIME = new Set<string>();
  const walk = (dir: string, visit: (file: string, body: string) => void) => {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "__tests__") {
        walk(`${dir}/${entry.name}`, visit);
      } else if (/\.tsx?$/.test(entry.name)) {
        visit(entry.name, readFileSync(resolve(root, dir, entry.name), "utf8"));
      }
    }
  };
  // `setProperty("--x", …)` and inline `style={{ "--x": … }}` alike.
  walk("src", (_f, body) => {
    for (const m of body.matchAll(/"(--[a-z0-9-]+)"\s*[,:)]/g)) RUNTIME.add(m[1]);
  });

  /** `var(--x)` with nothing after the name — no fallback to fall back on. */
  const BARE = /var\((--[a-z0-9-]+)\s*\)/g;
  const undeclared = (name: string) =>
    !name.startsWith("--mantine-") && !RUNTIME.has(name) && !DEFINED.has(name);

  it("App.css reads no undeclared token without a fallback", () => {
    const missing = new Set(
      [...css.matchAll(BARE)].map((m) => m[1]).filter(undeclared)
    );
    expect([...missing]).toEqual([]);
  });

  it("no component reads an undeclared token without a fallback", () => {
    const missing = new Set<string>();
    walk("src", (file, body) => {
      for (const m of body.matchAll(BARE)) {
        if (undeclared(m[1])) missing.add(`${file}: ${m[1]}`);
      }
    });
    expect([...missing]).toEqual([]);
  });
});

describe("status colour goes through the theme, not Mantine's stock ramps", () => {
  // main.tsx registers success/danger/warn/neutral against App.css's tokens
  // and remaps Mantine's blue onto the accent — but never red, green, yellow,
  // teal, orange or gray. 67 call sites used those stock names anyway, so
  // "passed" was stock green in one panel and --success in another, and 41%
  // of the app's status colour ignored the accent picker and carried
  // Mantine's own light/dark curve instead of Palisade's.
  //
  // This is the lint rule: there is no eslint in this repo, and design
  // invariants are enforced here alongside the rest of them.
  const STOCK = [
    "red", "green", "yellow", "teal", "orange", "gray",
    "grape", "lime", "pink", "cyan", "indigo", "violet",
  ];
  /** A stock name in a colour-prop or colour-field position. */
  const STOCK_COLOR = new RegExp(
    String.raw`(\b(?:color|c)\s*=\s*\{?"|\bcolor:\s*"|\?\s*"|:\s*")(${STOCK.join("|")})"`
  );

  it("no component names a stock Mantine colour", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(resolve(root, "src"))) {
      if (!/\.tsx$/.test(file)) continue;
      readFileSync(resolve(root, "src", file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (STOCK_COLOR.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  it("the rule would catch a reintroduced one", () => {
    expect(STOCK_COLOR.test('<Badge color="red">failed</Badge>')).toBe(true);
    expect(STOCK_COLOR.test('<Text c="teal">+3</Text>')).toBe(true);
    expect(STOCK_COLOR.test('color={ok ? "green" : "red"}')).toBe(true);
    expect(STOCK_COLOR.test('  passed: "green",')).toBe(true);
    // blue is deliberately exempt: main.tsx remaps it onto the accent, so it
    // does reach the theme.
    expect(STOCK_COLOR.test('<Badge color="blue">running</Badge>')).toBe(false);
    expect(STOCK_COLOR.test('<Badge color="danger">failed</Badge>')).toBe(false);
  });

  it("registers a ramp for every name the app now uses", () => {
    const main = readFileSync(resolve(root, "src/main.tsx"), "utf8");
    for (const name of ["success", "danger", "warn", "neutral"]) {
      expect(main).toMatch(new RegExp(`${name}: statusTuple\\("--[a-z]+"\\)`));
    }
  });
});

describe("every custom interactive row can be seen to have focus", () => {
  // App.css has one :focus-visible recipe for rows that are role="button"
  // divs, since the global button/input rule never reaches them.
  // .ds-debug-frame — the call stack — was role="button" tabIndex={0} with a
  // :hover rule and no entry here, so a keyboard user moving through the call
  // stack had no idea where they were.
  const recipe = css.slice(
    css.indexOf(".ds-tree-row:focus-visible"),
    css.indexOf("}", css.indexOf(".ds-tree-row:focus-visible"))
  );

  const inRecipe = [...recipe.matchAll(/\.([a-z-]+):focus-visible/g)].map((m) => m[1]);

  it("covers every class the shell declares as a custom row", () => {
    expect(inRecipe).toContain("ds-debug-frame");
  });

  it("gives each of them an actual ring", () => {
    expect(recipe).toContain("box-shadow: 0 0 0 2px");
  });

  // A class only belongs in that recipe if something actually renders it as a
  // focusable row; otherwise the rule is decoration for an element that can
  // never receive focus.
  it("names only classes that are rendered as focusable rows", () => {
    const sources = readdirSync(resolve(root, "src"))
      .filter((f) => /\.tsx$/.test(f))
      .map((f) => readFileSync(resolve(root, "src", f), "utf8"))
      .join("\n");
    for (const cls of inRecipe) {
      expect(sources, `${cls} is in the focus recipe but nothing renders it`).toContain(cls);
    }
  });
});

describe("loading, empty and blocked do not look like each other", () => {
  // One `.empty` treatment carried three different states across twenty call
  // sites: nothing here, still loading, and can't show you this. A stalled
  // load was pixel-identical to an empty pane — "Loading…" that never
  // resolved read as "there is nothing here".
  const sources = readdirSync(resolve(root, "src"))
    .filter((f) => /\.tsx$/.test(f))
    .map((f) => [f, readFileSync(resolve(root, "src", f), "utf8")] as const);

  it("marks every loading message as a live region with a spinner", () => {
    const offenders: string[] = [];
    for (const [file, body] of sources) {
      body.split("\n").forEach((line, i) => {
        if (!/className="empty[^"]*"/.test(line)) return;
        // The message may run onto following lines; take the element's block.
        const block = body.split("\n").slice(i, i + 6).join(" ");
        if (!/Loading|Preparing/i.test(block)) return;
        if (!/role="status"/.test(block) || !/<Loader/.test(block)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("gives loading and blocked their own modifiers in the stylesheet", () => {
    expect(css).toContain(".empty.is-loading");
    expect(css).toContain(".empty.is-blocked");
    // Blocked is a condition to act on, not an absence, so it does not wear
    // the same muted voice as an empty pane.
    const blocked = css.slice(css.indexOf(".empty.is-blocked"));
    expect(blocked.slice(0, blocked.indexOf("}"))).toContain("var(--warn)");
  });
});
