// The `/` menu, shared by every composer that takes skills: a thread's chat
// and the Fleet board's new-run box. The grammar lives in slashCommands.ts;
// this is the state and the rendering, so the two composers cannot drift.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Paper, UnstyledButton } from "@mantine/core";
import { IconRoute, IconWand } from "@tabler/icons-react";
import * as api from "./api";
import {
  CHAIN_SIGIL,
  commandTrigger,
  isChainCommand,
  matchToken,
  removeToken,
  slashAt,
  type MenuCommand,
  type SlashToken,
} from "./slashCommands";

/** User-level skills on disk, for hover cards and for composers that have
 *  no live session to advertise any (Fleet). Read once per mount. */
export function useInstalledSkills(): api.Skill[] {
  const [installed, setInstalled] = useState<api.Skill[]>([]);
  useEffect(() => {
    api.listSkills().then(
      (list) => setInstalled(Array.isArray(list) ? list : []),
      () => {}
    );
  }, []);
  return installed;
}

export type SlashMenuState = ReturnType<typeof useSlashMenu>;

/**
 * The `/` token under the caret and what it matches. `suppressed` closes the
 * menu outright — a chain already picked into the head pill leaves nothing
 * to complete.
 */
export function useSlashMenu(draft: string, caret: number, commands: MenuCommand[], suppressed = false) {
  // Any sigil at the head of the draft, or a word-start `/` anywhere after it.
  const slash = useMemo(() => (suppressed ? null : slashAt(draft, caret)), [suppressed, draft, caret]);
  // Skills (`/`, `$`) or chains (`|=`): the sigils never overlap in one
  // token, so the header can name the list instead of "commands".
  const kind: "skills" | "chains" | null = slash ? (slash.sigil === CHAIN_SIGIL ? "chains" : "skills") : null;
  // Every command of the typed kind before the query narrows it — an empty
  // pool reads differently from a query that just has no matches.
  const pool = useMemo(
    () => (kind === null ? [] : commands.filter((c) => isChainCommand(c) === (kind === "chains"))),
    [commands, kind]
  );
  const matches = useMemo(() => (slash ? matchToken(pool, slash) : []), [pool, slash]);
  // At the head the menu stays open even with nothing to show — a silently
  // closed menu looked like a stray `/` that did nothing. Mid-sentence it only
  // opens on a match, so "check /tmp" then Enter sends instead of vanishing.
  const open = slash !== null && (slash.leading || matches.length > 0);
  const [index, setIndex] = useState(0);
  // Clamped here rather than in the key handler, so a shorter list after a
  // new keystroke still highlights a row that exists.
  const active = matches[index] ?? matches[0];
  useEffect(() => {
    setIndex(0);
  }, [slash?.query]);
  return { slash, kind, pool, matches, open, active, setIndex };
}

/**
 * The keys an open menu owns: arrows move, Tab/Enter pick, Escape closes
 * while keeping the typed text (only the sigil goes). Returns true when the
 * event was the menu's, so the caller stops there.
 */
export function handleSlashMenuKey(
  event: KeyboardEvent<HTMLTextAreaElement>,
  menu: SlashMenuState,
  onPick: (command: api.AgentCommand) => void,
  onEscape: (token: SlashToken) => void
): boolean {
  if (!menu.open) return false;
  const count = menu.matches.length;
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count > 0) {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    menu.setIndex((i) => (i + step + count) % count);
    return true;
  }
  if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
    event.preventDefault();
    if (menu.active) onPick(menu.active);
    return true;
  }
  if (event.key === "Escape" && menu.slash) {
    event.preventDefault();
    onEscape(menu.slash);
    return true;
  }
  return false;
}

/** A picked skill leaves the sentence and joins the tray. */
export function pickSkillIntoTray(
  draft: string,
  token: SlashToken,
  skills: string[],
  name: string
): { text: string; caret: number; skills: string[] } {
  const next = removeToken(draft, token);
  return { ...next, skills: skills.includes(name) ? skills : [...skills, name] };
}

/** The draft with the token's sigil dropped, for Escape. */
export function withoutSigil(draft: string, token: SlashToken): string {
  return draft.slice(0, token.start) + draft.slice(token.start + token.sigil.length);
}

/** The menu itself, anchored above its composer. */
export function SlashMenu({
  menu,
  onPick,
  emptySkills,
}: {
  menu: SlashMenuState;
  onPick: (command: api.AgentCommand) => void;
  /** What an empty skills pool means for this composer. */
  emptySkills: string;
}) {
  if (!menu.open) return null;
  const chains = menu.kind === "chains";
  return (
    <Paper
      withBorder
      shadow="md"
      radius="md"
      className="ds-command-menu"
      data-testid="command-menu"
      data-kind={menu.kind ?? undefined}
      role="listbox"
      aria-label={chains ? "Playbooks" : "Skills"}
    >
      <div className="ds-command-menu-header">
        {chains ? <IconRoute size={12} /> : <IconWand size={12} />}
        {chains ? "Playbooks" : "Skills"}
      </div>
      <div className="ds-command-menu-scroll">
        {menu.pool.length === 0 ? (
          <p className="ds-command-menu-empty">
            {chains ? "No playbooks saved for this project yet." : emptySkills}
          </p>
        ) : menu.matches.length === 0 ? (
          <p className="ds-command-menu-empty">No matches for “{menu.slash?.query}”.</p>
        ) : (
          menu.matches.map((command, index) => (
            <UnstyledButton
              key={command.name}
              role="option"
              aria-selected={command === menu.active}
              data-active={command === menu.active || undefined}
              className="ds-command-menu-row"
              // Mouse and keyboard drive the same highlight, so hovering
              // never leaves two rows looking selected at once.
              onMouseEnter={() => menu.setIndex(index)}
              onClick={() => onPick(command)}
            >
              <span className="ds-command-menu-name">
                {isChainCommand(command) && (
                  // A chain runs several agents against each other — a
                  // different kind of thing than a skill, and the row says
                  // so before it is picked (D14).
                  <IconRoute size={12} style={{ marginRight: 4, verticalAlign: "-1px" }} />
                )}
                {commandTrigger(command).trimEnd()}
              </span>
              <span className="ds-command-menu-desc">{command.description}</span>
            </UnstyledButton>
          ))
        )}
      </div>
    </Paper>
  );
}
