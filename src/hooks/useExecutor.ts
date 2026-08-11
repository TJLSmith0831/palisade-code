import { useCallback, useMemo, useRef, useState } from "react";
import * as api from "../api";
import type { ExecutorEvent, Message, Preflight } from "../api";

export function useExecutor() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [liveBySession, setLiveBySession] = useState<
    Map<string, { threadId: string; events: ExecutorEvent[] }>
  >(new Map());
  const [busyThreads, setBusyThreads] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<{ id: string; message: string }[]>([]);
  const [flight, setFlight] = useState<Preflight | null>(null);
  const [draft, setDraft] = useState("");

  const modelsRef = useRef<
    Record<string, api.ModelState | "loading" | { error: string }>
  >({});
  const [modelsByAgent, setModelsByAgent] = useState<
    Record<string, api.ModelState | "loading" | { error: string }>
  >({});

  const setBusyFor = useCallback((threadId: string, value: boolean) => {
    setBusyThreads((previous) => {
      if (previous.has(threadId) === value) return previous;
      const next = new Set(previous);
      if (value) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
  }, []);

  const clearLiveFor = useCallback((threadId: string) => {
    setLiveBySession((previous) => {
      const next = new Map(previous);
      for (const [id, entry] of next) {
        if (entry.threadId === threadId) next.delete(id);
      }
      return next;
    });
  }, []);

  const addError = useCallback((message: string) => {
    setErrors((prev) => [...prev, { id: crypto.randomUUID(), message }]);
  }, []);

  const dismissError = useCallback((id: string) => {
    setErrors((prev) => prev.filter((e) => e.id !== id));
  }, []);

  return useMemo(
    () => ({
      messages,
      setMessages,
      liveBySession,
      setLiveBySession,
      busyThreads,
      setBusyThreads,
      errors,
      setErrors,
      flight,
      setFlight,
      draft,
      setDraft,
      modelsRef,
      modelsByAgent,
      setModelsByAgent,
      setBusyFor,
      clearLiveFor,
      addError,
      dismissError,
    }),
    [
      messages,
      liveBySession,
      busyThreads,
      errors,
      flight,
      draft,
      modelsByAgent,
      setBusyFor,
      clearLiveFor,
      addError,
      dismissError,
    ]
  );
}

export type Executor = ReturnType<typeof useExecutor>;
