import { Fragment, memo, useCallback, useMemo, useState, type ReactNode } from "react";
import { Alert, Badge, Box, Button, Code, Group, Paper, Stack } from "@mantine/core";
import MDEditor from "@uiw/react-md-editor";
import {
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconLoader2,
  IconRefresh,
  IconRoute,
} from "@tabler/icons-react";

import type { AgentLogin, ExecutorEvent, Message, Preflight } from "./api";
import { answerPermissionPrompt } from "./api";
import { rowsFromChange } from "./diffLines";
import DiffRows from "./DiffRows";
import { ExploreHandoff } from "./BuildLaunch";
import { isAuthError } from "./errors";

/** The "Code Change Diff" tab shows only applied patches; "Console Chat" shows everything. */
export function filterForTab(items: Item[], tab: "chat" | "diff"): Item[] {
  return tab === "diff"
    ? items.filter((item) => item.kind === "fileEdit")
    : items;
}

/** One thing the chat pane can draw: a plain turn, or a structured event. */
export type Item =
  | { kind: "plain"; role: Message["role"]; mode: string; text: string; seq?: number; sessionId?: string | null; failureClass?: Message["failureClass"]; attachments?: string[]; skills?: string[]; explores?: string | null }
  /** A zero-height marker at the first turn of a session, so a chain node can
   *  scroll the transcript to what it actually did. Lives on `Item` and not on
   *  `ExecutorEvent`, which D13 caps at nine variants. */
  | { kind: "sessionAnchor"; sessionId: string }
  | ExecutorEvent;

/** DOM id of a session's anchor. Prefixed so a raw session id can never
 *  collide with another element's id or start with a digit. */
export const sessionAnchorId = (sessionId: string) => `ds-session-${sessionId}`;

/**
 * Scrolls the transcript to where `sessionId` began. Returns whether an anchor
 * was actually found, so a caller can tell "scrolled" from "that session isn't
 * on screen" instead of silently doing nothing.
 */
