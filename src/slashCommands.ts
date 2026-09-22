// The `/` menu's pure half. Commands come from the agent over ACP
// (`available_commands_update`) — skills, user commands, and built-ins all
// arrive through that one channel, so Palisade never reads a skill directory
// or knows an agent's on-disk conventions.

import { fuzzyMatch } from "./fuzzyMatch";
import type { AgentCommand, Chain } from "./api";

/** How much a description hit is worth next to a name hit. A command whose
 *  name matches must always outrank one that merely mentions the word. */
const DESCRIPTION_PENALTY = 1000;

/**
 * How a saved chain is invoked from the composer (D6). Distinct from `/` on
 * purpose: a chain runs several agents against each other, which is not what
 * a slash command does, and the grammar should say so before it runs.
 */
export const CHAIN_SIGIL = "|=";

/**
 * Characters an agent uses to introduce a command. Verified by probe:
 * `claude-agent-acp` 0.69.0 advertises bare names and is driven with `/`,
 * while `codex-acp` 1.4.0 prefixes its skills with `$` and carries that
 * character inside the advertised name. Accepting both means the menu opens
 * on whichever key the user's agent taught them.
 *
 * `|=` is Palisade's own, and the reason every sigil is matched by length
 * rather than a single character: it introduces a saved agent chain (D6/D14),
 * which is a different kind of thing than a skill and deliberately does not
 * look like one.
 */
const SIGILS = ["/", "$", CHAIN_SIGIL];

/** The sigil `name` starts with, if any. Longest first, so `|=` is never read as one character. */
const sigilOf = (name: string) =>
  [...SIGILS].sort((a, b) => b.length - a.length).find((s) => name.startsWith(s));

/**
 * Which of the two `/`-menu kinds a draft is opening. The two sigil families
 * never overlap in a single draft — `|=` and `/`/`$` can't both be typed at
 * once — so a draft opens exactly one of these, never a blend of both, and
 * the menu can commit to one label instead of hedging with "commands".
 */
export type MenuKind = "skills" | "chains";

export function menuKind(draft: string): MenuKind | null {
  const sigil = sigilOf(draft.trimStart());
  if (!sigil) return null;
  return sigil === CHAIN_SIGIL ? "chains" : "skills";
}

/** The name without its sigil, for matching and display. */
export const bareName = (name: string) => {
  const sigil = sigilOf(name);
  return sigil ? name.slice(sigil.length) : name;
};

/**
 * The command query the draft is currently typing, or `null` when the menu
 * should be closed.
 *
 * Only a leading sigil opens it: mid-sentence slashes are paths and dates,
 * and a mid-sentence `$` is money. The first space closes it, because ACP
 * sends the whole line as the prompt and everything after the command name is
 * that command's input.
 */
export function slashQuery(draft: string): string | null {
  const text = draft.trimStart();
  const sigil = sigilOf(text);
  if (!sigil) return null;
  const rest = text.slice(sigil.length);
  return rest.includes(" ") ? null : rest;
}

/**
 * What to put in the composer to invoke `command`.
 *
 * ACP says a command is invoked by sending its name as the prompt. Agents
 * that advertise a sigil already carry it in the name, so prefixing a slash
 * would produce `/$tdd` — not a command Codex knows. The trailing space both
 * closes the menu and is where an argument gets typed.
 */
export function commandTrigger(command: AgentCommand): string {
  return `${sigilOf(command.name) ? "" : "/"}${command.name} `;
}

/**
 * A saved chain as a menu row (D14). Chains live in `.palisade/chains/`, not
 * in what the agent advertises, so they are the menu's second source — merged
 * into the same list and marked so the row can say which kind it is.
 */
export type MenuCommand = AgentCommand & { isChain?: boolean };

