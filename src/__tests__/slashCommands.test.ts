import { describe, expect, it } from "vitest";
import {
  slashQuery,
  matchCommands,
  commandTrigger,
  chainCommands,
  isChainCommand,
  parseChainInvocation,
} from "../slashCommands";
import type { AgentCommand, Chain } from "../api";

const cmds: AgentCommand[] = [
  { name: "review", description: "Review code changes for bugs" },
  { name: "propose", description: "Propose a change" },
  { name: "ponytail:ponytail-audit", description: "Audit for over-engineering" },
];

describe("slashQuery", () => {
  it("opens on a leading slash and reports the typed query", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/rev")).toBe("rev");
  });

  it("stays closed when there is no leading slash", () => {
    // Mid-sentence slashes are paths and dates, not commands.
    expect(slashQuery("")).toBeNull();
    expect(slashQuery("look at src/api.ts")).toBeNull();
    expect(slashQuery("fix /review")).toBeNull();
  });

  it("closes once the command is complete and arguments start", () => {
    // ACP sends the whole line as the prompt, so everything after the first
    // space is the command's input — the menu has nothing left to offer.
    expect(slashQuery("/review src/api.ts")).toBeNull();
    expect(slashQuery("/review ")).toBeNull();
  });

  it("ignores leading whitespace rather than treating it as prose", () => {
    expect(slashQuery("  /rev")).toBe("rev");
  });
});

describe("matchCommands", () => {
  it("returns everything for an empty query, in the agent's own order", () => {
    expect(matchCommands(cmds, "").map((c) => c.name)).toEqual([
      "review",
      "propose",
      "ponytail:ponytail-audit",
    ]);
  });

  it("matches on name", () => {
    expect(matchCommands(cmds, "rev").map((c) => c.name)).toEqual(["review"]);
  });

  it("matches namespaced plugin commands by their bare name", () => {
    expect(matchCommands(cmds, "audit").map((c) => c.name)).toEqual([
      "ponytail:ponytail-audit",
    ]);
  });

  it("falls back to the description so a half-remembered command is findable", () => {
    expect(matchCommands(cmds, "over-engineering").map((c) => c.name)).toEqual([
      "ponytail:ponytail-audit",
    ]);
  });

  it("ranks a name hit above a description-only hit", () => {
    // "review" is a name here and appears in its own description; the point
    // is that a command whose *name* matches never sorts below one that only
    // mentions the word in prose.
    const withProse: AgentCommand[] = [
      { name: "lint", description: "Runs review checks" },
      { name: "review", description: "Look at the diff" },
    ];
    expect(matchCommands(withProse, "review")[0].name).toBe("review");
  });

  it("returns nothing when nothing matches", () => {
    expect(matchCommands(cmds, "zzzz")).toEqual([]);
  });
});

// Agents disagree on the sigil. Verified by probe: claude-agent-acp 0.69.0
// advertises bare names ("review", "ponytail:ponytail-audit"); codex-acp 1.4.0
// prefixes its skills with "$" ("$tdd", "$skill-creator") and carries that
// character inside the advertised name.
describe("agent sigils", () => {
  it("opens the menu on either sigil", () => {
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("$td")).toBe("td");
    expect(slashQuery("$")).toBe("");
  });

  it("still ignores a sigil that is not leading", () => {
    expect(slashQuery("costs $5")).toBeNull();
    expect(slashQuery("$tdd now")).toBeNull();
  });

  it("finds a sigil-named command whichever sigil was typed", () => {
    const codex: AgentCommand[] = [{ name: "$tdd", description: "Test first" }];
    // The user should not have to know that the "$" is part of the name.
    expect(matchCommands(codex, "tdd")).toHaveLength(1);
    expect(matchCommands(codex, "$tdd")).toHaveLength(1);
  });

  it("invokes a bare name with a slash", () => {
    expect(commandTrigger({ name: "review", description: "" })).toBe("/review ");
  });

  it("invokes a sigil name verbatim rather than double-prefixing it", () => {
    // "/$tdd" is not a command Codex knows.
    expect(commandTrigger({ name: "$tdd", description: "" })).toBe("$tdd ");
  });
});

// `|=` is Palisade's own sigil for saved agent chains (D6/D13/D14). It is two
// characters, which is what forced sigil matching to be length-aware.
const chain = (name: string, extra: Partial<Chain> = {}): Chain => ({
  name,
  nodes: {
    designer: { role: "designer", guideline: "", agent: "gemini-cli" },
    programmer: { role: "programmer", guideline: "", agent: "claude-code" },
  },
  edges: [{ from: "designer", to: "programmer" }],
  entry: "designer",
  timeoutSeconds: 1800,
  retry: { maxAttempts: 2 },
  ...extra,
});

