import type { Message } from "./api";

/** Fold a fresh read of a thread's history into what's on screen.
 * An optimistic bubble (the user's text, shown before the backend has stored
 * it) is superseded only once a real user row newer than anything already
 * shown has landed. The backend writes that row after starting the agent
 * session, so an earlier refresh must not drop the bubble and leave the chat
 * empty. */
export function mergeRefreshed(prev: Message[], history: Message[], optimisticSeq: number): Message[] {
  const newest = history[0]?.seq ?? Number.POSITIVE_INFINITY;
  const real = prev.filter((m) => m.seq !== optimisticSeq);
  const known = real.reduce((n, m) => Math.max(n, m.seq), 0);
  const landed = history.some((m) => m.role === "user" && m.seq > known);
  const pending = landed ? [] : prev.filter((m) => m.seq === optimisticSeq);
  return [...real.filter((m) => m.seq < newest), ...history, ...pending];
}