/** Reads left to right the way the graph runs: `designer → programmer`. */
function chainSummary(chain: Chain): string {
  const roles: string[] = [];
  let role: string | undefined = chain.entry;
  // Bounded by node count: a loop edge would otherwise walk forever.
  while (role && !roles.includes(role) && roles.length < Object.keys(chain.nodes).length) {
    roles.push(role);
    role = chain.edges.find((edge) => edge.from === role)?.to;
  }
  return roles.join(" → ");
}

export function chainCommands(chains: Chain[]): MenuCommand[] {
  return chains.map((chain) => ({
    name: `${CHAIN_SIGIL}${chain.name}`,
    description: chainSummary(chain),
    isChain: true,
  }));
}

/** True when this row runs a chain rather than prompting the agent. */
export const isChainCommand = (command: MenuCommand) =>
  command.isChain === true || command.name.startsWith(CHAIN_SIGIL);

/**
 * The chain a draft invokes, if it invokes one (D13): `|=<chain-name> <seed>`
 * — everything after the name is the seed input the first node receives. A
 * bare `|=<name>` is valid and runs with an empty seed.
 *
 * `known` is the project's saved chain names. The canvas lets you name a
 * chain "QA basic chain", so splitting on the first space made every
 * multi-word chain unreachable from chat: the parser read the name as "QA",
 * matched nothing, and the text went to the agent as an ordinary message
 * with no hint that the invocation was dropped. Longest known name wins, so
 * "release" and "release notes" can coexist; with no list (or no match) the
 * old first-token behaviour still applies.
 *
 * Returns `null` for anything else, including a bare `|=`, so an unfinished
 * draft is still an ordinary message.
 */
export function parseChainInvocation(
  draft: string,
  known: readonly string[] = []
): { name: string; seed: string } | null {
  const text = draft.trimStart();
  if (!text.startsWith(CHAIN_SIGIL)) return null;
  const rest = text.slice(CHAIN_SIGIL.length);

  const matched = [...known]
    .filter(
      (name) =>
        name.length > 0 &&
        rest.startsWith(name) &&
        (rest.length === name.length || /\s/.test(rest[name.length]))
    )
    .sort((a, b) => b.length - a.length)[0];
  if (matched) {
    return { name: matched, seed: rest.slice(matched.length).trim() };
  }

  const firstSpace = rest.search(/\s/);
  const name = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  if (!name) return null;
  const seed = firstSpace === -1 ? "" : rest.slice(firstSpace).trim();
  return { name, seed };
}

/**
 * The command a draft *opens with*, if any — the trigger Cursor/Windsurf
 * collapse into a pill once picked. Matched against the full trigger
 * (`commandTrigger`, trailing space included) so a draft mid-typing (no
 * space yet, still filtering the menu) never flashes a chip early; the pill
 * only appears once the name is complete and the argument position begins.
 */
export function leadingCommand<T extends AgentCommand>(
  commands: T[],
  draft: string
): T | null {
  const text = draft.trimStart();
  return (
    commands.find((command) => {
      const trigger = commandTrigger(command);
      return text === trigger.trimEnd() || text.startsWith(trigger);
    }) ?? null
  );
}

/** Commands matching `query`, best first. Empty query keeps the agent's order. */
export function matchCommands<T extends AgentCommand>(
  commands: T[],
  query: string,
): T[] {
  if (!query) return commands;
  return commands
    .map((command) => {
      // Matched against the bare name so the user never has to know the
      // sigil is part of it — typing "tdd" finds Codex's "$tdd".
      const byName = fuzzyMatch(bareName(query), bareName(command.name));
      if (byName !== null) return { command, score: byName };
      const byDescription = fuzzyMatch(query, command.description);
      if (byDescription !== null) {
        return { command, score: byDescription - DESCRIPTION_PENALTY };
      }
      return null;
    })
    .filter((hit): hit is { command: T; score: number } => hit !== null)
    .sort((a, b) => b.score - a.score)
    .map((hit) => hit.command);
}

