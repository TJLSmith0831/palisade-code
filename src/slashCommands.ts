// The `/` menu's pure half. Commands come from the agent over ACP
// (`available_commands_update`) — skills, user commands, and built-ins all
// arrive through that one channel, so Palisade never reads a skill directory
// or knows an agent's on-disk conventions.

import { fuzzyMatch } from "./fuzzyMatch";
import type { AgentCommand } from "./api";

/** How much a description hit is worth next to a name hit. A command whose
 *  name matches must always outrank one that merely mentions the word. */
const DESCRIPTION_PENALTY = 1000;

/**
 * Characters an agent uses to introduce a command. Verified by probe:
 * `claude-agent-acp` 0.69.0 advertises bare names and is driven with `/`,
 * while `codex-acp` 1.4.0 prefixes its skills with `$` and carries that
 * character inside the advertised name. Accepting both means the menu opens
 * on whichever key the user's agent taught them.
 */
const SIGILS = ["/", "$"];

/** The name without its sigil, for matching and display. */
const bareName = (name: string) =>
  SIGILS.some((s) => name.startsWith(s)) ? name.slice(1) : name;

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
  if (!SIGILS.some((sigil) => text.startsWith(sigil))) return null;
  const rest = text.slice(1);
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
  const prefixed = SIGILS.some((sigil) => command.name.startsWith(sigil));
  return `${prefixed ? "" : "/"}${command.name} `;
}

/** Commands matching `query`, best first. Empty query keeps the agent's order. */
export function matchCommands(
  commands: AgentCommand[],
  query: string,
): AgentCommand[] {
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
    .filter((hit): hit is { command: AgentCommand; score: number } => hit !== null)
    .sort((a, b) => b.score - a.score)
    .map((hit) => hit.command);
}
