import { useState } from "react";
import ReactDiffViewer from "react-diff-viewer-continued";

import type { ExecutorEvent, Message } from "./api";

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
    if ((event.kind === "text" || event.kind === "reasoning") && last?.kind === event.kind) {
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
    return { kind: "plain", role: message.role, mode: message.mode, text: message.content };
  });
}

function ToolBlock({ event, output }: { event: Extract<ExecutorEvent, { kind: "toolCall" }>; output?: Extract<ExecutorEvent, { kind: "toolResult" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool-block ${output?.isError ? "failed" : ""}`} data-testid="tool-block">
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{event.name}</span>
        <code>{event.command.split("\n")[0].slice(0, 120)}</code>
        {!output && <span className="running">running…</span>}
      </button>
      {open && (
        <pre className="tool-body">
          {event.command}
          {output ? `\n\n${output.output}` : ""}
        </pre>
      )}
    </div>
  );
}

export function EventList({ items, showThinking }: { items: Item[]; showThinking: boolean }) {
  // Tool output arrives as its own event; pair it back to the call it belongs to.
  const results = new Map<string, Extract<ExecutorEvent, { kind: "toolResult" }>>();
  for (const item of items) {
    if (item.kind === "toolResult") results.set(item.id, item);
  }

  return (
    <>
      {items.map((item, index) => {
        switch (item.kind) {
          case "plain":
            // A crash is persisted as a system turn; it stays a banner on reload.
            return item.role === "system" ? (
              <div key={index} className="crash-banner" data-testid="crash-banner">
                {item.text} Reverted to spec mode.
              </div>
            ) : (
              <div key={index} className={`message ${item.role}`}>
                <span className="meta">
                  {item.role} · {item.mode}
                </span>
                <div className="content">{item.text}</div>
              </div>
            );
          case "text":
            return (
              <div key={index} className="message assistant">
                <span className="meta">assistant</span>
                <div className="content">{item.text}</div>
              </div>
            );
          case "reasoning":
            // Global toggle (D19), not a per-message disclosure — off means
            // not rendered at all.
            return showThinking ? (
              <div key={index} className="reasoning-inline" data-testid="reasoning">
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
                <ReactDiffViewer
                  oldValue={item.before}
                  newValue={item.after}
                  splitView={false}
                  useDarkTheme
                  hideLineNumbers
                  showDiffOnly
                />
              </div>
            );
          case "toolCall":
            return <ToolBlock key={index} event={item} output={results.get(item.id)} />;
          case "crashed":
            return (
              <div key={index} className="crash-banner" data-testid="crash-banner">
                {item.message}
                {item.exitCode !== null && ` (exit code ${item.exitCode})`} Reverted to spec mode.
              </div>
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