export function scrollToSession(sessionId: string): boolean {
  const anchor = document.getElementById(sessionAnchorId(sessionId));
  if (!anchor) return false;
  anchor.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

/**
 * Folds live `textDelta`/`reasoningDelta` events onto the in-progress
 * `text`/`reasoning` item they extend, and lets the matching complete event
 * (once it arrives) replace the accumulation with the authoritative text —
 * so streaming renders as one growing message, not a new bubble per chunk.
 * A tool call (or anything else) between two delta runs ends the run, so a
 * later delta of the same kind correctly starts a fresh item rather than
 * appending to an already-finished one.
 */
export function mergeDeltas(events: ExecutorEvent[]): ExecutorEvent[] {
  const merged: ExecutorEvent[] = [];
  for (const event of events) {
    if (event.kind === "textDelta") {
      const last = merged[merged.length - 1];
      if (last && last.kind === "text") {
        merged[merged.length - 1] = { kind: "text", text: last.text + event.text };
      } else {
        merged.push({ kind: "text", text: event.text });
      }
      continue;
    }
    if (event.kind === "reasoningDelta") {
      // elapsedSecs is a placeholder while a turn is still streaming — the
      // authoritative "reasoning" event below replaces this wholesale with
      // the backend-computed value once the turn completes.
      const last = merged[merged.length - 1];
      if (last && last.kind === "reasoning") {
        merged[merged.length - 1] = {
          kind: "reasoning",
          text: last.text + event.text,
          elapsedSecs: 0,
        };
      } else {
        merged.push({ kind: "reasoning", text: event.text, elapsedSecs: 0 });
      }
      continue;
    }
    const last = merged[merged.length - 1];
    if (
      (event.kind === "text" || event.kind === "reasoning") &&
      last?.kind === event.kind
    ) {
      merged[merged.length - 1] = event; // authoritative replace of the accumulation
      continue;
    }
    merged.push(event);
  }
  return merged;
}

/**
 * Structured events are persisted as JSON under `role: "tool"`, so a reloaded
 * thread renders the same diffs and tool blocks a live one does. Anything that
 * doesn't parse (a mode-switch marker, say) falls back to plain text.
 */
export function itemsFromMessages(messages: Message[]): Item[] {
  const items: Item[] = [];
  let openSession: string | null = null;
  for (const message of messages) {
    // A session's turns are contiguous in a thread, but a second concurrent
    // session can interleave — so anchor on *change*, not on first sight, and
    // let a resumed session anchor again at the point it resumes.
    if (message.sessionId && message.sessionId !== openSession) {
      items.push({ kind: "sessionAnchor", sessionId: message.sessionId });
    }
    openSession = message.sessionId ?? openSession;
    items.push(itemFromMessage(message));
  }
  return items;
}

function itemFromMessage(message: Message): Item {
  return ((message: Message): Item => {
    if (message.role === "tool") {
      try {
        const parsed = JSON.parse(message.content) as ExecutorEvent;
        if (parsed && typeof parsed.kind === "string") return parsed;
      } catch {
        // Not a structured event — fall through to plain rendering.
      }
    }
    return {
      kind: "plain",
      role: message.role,
      mode: message.mode,
      text: message.content,
      seq: message.seq,
      sessionId: message.sessionId,
      failureClass: message.failureClass,
      attachments: message.attachments,
      skills: message.skills,
      explores: message.explores,
    };
  })(message);
}

/** Per-turn reasoning disclosure, default collapsed (reasoning-collapse-ux).
 *  Reuses ToolBlock's collapsible Paper/header/chevron shell rather than a
 *  bespoke look — one collapsible-block pattern in the chat, not two. */
function ReasoningBlock({
  event,
}: {
  event: Extract<ExecutorEvent, { kind: "reasoning" }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Paper
      withBorder
      radius="sm"
      p={0}
      data-testid="reasoning-block"
      style={{ maxWidth: "100%", overflow: "hidden" }}
    >
      <button
        type="button"
        className="ds-event-disclosure-header"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        data-testid="reasoning-block-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "6px 12px",
          userSelect: "none",
          boxSizing: "border-box",
        }}
      >
        {open ? (
          <IconChevronDown
            size={14}
            style={{ flex: "0 0 auto" }}
            data-testid="reasoning-block-open-chev"
          />
        ) : (
          <IconChevronRight
            size={14}
            style={{ flex: "0 0 auto" }}
            data-testid="reasoning-block-closed-chev"
          />
        )}
        <Box
          style={{
            flex: "1 1 0",
            minWidth: 0,
            fontSize: 12,
            color: "var(--muted)",
          }}
        >
          Thought for {event.elapsedSecs}s
        </Box>
      </button>
      {open && (
        <Box
          p="sm"
          data-testid="reasoning-block-text"
          style={{
            borderTop: "1px solid var(--border)",
            fontSize: 13,
            color: "var(--muted)",
            maxHeight: 320,
            overflow: "auto",
          }}
        >
          <MDEditor.Markdown
            source={event.text}
            className="content reasoning-content"
          />
        </Box>
      )}
    </Paper>
  );
}

