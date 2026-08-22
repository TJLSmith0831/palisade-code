import { memo, useCallback, useMemo, useState } from "react";
import { Alert, Badge, Box, Button, Code, Group, Paper, Stack } from "@mantine/core";
import MDEditor from "@uiw/react-md-editor";
import {
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconGhost3Filled,
  IconLoader2,
  IconTerminal2,
} from "@tabler/icons-react";

import type { ExecutorEvent, Message, Preflight } from "./api";
import { answerPermissionPrompt } from "./api";
import { rowsFromChange } from "./diffLines";
import DiffRows from "./DiffRows";

/** The "Code Change Diff" tab shows only applied patches; "Console Chat" shows everything. */
export function filterForTab(items: Item[], tab: "chat" | "diff"): Item[] {
  return tab === "diff"
    ? items.filter((item) => item.kind === "fileEdit")
    : items;
}

function ChatAvatar({ executor }: { executor: Preflight["selected"] }) {
  return (
    <div className="ds-chat-avatar">
      {executor === "claude" ? (
        <IconGhost3Filled size={18} />
      ) : (
        <IconTerminal2 size={18} />
      )}
    </div>
  );
}

/** One thing the chat pane can draw: a plain turn, or a structured event. */
export type Item =
  | { kind: "plain"; role: Message["role"]; mode: string; text: string }
  | ExecutorEvent;

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
  return messages.map((message) => {
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
    };
  });
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
      <Box
        onClick={() => setOpen(!open)}
        data-testid="reasoning-block-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "6px 12px",
          cursor: "pointer",
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
      </Box>
      {open && (
        <Box
          p="sm"
          data-testid="reasoning-block-text"
          style={{
            borderTop: "1px solid var(--border)",
            whiteSpace: "pre-wrap",
            fontSize: 13,
            color: "var(--muted)",
            maxHeight: 320,
            overflow: "auto",
          }}
        >
          {event.text}
        </Box>
      )}
    </Paper>
  );
}

function ToolBlock({
  event,
  output,
  pending,
  onAnswer,
}: {
  event: Extract<ExecutorEvent, { kind: "toolCall" }>;
  output?: Extract<ExecutorEvent, { kind: "toolResult" }>;
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
      <Box
        onClick={() => setOpen(!open)}
        data-testid="tool-block-header"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "6px 12px",
          cursor: "pointer",
          userSelect: "none",
          boxSizing: "border-box",
        }}
      >
        {open ? (
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
          style={{ flex: "0 0 auto" }}
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
        {pending ? (
          <Group gap={4} wrap="nowrap" data-testid="permission-prompt" onClick={(e) => e.stopPropagation()}>
            <Button
              size="compact-xs"
              variant="light"
              color="success"
              data-testid="permission-allow"
              onClick={() => onAnswer?.(pending.id, "allow")}
            >
              Allow
            </Button>
            <Button
              size="compact-xs"
              variant="light"
              color="danger"
              data-testid="permission-deny"
              onClick={() => onAnswer?.(pending.id, "deny")}
            >
              Deny
            </Button>
            <Button
              size="compact-xs"
              variant="light"
              color="neutral"
              data-testid="permission-allow-session"
              onClick={() => onAnswer?.(pending.id, "allow_session")}
            >
              Allow for session
            </Button>
          </Group>
        ) : (
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
      </Box>
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
      {open && (
        <Stack gap="xs" p="sm" style={{ borderTop: "1px solid var(--border)" }}>
          <Code
            block
            fz="xs"
            data-testid="tool-block-command"
            style={{ maxHeight: 200, overflow: "auto" }}
          >
            {event.command}
          </Code>
          {output && (
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
              {output.output}
            </Code>
          )}
        </Stack>
      )}
    </Paper>
  );
}

export const EventList = memo(function EventList({
  items,
  executor,
  sessionId = null,
}: {
  items: Item[];
  executor: Preflight["selected"];
  /** The live session id these events belong to — needed to resolve a
   *  pending permission prompt. Absent for read-only render paths (e.g. the
   *  diff tab), which never include `toolCall`/`permissionRequest` items. */
  sessionId?: string | null;
}) {
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
  const onAnswer = useCallback(
    (requestId: string, decision: "allow" | "deny" | "allow_session") => {
      setAnswered((prev) => new Set(prev).add(requestId));
      if (sessionId) void answerPermissionPrompt(sessionId, requestId, decision);
    },
    [sessionId]
  );

  return (
    <>
      {items.map((item, index) => {
        switch (item.kind) {
          case "plain":
            // A crash is persisted as a system turn; it stays a banner on reload.
            if (item.role === "system") {
              return (
                <Alert
                  key={index}
                  color="danger"
                  variant="light"
                  data-testid="crash-banner"
                >
                  {item.text}
                </Alert>
              );
            }
            if (item.role === "assistant") {
              return (
                <div key={index} className="ds-chat-bubble agent">
                  <ChatAvatar executor={executor} />
                  <div className="message assistant">
                    <span className="meta">
                      {item.role} · {item.mode}
                    </span>
                    <MDEditor.Markdown source={item.text} className="content" />
                  </div>
                </div>
              );
            }
            return (
              <div key={index} className={`message ${item.role}`}>
                <span className="meta">
                  {item.role} · {item.mode}
                </span>
                <MDEditor.Markdown source={item.text} className="content" />
              </div>
            );
          case "text":
            return (
              <div key={index} className="ds-chat-bubble agent">
                <ChatAvatar executor={executor} />
                <div className="message assistant">
                  <span className="meta">assistant</span>
                  <MDEditor.Markdown source={item.text} className="content" />
                </div>
              </div>
            );
          case "reasoning":
            // Per-turn disclosure, default collapsed (reasoning-collapse-ux
            // D1) — supersedes the removed global show/hide toggle.
            return <ReasoningBlock key={index} event={item} />;
          // mergeDeltas always folds these into "text"/"reasoning" before
          // EventList sees them; kept here only so the switch documents
          // every Item kind instead of relying on the implicit fallthrough.
          case "textDelta":
          case "reasoningDelta":
            return null;
          case "fileEdit":
            return (
              <div key={index} className="file-edit" data-testid="file-edit">
                <div className="file-edit-head">{item.path}</div>
                <DiffRows rows={rowsFromChange(item.before, item.after)} />
              </div>
            );
          case "toolCall":
            return (
              <ToolBlock
                key={index}
                event={item}
                output={results.get(item.id)}
                pending={pending.get(item.id)}
                onAnswer={onAnswer}
              />
            );
          // Rendered inline on the tool call it belongs to (via `pending`),
          // not as its own bubble.
          case "permissionRequest":
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
