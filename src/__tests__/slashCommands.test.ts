import { describe, expect, it } from "vitest";
import { slashQuery, matchCommands, commandTrigger } from "../slashCommands";
import type { AgentCommand } from "../api";

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