function ToolBlock({
  event,
  output,
  liveOutput,
  pending,
  onAnswer,
}: {
  event: Extract<ExecutorEvent, { kind: "toolCall" }>;
  output?: Extract<ExecutorEvent, { kind: "toolResult" }>;
  /** Output streamed so far from `toolOutputDelta` events, concatenated —
   *  shown only until the final `toolResult` replaces it wholesale. */
  liveOutput?: string;
  /** Set when the permission policy flagged this call as needing the user's
   *  decision (D7, tool-approval-prompt spec) — the turn is paused until
   *  Allow/Deny/AllowSession is answered. */
  pending?: Extract<ExecutorEvent, { kind: "permissionRequest" }>;
  onAnswer?: (requestId: string, decision: "allow" | "deny" | "allow_session") => void;
}) {
  const [open, setOpen] = useState(false);
  const failed = output?.isError === true;
  const running = !output;
  const badgeColor = pending ? "warn" : running ? "neutral" : failed ? "danger" : "success";
  const preview = event.command.split("\n")[0].slice(0, 120);
  // A pending call is a consent moment: the first line, truncated to 120
  // chars, is not the command — a heredoc or `&&` chain hides its second line
  // behind a benign-looking first one. Force the full command into view while
  // the decision is open, regardless of the user's collapse state.
  const expanded = open || !!pending;

  return (
    <Paper
      withBorder
      radius="sm"
      p={0}
      data-testid="tool-block"
      style={
        failed
          ? {
              borderColor: "var(--danger)",
              maxWidth: "100%",
              overflow: "hidden",
            }
          : { maxWidth: "100%", overflow: "hidden" }
      }
    >
      <button
        type="button"
        className="ds-event-disclosure-header"
        onClick={() => setOpen(!open)}
        aria-expanded={expanded}
        data-testid="tool-block-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "6px 12px",
          userSelect: "none",
          boxSizing: "border-box",
        }}
      >
        {expanded ? (
          <IconChevronDown
            size={14}
            style={{ flex: "0 0 auto" }}
            data-testid="tool-block-open-chev"
          />
        ) : (
          <IconChevronRight
            size={14}
            style={{ flex: "0 0 auto" }}
            data-testid="tool-block-closed-chev"
          />
        )}
        <Badge
          size="xs"
          variant="light"
          color={badgeColor}
          style={{ flex: "0 0 auto", fontSize: 10 }}
        >
          {event.name}
        </Badge>
        <Box
          style={{
            flex: "1 1 0",
            minWidth: 0,
            fontFamily:
              "var(--mono)",
            fontSize: 12,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: "var(--muted)",
          }}
        >
          {preview}
        </Box>
        {!pending && (
          <>
            {running && (
              <IconLoader2
                size={14}
                style={{ flex: "0 0 auto", color: "var(--muted)" }}
                className="ds-spin"
                data-testid="tool-status-running"
              />
            )}
            {!running && !failed && (
              <IconCircleCheck
                size={14}
                style={{ flex: "0 0 auto", color: "var(--success)" }}
                data-testid="tool-status-success"
              />
            )}
            {failed && (
              <IconCircleX
                size={14}
                style={{ flex: "0 0 auto", color: "var(--danger)" }}
                data-testid="tool-status-failed"
              />
            )}
          </>
        )}
      </button>
      {pending && (
        <Group
          gap={4}
          wrap="nowrap"
          px="sm"
          pb="sm"
          data-testid="permission-prompt"
          role="group"
          aria-label={`Permission requested for ${event.name}`}
        >
          <Button
            size="compact-xs"
            variant="light"
            color="success"
            data-testid="permission-allow"
            onClick={() => onAnswer?.(pending.id, "allow")}
          >
            Allow once
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="neutral"
            data-testid="permission-allow-session"
            onClick={() => onAnswer?.(pending.id, "allow_session")}
          >
            Allow for session
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="danger"
            data-testid="permission-deny"
            onClick={() => onAnswer?.(pending.id, "deny")}
          >
            Deny
          </Button>
        </Group>
      )}
      {pending?.warning && (
        <Alert
          color="warn"
          variant="light"
          p="xs"
          data-testid="permission-conflict-warning"
          style={{ borderRadius: 0, borderTop: "1px solid var(--border)" }}
        >
          {pending.warning}
        </Alert>
      )}
      {expanded && (
        <Stack gap="xs" p="sm" style={{ borderTop: "1px solid var(--border)" }}>
          <Code
            block
            fz="xs"
            data-testid="tool-block-command"
            style={{ maxHeight: 200, overflow: "auto" }}
          >
            {event.command}
          </Code>
          {(output || liveOutput) && (
            <Code
              block
              fz="xs"
              data-testid="tool-block-output"
              style={{
                maxHeight: 320,
                overflow: "auto",
                color: failed ? "var(--danger)" : "var(--fg)",
              }}
            >
              {output ? output.output : liveOutput}
            </Code>
          )}
        </Stack>
      )}
    </Paper>
  );
}

type ActivityEvent = Extract<
  ExecutorEvent,
  {
    kind:
      | "fileEdit"
      | "reasoning"
      | "toolCall"
      | "toolOutputDelta"
      | "toolResult"
      | "permissionRequest";
  }
>;

type TranscriptRow =
  | { kind: "activity"; index: number; items: ActivityEvent[] }
  | { kind: "item"; index: number; item: Item };