describe("the chain sigil", () => {
  it("opens the menu on a leading `|=` and closes on the first space", () => {
    expect(slashQuery("|=des")).toBe("des");
    expect(slashQuery("|=")).toBe("");
    expect(slashQuery("|=design-loop build a page")).toBeNull();
  });

  it("does not open on a bare pipe or a mid-sentence one", () => {
    expect(slashQuery("| = something")).toBeNull();
    expect(slashQuery("a || b")).toBeNull();
    expect(slashQuery("run it |=design-loop")).toBeNull();
  });

  it("reads `|=` as one sigil rather than slicing a single character", () => {
    // slice(1) would have left "=des" and matched nothing.
    expect(slashQuery("|=des")).not.toBe("=des");
  });

  it("finds a chain by name without the user typing the sigil", () => {
    const rows = chainCommands([chain("ship-it"), chain("design-loop")]);
    // Both rows mention "designer" in their summary, so both match — but a
    // name hit outranks a description hit, so the named one comes first.
    expect(matchCommands(rows, "design")[0].name).toBe("|=design-loop");
    expect(matchCommands(rows, "|=design")[0].name).toBe("|=design-loop");
  });

  it("summarises a chain by the roles it walks, in order", () => {
    expect(chainCommands([chain("design-loop")])[0].description).toBe(
      "designer → programmer"
    );
  });

  it("summarises a looping chain without walking forever", () => {
    const looping = chain("design-loop", {
      edges: [
        { from: "designer", to: "programmer" },
        {
          from: "programmer",
          to: "designer",
          gate: { type: "approval" },
          maxIterations: 3,
        },
      ],
    });
    expect(chainCommands([looping])[0].description).toBe("designer → programmer");
  });

  it("invokes a chain row verbatim, keeping its own sigil", () => {
    const [row] = chainCommands([chain("design-loop")]);
    expect(commandTrigger(row)).toBe("|=design-loop ");
  });

  it("tells a chain row apart from an agent command", () => {
    expect(isChainCommand(chainCommands([chain("x")])[0])).toBe(true);
    expect(isChainCommand({ name: "review", description: "" })).toBe(false);
    expect(isChainCommand({ name: "$tdd", description: "" })).toBe(false);
  });

  it("merges chains alongside agent commands in one menu", () => {
    const merged = [...cmds, ...chainCommands([chain("review-loop")])];
    const hits = matchCommands(merged, "review");
    expect(hits.map((h) => h.name)).toContain("review");
    expect(hits.map((h) => h.name)).toContain("|=review-loop");
  });
});

describe("parsing a chain invocation", () => {
  it("takes the first token as the name and the rest as the seed", () => {
    expect(parseChainInvocation("|=design-loop build a settings page")).toEqual({
      name: "design-loop",
      seed: "build a settings page",
    });
  });

  it("accepts a bare invocation with an empty seed", () => {
    expect(parseChainInvocation("|=design-loop")).toEqual({
      name: "design-loop",
      seed: "",
    });
  });

  it("treats the trailing space the menu leaves as an empty seed", () => {
    expect(parseChainInvocation("|=design-loop ")).toEqual({
      name: "design-loop",
      seed: "",
    });
  });

  it("keeps the seed's own internal spacing but trims its edges", () => {
    expect(parseChainInvocation("|=x   two   words  ")?.seed).toBe("two   words");
  });

  it("is null for anything that is not a chain invocation", () => {
    expect(parseChainInvocation("/review")).toBeNull();
    expect(parseChainInvocation("just a message")).toBeNull();
    // A bare sigil is an unfinished draft, not an invocation of nothing.
    expect(parseChainInvocation("|=")).toBeNull();
    expect(parseChainInvocation("|= design-loop")).toBeNull();
  });
});

describe("parseChainInvocation with known chain names", () => {
  const known = ["QA basic chain", "QA basic chain extra", "solo"];

  it("matches a multi-word chain name instead of splitting on the first space", () => {
    expect(
      parseChainInvocation("|=QA basic chain summarize the diff", known)
    ).toEqual({ name: "QA basic chain", seed: "summarize the diff" });
  });

  it("prefers the longest matching name", () => {
    expect(parseChainInvocation("|=QA basic chain extra go", known)).toEqual({
      name: "QA basic chain extra",
      seed: "go",
    });
  });

  it("runs a bare multi-word invocation with an empty seed", () => {
    expect(parseChainInvocation("|=QA basic chain", known)).toEqual({
      name: "QA basic chain",
      seed: "",
    });
  });

  it("does not match a name that is only a prefix of the typed word", () => {
    expect(parseChainInvocation("|=soloist go", known)).toEqual({
      name: "soloist",
      seed: "go",
    });
  });

  it("falls back to the first token when nothing is known", () => {
    expect(parseChainInvocation("|=QA basic chain go", [])).toEqual({
      name: "QA",
      seed: "basic chain go",
    });
  });
});
