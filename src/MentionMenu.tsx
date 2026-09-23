// The `@` menu: threads, project files, and folders anywhere on disk. The
// grammar lives in mentions.ts; this is the state, the keys and the
// rendering, kept out of App.tsx the same way SkillMenu.tsx is.
import { Fragment, useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Paper, UnstyledButton } from "@mantine/core";
import { IconFile, IconFolder, IconFolderSearch, IconMessageCircle } from "@tabler/icons-react";
import * as api from "./api";
import {
  isPathQuery,
  mentionAt,
  mentionOptions,
  shortPath,
  splitPathQuery,
  type Mention,
  type MentionOption,
  type MentionScope,
} from "./mentions";
import { relativeTime } from "./SessionList";

type MentionThread = { id: string; title: string; updatedAt: string };

const SCOPES: MentionScope[] = ["all", "threads", "files"];
const SCOPE_LABEL: Record<MentionScope, string> = { all: "All", threads: "Threads", files: "Files" };

export type MentionMenuState<T extends MentionThread> = ReturnType<typeof useMentionMenu<T>>;

/**
 * The mention the caret is inside and what it offers. Unlike `/`, a mention
 * is a reference inside a sentence — "compare @src/api.ts with @src/App.tsx"
 * — so it opens wherever the caret is. `suppressed` keeps it shut while the
 * `/` menu owns the keys.
 */
export function useMentionMenu<T extends MentionThread>(
  draft: string,
  caret: number,
  sources: { files: string[]; threads: T[] },
  suppressed = false
) {
  const id = useId();
  const [index, setIndex] = useState(0);
  const [scope, setScope] = useState<MentionScope>("all");
  const mention: Mention | null = useMemo(
    () => (suppressed ? null : mentionAt(draft, caret)),
    [draft, caret, suppressed]
  );
  const open = mention !== null;
  // `@/…` and `@~/…` browse the disk outside the project, one folder at a time.
  const pathQuery = mention && isPathQuery(mention.query) ? splitPathQuery(mention.query) : null;
  const showHidden = pathQuery?.filter.startsWith(".") ?? false;
  const [pathEntries, setPathEntries] = useState<api.DirEntry[] | "error" | null>(null);
  useEffect(() => {
    if (!pathQuery) return;
    let live = true;
    setPathEntries(null);
    api.listAnyDirectory(pathQuery.dir, showHidden).then(
      (entries) => live && setPathEntries(entries),
      () => live && setPathEntries("error")
    );
    return () => {
      live = false;
    };
  }, [pathQuery?.dir, showHidden]);
  const options = useMemo(
    (): MentionOption<T>[] =>
      mention
        ? mentionOptions(
            mention.query,
            { ...sources, entries: Array.isArray(pathEntries) ? pathEntries : null },
            scope
          )
        : [],
    [mention?.query, sources.files, sources.threads, pathEntries, scope]
  );
  const activeIndex = options[index] ? index : 0;
  const active = options[activeIndex];
  const activeId = active ? `${id}-option-${activeIndex}` : undefined;
  useEffect(() => {
    if (open && activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeId]);
  useEffect(() => {
    setIndex(0);
  }, [mention?.query, scope]);
  useEffect(() => {
    if (!open) setScope("all");
  }, [open]);
  return { id, mention, open, pathQuery, pathEntries, files: sources.files, options, active, activeId, scope, setScope, setIndex };
}

/**
 * The keys an open menu owns: ⌃Tab cycles the scope, arrows move, Tab/Enter
 * pick, Escape closes. Returns true when the event was the menu's.
 */
export function handleMentionMenuKey<T extends MentionThread>(
  event: KeyboardEvent<HTMLTextAreaElement>,
  menu: MentionMenuState<T>,
  onPick: (option: MentionOption<T>) => void,
  onEscape: (mention: Mention) => void
): boolean {
  if (!menu.mention) return false;
  if (!menu.pathQuery && event.key === "Tab" && event.ctrlKey) {
    event.preventDefault();
    const step = event.shiftKey ? SCOPES.length - 1 : 1;
    menu.setScope((scope) => SCOPES[(SCOPES.indexOf(scope) + step) % SCOPES.length]);
    return true;
  }
  const count = menu.options.length;
  if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count > 0) {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    menu.setIndex((i) => (i + step + count) % count);
    return true;
  }
  if (menu.active && ((event.key === "Tab" && !event.ctrlKey) || (event.key === "Enter" && !event.shiftKey))) {
    event.preventDefault();
    onPick(menu.active);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    onEscape(menu.mention);
    return true;
  }
  return false;
}