/** Keep execution evidence together without changing its order or protocol. */
function transcriptRows(items: Item[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let activity: ActivityEvent[] = [];
  let activityIndex = 0;
  const flush = () => {
    if (activity.length) rows.push({ kind: "activity", index: activityIndex, items: activity });
    activity = [];
  };

  for (const [index, item] of items.entries()) {
    if (
      item.kind === "fileEdit" ||
      item.kind === "reasoning" ||
      item.kind === "toolCall" ||
      item.kind === "toolOutputDelta" ||
      item.kind === "toolResult" ||
      item.kind === "permissionRequest"
    ) {
      if (!activity.length) activityIndex = index;
      activity.push(item);
      continue;
    }
    flush();
    rows.push({ kind: "item", index, item });
  }
  flush();
  return rows;
}

function FileEditBlock({
  event,
}: {
  event: Extract<ExecutorEvent, { kind: "fileEdit" }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="file-edit" data-testid="file-edit">
      <button
        type="button"
        className="file-edit-head ds-event-disclosure-header"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="file-edit-header"
      >
        {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        {event.path}
      </button>
      {open && <DiffRows rows={rowsFromChange(event.before, event.after)} />}
    </div>
  );
}

function AssistantResponse({ text }: { text: string }) {
  return (
    <article className="ds-assistant-response" data-testid="assistant-response">
      <MDEditor.Markdown source={text} className="content" />
    </article>
  );
}

function ActivityGroup({
  items,
  results,
  liveOutput,
  pending,
  orphans,
  onAnswer,
}: {
  items: ActivityEvent[];
  results: Map<string, Extract<ExecutorEvent, { kind: "toolResult" }>>;
  liveOutput: Map<string, string>;
  pending: Map<string, Extract<ExecutorEvent, { kind: "permissionRequest" }>>;
  /** Ids of pending requests whose tool call is not in the transcript, which
   *  therefore get a block of their own. */
  orphans: Set<string>;
  onAnswer: (requestId: string, decision: "allow" | "deny" | "allow_session") => void;
}) {
  const [open, setOpen] = useState(false);
  const actions = items.filter(
    (item) => item.kind === "toolCall" || item.kind === "fileEdit" || item.kind === "reasoning"
  );
  const edits = actions.filter((item) => item.kind === "fileEdit").length;
  const needsPermission = items.some(
    (item) => (item.kind === "toolCall" && pending.has(item.id)) || (item.kind === "permissionRequest" && orphans.has(item.id))
  );
  const isRunning = items.some(
    (item) => item.kind === "toolCall" && !results.has(item.id) && !pending.has(item.id)
  );
  const expanded = open || needsPermission;
  const state = needsPermission ? "Permission needed" : isRunning ? "Working" : "Worked";
  const summary = [
    state,
    `${actions.length} action${actions.length === 1 ? "" : "s"}`,
    edits ? `edited ${edits} file${edits === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="ds-activity-group" data-testid="activity-group">
      <button
        type="button"
        className="ds-activity-summary"
        aria-expanded={expanded}
        onClick={() => setOpen(!open)}
        data-testid="activity-summary"
      >
        {expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
        <span>{summary}</span>
      </button>
      <div className="ds-activity-body" hidden={!expanded}>
          {items.map((item, index) => {
            switch (item.kind) {
              case "toolCall":
                return (
                  <ToolBlock
                    key={`${item.id}-${index}`}
                    event={item}
                    output={results.get(item.id)}
                    liveOutput={liveOutput.get(item.id)}
                    pending={pending.get(item.id)}
                    onAnswer={onAnswer}
                  />
                );
              case "fileEdit":
                return <FileEditBlock key={`${item.id}-${index}`} event={item} />;
              case "reasoning":
                return <ReasoningBlock key={index} event={item} />;
              case "permissionRequest":
                return orphans.has(item.id) ? (
                  <ToolBlock
                    key={`${item.id}-${index}`}
                    event={{
                      kind: "toolCall",
                      id: item.toolCallId,
                      name: item.toolKind,
                      command: item.command ?? item.paths.join("\n"),
                    }}
                    pending={item}
                    onAnswer={onAnswer}
                  />
                ) : null;
              case "toolOutputDelta":
              case "toolResult":
                return null;
            }
          })}
      </div>
    </section>
  );
}

export const EventList = memo(function EventList({
  items,
  executor: _executor,
  sessionId = null,
  onPermissionAnswered,
  onRetry,
  onAcknowledgeCrash,
  agentLogins = [],
  onAgentLogin,
  agentLoginsFor,
  renderUserMessage,
}: {
  /** Draws a user turn's body — the composer uses it to show the skill chips
   *  and images a turn was sent with. Plain markdown when absent. */
  renderUserMessage?: (item: Extract<Item, { kind: "plain" }>) => ReactNode;
  items: Item[];
  executor: Preflight["selected"];
  /** The live session id these events belong to — needed to resolve a
   *  pending permission prompt. Absent for read-only render paths (e.g. the
   *  diff tab), which never include `toolCall`/`permissionRequest` items. */
  sessionId?: string | null;
  /** Removes the resolved request from the owning live-session buffer so
   *  thread-level attention indicators clear at the same time as this view. */
  onPermissionAnswered?: (requestId: string) => void;
  /** Resends a given prompt as a new message — the crash banner's retry
   *  action for an auth-shaped failure. A crashed turn ends the session
   *  (see CLAUDE.md), so "reauth" here isn't a Palisade-side flow to run;
   *  it's giving the user a one-click way to try the *next* turn once
   *  they've fixed the agent's login outside Palisade. Omitted on read-only
   *  render paths (e.g. the diff tab), which have nowhere to route a send. */
  onRetry?: (message: number | string) => void;
  /** Marks this exact crashed run handled without hiding its transcript. */
  onAcknowledgeCrash?: (sessionId: string | null) => Promise<void>;
  /** Interactive logins the thread's agent advertised over ACP. An agent that
   *  offers one expects the *client* to run it (its own `authenticate` can't),
   *  which is how an expired login gets fixed without leaving the app (#19).
   *  Empty when the agent advertises none, or hasn't been reached yet. */
  agentLogins?: AgentLogin[];
  /** Runs one of those logins — the app opens a terminal and executes it. */
  onAgentLogin?: (login: AgentLogin) => void;
  /**
   * Resolves the logins for the agent a given crash actually names. A chain
   * node runs whatever agent it is bound to, which is routinely not the
   * thread's — and offering the thread agent's sign-in for another agent's
   * auth failure is a wrong action, not a near miss. Falls back to
   * `agentLogins` when absent, for render paths with a single agent.
   */
  agentLoginsFor?: (crashText: string) => AgentLogin[];
}) {
  const [acknowledgingSessionId, setAcknowledgingSessionId] = useState<string | null>(null);
  const [acknowledgedSessionIds, setAcknowledgedSessionIds] = useState<Set<string>>(() => new Set());
  const latestCrashIndex = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (item.kind === "plain" && item.role === "system") return index;
    }
    return -1;
  }, [items]);
  // Tool output arrives as its own event; pair it back to the call it belongs to.
  const results = useMemo(() => {
    const map = new Map<
      string,
      Extract<ExecutorEvent, { kind: "toolResult" }>
    >();
    for (const item of items) {
      if (item.kind === "toolResult") map.set(item.id, item);
    }
    return map;
  }, [items]);

  // Live output streamed so far per tool call, concatenated in arrival
  // order — the running block's body until the final `toolResult` replaces
  // it wholesale (same shape as `results` above).
  const liveOutput = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      if (item.kind === "toolOutputDelta") {
        map.set(item.id, (map.get(item.id) ?? "") + item.chunk);
      }
    }
    return map;
  }, [items]);


  // Permission prompts still awaiting the user's decision, keyed by the
  // tool call they belong to. Answered ones are hidden locally the moment a
  // decision is sent (task 5.2) — the backend has no "resolved" event, so
  // this is the only signal a re-render has that it's done.
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const pending = useMemo(() => {
    const map = new Map<
      string,
      Extract<ExecutorEvent, { kind: "permissionRequest" }>
    >();
    for (const item of items) {
      if (item.kind === "permissionRequest" && !answered.has(item.id)) {
        map.set(item.toolCallId, item);
      }
    }
    return map;
  }, [items, answered]);
  // A request for a tool call the transcript never announced (e.g. a Codex
  // subagent's approval surfaced through its parent) has no block to draw on.
  const orphans = useMemo(() => {
    const announced = new Set(items.flatMap((item) => (item.kind === "toolCall" ? [item.id] : [])));
    return new Set(
      [...pending.values()].filter((req) => !announced.has(req.toolCallId)).map((req) => req.id)
    );
  }, [items, pending]);
  const onAnswer = useCallback(
    (requestId: string, decision: "allow" | "deny" | "allow_session") => {
      setAnswered((prev) => new Set(prev).add(requestId));
      onPermissionAnswered?.(requestId);
      if (sessionId) void answerPermissionPrompt(sessionId, requestId, decision);
    },
    [sessionId, onPermissionAnswered]
  );

  return (
    <>
      {transcriptRows(items).map((row) => {
        if (row.kind === "activity") {
          return (
            <ActivityGroup
              key={`activity-${row.index}`}
              items={row.items}
              results={results}
              liveOutput={liveOutput}
              pending={pending}
              orphans={orphans}
              onAnswer={onAnswer}
            />
          );
        }
        const { item, index } = row;
        switch (item.kind) {
          // Laid out but zero-height: `scrollIntoView` is a no-op on a
          // `display: none` element, so this cannot use `hidden`.
          case "sessionAnchor":
            return (
              <span
                key={index}
                id={sessionAnchorId(item.sessionId)}
                data-session-anchor={item.sessionId}
                aria-hidden="true"
                style={{ display: "block", height: 0 }}
              />
            );
          case "plain":
            // A chain run's own commentary (D7): what the run did, or that
            // it is waiting at a gate. Neutral, not danger — the text states
            // the outcome, and "finished" reading as a crash is worse than
            // no banner at all.
            if (item.role === "chain") {
              return (
                <Alert
                  key={index}
                  color="neutral"
                  variant="light"
                  icon={<IconRoute size={16} />}
                  data-testid="chain-summary"
                >
                  <MDEditor.Markdown source={item.text} className="content" />
                </Alert>
              );
            }
            // A crash is persisted as a system turn; it stays a banner on
            // reload. An auth-shaped one reads as "the app is broken" if all
            // it shows is a raw internal error string — the CLI just told us
            // its own login expired, which isn't a Palisade bug to silently
            // eat, but it also isn't unrecoverable: a plain-language line
            // plus a one-click retry replaces "what do I even do with this".
            if (item.role === "system") {
              // A typed provider result wins over its prose. Old persisted
              // rows carry no class, so only those retain the text fallback.
              const authIssue = item.failureClass === "authRequired" ||
                (item.failureClass == null && isAuthError(item.text));
              const transient = item.failureClass === "transientProvider";
              // Whose login is broken, not whose agent the thread happens to
              // be pointed at.
              const logins = agentLoginsFor ? agentLoginsFor(item.text) : agentLogins;
              const managedAuthRecovery = item.text.startsWith(
                "Palisade is waiting for you to sign in."
              );
              // The prompt that led to this crash — found by walking back to
              // the nearest preceding user turn — is what Retry resends. A
              // crashed turn can persist a partial assistant reply right
              // before the crash marker (the agent's own text before the RPC
              // itself failed) — stopping the walk at that assistant item
              // used to skip straight past the user turn that caused it, so
              // the button silently never appeared for exactly that shape.
              let retryMessage: number | string | null = null;
              if ((authIssue || transient) && onRetry && !managedAuthRecovery) {
                for (let i = index - 1; i >= 0; i--) {
                  const prior = items[i];
                  if (prior.kind === "plain" && prior.role === "user") {
                    retryMessage = prior.seq ?? prior.text;
                    break;
                  }
                }
              }
              return (
                <Alert
                  key={index}
                  color={transient ? "brand" : "danger"}
                  variant="light"
                  data-testid="crash-banner"
                  className={authIssue ? "ds-crash-banner-auth" : undefined}
                >
                  {authIssue && (
                    <div
                      className="ds-crash-banner-auth-summary"
                      data-testid="crash-banner-auth-summary"
                    >
                      {logins.length > 0
                        ? managedAuthRecovery
                          ? "This agent needs you to sign in. Choose a method below and Palisade will resume your message once."
                          : "This agent's login expired or failed to refresh. Sign in below — Palisade runs the agent's own login in a terminal here — then retry."
                        : "This agent's login expired or failed to refresh. Palisade can't complete an interactive login on its own — sign back in outside Palisade, then retry."}
                    </div>
                  )}
                  {transient && <div data-testid="crash-banner-transient-summary">The provider is temporarily unavailable. Your message was kept; retry when it is ready.</div>}
                  <div className="ds-crash-banner-detail">{item.text}</div>
                  {authIssue &&
                    onAgentLogin &&
                    logins.map((login) => (
                      <button
                        key={login.methodId}
                        type="button"
                        className="ds-crash-banner-retry"
                        onClick={() => onAgentLogin(login)}
                        data-testid="crash-banner-signin"
                      >
                        Sign in with {login.label}
                      </button>
                    ))}
                  {retryMessage != null && (
                    <button
                      type="button"
                      className="ds-crash-banner-retry"
                      onClick={() => onRetry?.(retryMessage!)}
                      data-testid="crash-banner-retry"
                    >
                      <IconRefresh size={12} />
                      Retry
                    </button>
                  )}
                  {onAcknowledgeCrash && index === latestCrashIndex && (
                    <button
                      type="button"
                      className="ds-crash-banner-retry"
                      disabled={
                        acknowledgingSessionId === (item.sessionId ?? `legacy-${index}`) ||
                        acknowledgedSessionIds.has(item.sessionId ?? `legacy-${index}`)
                      }
                      onClick={() => {
                        const sessionId = item.sessionId ?? null;
                        const key = sessionId ?? `legacy-${index}`;
                        setAcknowledgingSessionId(key);
                        void onAcknowledgeCrash(sessionId)
                          .then(() => setAcknowledgedSessionIds((seen) => new Set(seen).add(key)))
                          .catch(() => {})
                          .finally(() => setAcknowledgingSessionId(null));
                      }}
                      data-testid="crash-banner-acknowledge"
                    >
                      {acknowledgedSessionIds.has(item.sessionId ?? `legacy-${index}`)
                        ? "Acknowledged"
                        : "Acknowledge"}
                    </button>
                  )}
                </Alert>
              );
            }
            if (item.role === "assistant") {
              return (
                <AssistantResponse key={index} text={item.text} />
              );
            }
            // The turn that started exploring is the user's own words, so it
            // keeps its bubble; the stage marker sits above it.
            return (
              <Fragment key={index}>
                {item.role === "user" && item.explores != null && (
                  <div className="message user">
                    <ExploreHandoff target={item.explores} />
                  </div>
                )}
                <div className={`message ${item.role}`}>
                  {item.role === "user" && renderUserMessage ? (
                    renderUserMessage(item)
                  ) : (
                    <MDEditor.Markdown source={item.text} className="content" />
                  )}
                </div>
              </Fragment>
            );
          case "text":
            return (
              <AssistantResponse key={index} text={item.text} />
            );
          case "reasoning":
          case "fileEdit":
          case "toolCall":
          case "permissionRequest":
            return null;
          // mergeDeltas always folds these into "text"/"reasoning" before
          // EventList sees them; kept here only so the switch documents
          // every Item kind instead of relying on the implicit fallthrough.
          case "textDelta":
          case "reasoningDelta":
          // Folded into `liveOutput` above, rendered on the tool block it
          // belongs to — not its own bubble.
          case "toolOutputDelta":
            return null;
          case "crashed":
            return (
              <Alert
                key={index}
                color="danger"
                variant="light"
                data-testid="crash-banner"
              >
                {item.message}
                {item.exitCode !== null && ` (exit code ${item.exitCode})`}
              </Alert>
            );
          // Tool output is drawn inside its call; `done` is bookkeeping.
          case "toolResult":
          case "done":
            return null;
        }
      })}
    </>
  );
});
