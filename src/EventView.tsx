import { useState } from "react";
import { Alert, Badge, Code, Group, Paper, Stack, Text } from "@mantine/core";
import MDEditor from "@uiw/react-md-editor";
import {
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconGhost3Filled,
  IconLoader2,
} from "@tabler/icons-react";

import type { ExecutorEvent, Message, Preflight } from "./api";
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
        <IconGhost3Filled size={24} style={{ color: "var(--accent)" }} />
      ) : executor === "codex" ? (
        "X"
      ) : (
        "A"
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
    if (event.kind === "textDelta" || event.kind === "reasoningDelta") {
      const kind = event.kind === "textDelta" ? "text" : "reasoning";
      const last = merged[merged.length - 1];
      if (last && last.kind === kind) {
        merged[merged.length - 1] = { kind, text: last.text + event.text };
      } else {
        merged.push({ kind, text: event.text });
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

function ToolBlock({
  event,
  output,
}: {
  event: Extract<ExecutorEvent, { kind: "toolCall" }>;
  output?: Extract<ExecutorEvent, { kind: "toolResult" }>;
}) {
  const [open, setOpen] = useState(false);
  const failed = output?.isError === true;
  const running = !output;
  const badgeColor = running ? "gray" : failed ? "red" : "green";
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
      <Group
        gap="xs"
        wrap="nowrap"
        align="center"
        px="sm"
        py={6}
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => setOpen(!open)}
        data-testid="tool-block-header"
      >
        {open ? (
          <IconChevronDown
            size={14}
            style={{ flexShrink: 0 }}
            data-testid="tool-block-open-chev"
          />
        ) : (
          <IconChevronRight
            size={14}
            style={{ flexShrink: 0 }}
            data-testid="tool-block-closed-chev"
          />
        )}
        <Badge
          size="xs"
          variant="light"
          color={badgeColor}
          style={{ flexShrink: 0 }}
        >
          {event.name}
        </Badge>
        <Text
          size="xs"
          ff="monospace"
          truncate
          style={{ flex: 1, minWidth: 0 }}
        >
          {preview}
        </Text>
        {running && (
          <IconLoader2
            size={14}
            style={{ flexShrink: 0, color: "var(--muted)" }}
            className="ds-spin"
            data-testid="tool-status-running"
          />
        )}
        {!running && !failed && (
          <IconCircleCheck
            size={14}
            style={{ flexShrink: 0, color: "var(--success)" }}
            data-testid="tool-status-success"
          />
        )}
        {failed && (
          <IconCircleX
            size={14}
            style={{ flexShrink: 0, color: "var(--danger)" }}
            data-testid="tool-status-failed"
          />
        )}
      </Group>
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

export function EventList({
  items,
  showThinking,
  executor,
}: {
  items: Item[];
  showThinking: boolean;
  executor: Preflight["selected"];
}) {
  // Tool output arrives as its own event; pair it back to the call it belongs to.
  const results = new Map<
    string,
    Extract<ExecutorEvent, { kind: "toolResult" }>
  >();
  for (const item of items) {
    if (item.kind === "toolResult") results.set(item.id, item);
  }

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
                  color="var(--danger)"
                  variant="light"
                  data-testid="crash-banner"
                >
                  {item.text} Reverted to spec mode.
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
            // Global toggle (D19), not a per-message disclosure — off means
            // not rendered at all.
            return showThinking ? (
              <div
                key={index}
                className="reasoning-inline"
                data-testid="reasoning"
              >
                {item.text}
              </div>
            ) : null;
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
              />
            );
          case "crashed":
            return (
              <Alert
                key={index}
                color="var(--danger)"
                variant="light"
                data-testid="crash-banner"
              >
                {item.message}
                {item.exitCode !== null && ` (exit code ${item.exitCode})`}{" "}
                Reverted to spec mode.
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
}