const optionKey = <T extends MentionThread>(option: MentionOption<T>) => {
  switch (option.kind) {
    case "file":
      return `f:${option.path}`;
    case "thread":
      return `t:${option.thread.id}`;
    case "path":
      return `p:${option.entry.path}`;
    case "browse":
      return "browse";
  }
};

const ROW_ICON = { marginRight: 4, verticalAlign: "-1px" };

function OptionRow<T extends MentionThread>({ option }: { option: MentionOption<T> }) {
  switch (option.kind) {
    case "file":
      return (
        <>
          <span className="ds-command-menu-name">{option.path.split("/").pop()}</span>
          <span className="ds-command-menu-desc">{option.path}</span>
        </>
      );
    case "thread":
      return (
        <>
          <span className="ds-command-menu-name">{option.thread.title}</span>
          <span className="ds-command-menu-desc">{relativeTime(option.thread.updatedAt)}</span>
        </>
      );
    case "path":
      return (
        <span className="ds-command-menu-name">
          {option.entry.is_dir ? <IconFolder size={12} style={ROW_ICON} /> : <IconFile size={12} style={ROW_ICON} />}
          {option.entry.name}
          {option.entry.is_dir ? "/" : ""}
        </span>
      );
    case "browse":
      return (
        <span className="ds-command-menu-name">
          <IconFolderSearch size={12} style={ROW_ICON} />
          Browse…
        </span>
      );
  }
}

/** Why the list is empty, or still loading; `null` when it has rows to show. */
function emptyMessage<T extends MentionThread>(menu: MentionMenuState<T>): string | null {
  const { pathQuery, pathEntries, options, scope, files } = menu;
  const query = menu.mention?.query ?? "";
  if (pathQuery) {
    if (pathEntries === null) return `Reading ${pathQuery.dir}…`;
    if (pathEntries === "error") return `Can't read ${pathQuery.dir}.`;
    return null;
  }
  if (options.length === 0) return query ? `No threads match “${query}”.` : "No other threads yet.";
  if (options.every((o) => o.kind === "browse")) {
    if (files.length === 0) return "Reading the project's files…";
    return `No ${scope === "all" ? "files or threads" : scope} match “${query}”.`;
  }
  return null;
}

/** The menu itself, anchored above its composer. Scopes keep every matching
 *  thread reachable in a large project; `@/` or `@~/` browses the disk. */
export function MentionMenu<T extends MentionThread>({
  menu,
  onPick,
}: {
  menu: MentionMenuState<T>;
  onPick: (option: MentionOption<T>) => void;
}) {
  if (!menu.mention) return null;
  const { pathQuery, options, scope } = menu;
  const firstThread = options.findIndex((o) => o.kind === "thread");
  const firstFile = options.findIndex((o) => o.kind === "file");
  const empty = emptyMessage(menu);
  return (
    <Paper withBorder shadow="md" radius="md" className="ds-command-menu" data-testid="mention-menu">
      {!pathQuery && (
        <div className="ds-mention-scopes" role="group" aria-label="Mention search scope">
          {SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              data-testid={`mention-scope-${s}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => menu.setScope(s)}
            >
              {SCOPE_LABEL[s]}
            </button>
          ))}
          <span className="ds-mention-scopes-hint">⌃Tab to switch</span>
        </div>
      )}
      <div
        className="ds-command-menu-scroll"
        id={menu.id}
        role="listbox"
        aria-label={pathQuery ? "Files on disk" : `${scope} mentions`}
      >
        {pathQuery && (
          <div className="ds-command-menu-header" data-path title={pathQuery.dir}>
            <IconFolder size={12} />
            {shortPath(pathQuery.dir)}
          </div>
        )}
        {empty && <p className="ds-command-menu-empty">{empty}</p>}
        {options.map((option, index) => (
          <Fragment key={optionKey(option)}>
            {index === firstThread && (
              <div className="ds-command-menu-header">
                <IconMessageCircle size={12} />
                {scope === "all" && !menu.mention?.query ? "Recent threads" : "Threads"}
              </div>
            )}
            {index === firstFile && (
              <div className="ds-command-menu-header">
                <IconFile size={12} />
                Files
              </div>
            )}
            <UnstyledButton
              id={`${menu.id}-option-${index}`}
              role="option"
              aria-selected={option === menu.active}
              data-active={option === menu.active || undefined}
              className="ds-command-menu-row"
              data-testid="mention-row"
              data-kind={option.kind}
              onMouseEnter={() => menu.setIndex(index)}
              onClick={() => onPick(option)}
            >
              <OptionRow option={option} />
            </UnstyledButton>
          </Fragment>
        ))}
      </div>
    </Paper>
  );
}
