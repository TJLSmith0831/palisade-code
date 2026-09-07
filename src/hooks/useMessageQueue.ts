import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A message the user typed while their thread was mid-turn (#26).
 *
 * Agents accept one prompt per turn, so a second `send` during a turn is
 * either dropped or interleaved into the agent's own context at random. The
 * queue is the honest version of what users were already doing by hand:
 * hold the text, show it, and send it the moment the turn ends.
 */
export type QueuedMessage = {
  id: string;
  projectHash: string;
  threadId: string;
  text: string;
  /**
   * Set when the send failed. A failed message stops the queue for its thread
   * and waits for the user rather than retrying on a loop — an agent that
   * just crashed will not answer a retry any better, and silently dropping
   * text the user typed is the one outcome that is never acceptable.
   */
  error?: string;
};

let nextQueueId = 0;

const reason = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * FIFO per-thread outbox for messages typed during a turn.
 *
 * `busyThreads` is the same live set the chat header reads, so the queue
 * drains on exactly the signal the user sees: the thread stops working, the
 * next message goes out.
 */
export function useMessageQueue(
  busyThreads: Set<string>,
  send: (message: QueuedMessage) => Promise<unknown>
) {
  const [items, setItems] = useState<QueuedMessage[]>([]);
  // The caller re-creates `send` every render (it closes over project and
  // thread state); reading it through a ref keeps the drain effect from
  // restarting a send that is already in flight.
  const sendRef = useRef(send);
  sendRef.current = send;
  const inFlight = useRef(false);

  useEffect(() => {
    if (inFlight.current) return;
    const next = items.find((m) => !m.error && !busyThreads.has(m.threadId));
    if (!next) return;
    inFlight.current = true;
    void (async () => {
      try {
        await sendRef.current(next);
        setItems((prev) => prev.filter((m) => m.id !== next.id));
      } catch (err) {
        setItems((prev) =>
          prev.map((m) => (m.id === next.id ? { ...m, error: reason(err) } : m))
        );
      } finally {
        // Cleared before React re-renders on the state change above, so the
        // effect's next run picks up the following message immediately.
        inFlight.current = false;
      }
    })();
  }, [items, busyThreads]);

  const enqueue = useCallback(
    (projectHash: string, threadId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setItems((prev) => [
        ...prev,
        {
          id: `q${++nextQueueId}`,
          projectHash,
          threadId,
          text: trimmed,
        },
      ]);
    },
    []
  );

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const retry = useCallback((id: string) => {
    setItems((prev) =>
      prev.map((m) => (m.id === id ? { ...m, error: undefined } : m))
    );
  }, []);

  return { items, enqueue, remove, retry };
}