/**
 * The skill token the caret is inside, or `null` when no menu should open.
 * `start` indexes the sigil.
 *
 * At the head of the draft every sigil opens the menu (the grammar above).
 * Past the head only `/` does, and only at a word start — a skill can be
 * picked mid-sentence ("the form double-submits, /tdd") and still reach the
 * agent as a command, because `buildPrompt` moves it to the front on send.
 * A mid-sentence `$` stays money and `|=` stays head-only: a chain is a run,
 * not a word in a message. A second `/` inside the token makes it a path.
 */
export type SlashToken = { sigil: string; query: string; start: number; leading: boolean };

export function slashAt(text: string, caret: number): SlashToken | null {
  const before = text.slice(0, caret);
  const lead = before.length - before.trimStart().length;
  const sigil = sigilOf(before.slice(lead));
  if (sigil) {
    const query = before.slice(lead + sigil.length);
    if (!/\s/.test(query)) return { sigil, query, start: lead, leading: true };
  }
  const at = before.lastIndexOf("/");
  if (at <= 0 || !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (/[\s/]/.test(query)) return null;
  return { sigil: "/", query, start: at, leading: false };
}

/** `text` with `token` cut out, and where the caret goes. */
export function removeToken(
  text: string,
  token: SlashToken
): { text: string; caret: number } {
  const end = token.start + token.sigil.length + token.query.length;
  const head = text.slice(0, token.start);
  let tail = text.slice(end);
  // Don't leave "networks,  and" behind — one space where the token was.
  if (/\s$/.test(head) || head === "") tail = tail.replace(/^ /, "");
  return { text: head + tail, caret: head.length };
}

/** How a skill reads in the composer and on the wire: `/tdd`, or `$tdd` for
 *  an agent that carries its own sigil. `commandTrigger` without the space. */
export const skillTrigger = (name: string) => `${sigilOf(name) ? "" : "/"}${name}`;
const ALSO = "Also use these skills: ";

/**
 * What the agent receives for a draft plus the skills picked into the tray.
 * The first skill leads the prompt — agents only run a command that opens
 * the turn — and any others follow as a plain instruction, since no agent
 * runs two commands in one turn.
 */
export function buildPrompt(text: string, skills: readonly string[]): string {
  if (skills.length === 0) return text;
  const [first, ...rest] = skills;
  const lead = text ? `${skillTrigger(first)} ${text}` : skillTrigger(first);
  return rest.length ? `${lead}\n\n${ALSO}${rest.map(bareName).join(", ")}` : lead;
}

/**
 * `buildPrompt` read back, so a sent turn shows the same chips it was
 * written with. Only names in `known` become chips on the leading side — a
 * message that merely starts with a path must not turn into a skill.
 */
export function parseSentPrompt(
  content: string,
  known: readonly AgentCommand[]
): { skills: string[]; text: string } {
  let text = content;
  const skills: string[] = [];
  const lead = text.match(/^([/$][^\s]+)(?:\s+|$)/);
  if (lead) {
    const hit = known.find((c) => skillTrigger(c.name) === lead[1]);
    if (hit && !isChainCommand(hit)) {
      skills.push(hit.name);
      text = text.slice(lead[0].length);
    }
  }
  const also = text.lastIndexOf(`\n\n${ALSO}`);
  if (skills.length && also !== -1) {
    const names = text.slice(also + 2 + ALSO.length).split(",").map((n) => n.trim());
    if (names.every((n) => /^\S+$/.test(n))) {
      skills.push(...names);
      text = text.slice(0, also);
    }
  }
  return { skills, text };
}

/**
 * The menu rows for a `/` token. At the head, everything `matchCommands`
 * finds. Mid-sentence, names only: a description hit would open the menu on
 * almost any word ("check /tmp" fuzzy-matches plenty of descriptions).
 */
export function matchToken<T extends AgentCommand>(pool: T[], token: SlashToken): T[] {
  const matches = matchCommands(pool, token.query);
  return token.leading
    ? matches
    : matches.filter((c) => fuzzyMatch(token.query, bareName(c.name)) !== null);
}
