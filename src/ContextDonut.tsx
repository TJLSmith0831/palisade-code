import { useEffect, useRef, useState } from "react";
import { ActionIcon, Button, Popover, Stack, Text } from "@mantine/core";
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";

export function ContextDonut({
  threadId,
  mode,
  onSession,
}: {
  threadId?: string;
  mode: api.Mode;
  onSession?: (session: api.SessionContext | null) => void;
}) {
  const [session, setSession] = useState<api.SessionContext | null>(null);
  const [opened, setOpened] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = useRef(0);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  const sessionCallback = useRef(onSession);
  sessionCallback.current = onSession;
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    ++scope.current;
    let cancelled = false;
    let sequence = 0;
    setSession(null);
    sessionCallback.current?.(null);
    setError(null);
    setRequesting(false);
    setOpened(false);
    setPinned(false);
    const refresh = async () => {
      const version = ++sequence;
      try {
        const sessions = await api.sessionContexts();
        if (!cancelled && version === sequence) {
          const session =
            sessions
              .filter((s) => s.threadId === threadId && s.mode === mode)
              .sort((a, b) => b.sessionId.localeCompare(a.sessionId))[0] ??
            null;
          setSession(session);
          sessionCallback.current?.(session);
        }
      } catch {
        /* Keep the last agent-reported snapshot during IPC failures. */
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    const unlisten = listen("context-updated", () => void refresh()).catch(
      () => () => {}
    );
    return () => {
      cancelled = true;
      ++scope.current;
      clearInterval(timer);
      void unlisten.then((un) => un());
    };
  }, [threadId, mode]);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    []
  );
  const enter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpened(true);
  };
  const leave = () => {
    closeTimer.current = setTimeout(() => {
      if (!pinnedRef.current) setOpened(false);
    }, 180);
  };
  const used = session?.status.used;
  const size = session?.status.size;
  const known =
    used != null && size != null && size > 0 && used >= 0 && used <= size;
  const percent = known ? Math.round((used / size) * 100) : null;
  const color =
    percent == null
      ? "var(--muted)"
      : percent >= 90
        ? "var(--danger)"
        : percent >= 75
          ? "var(--warn)"
          : "var(--accent)";
  const pending = requesting || session?.status.pending;
  const reason = !session
    ? "Start a conversation to compact context."
    : pending
      ? "Compaction is running."
      : session.busy
        ? "Wait for the current turn to finish."
        : !session.canCompact
          ? "This agent does not advertise manual compaction."
          : null;
  const compact = async () => {
    if (!session || reason) return;
    const version = scope.current;
    setRequesting(true);
    setPinned(true);
    setError(null);
    try {
      await api.compactSession(session.sessionId);
      const sessions = await api.sessionContexts();
      if (version === scope.current)
        setSession(
          sessions.find((s) => s.sessionId === session.sessionId) ?? null
        );
    } catch (err) {
      if (version === scope.current) setError(String(err));
    } finally {
      if (version === scope.current) setRequesting(false);
    }
  };
  return (
    <Popover
      opened={opened}
      onChange={(value) => {
        setOpened(value);
        if (!value) setPinned(false);
      }}
      position="top-end"
      width={260}
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <ActionIcon
          type="button"
          className="ds-context-donut"
          variant="subtle"
          size={28}
          aria-label={
            percent == null
              ? "Context usage unavailable"
              : `Context usage ${percent}%`
          }
          aria-expanded={opened}
          aria-haspopup="dialog"
          onMouseEnter={enter}
          onMouseLeave={leave}
          onFocus={enter}
          onBlur={(event) => {
            if (
              !event.relatedTarget ||
              !(event.relatedTarget as HTMLElement).closest(
                "[data-context-popover]"
              )
            )
              leave();
          }}
          onClick={() => {
            setPinned(!pinned);
            setOpened(!pinned);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpened(false);
              setPinned(false);
            }
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="var(--border)"
              strokeWidth="2"
            />
            <circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke={color}
              strokeWidth="2"
              pathLength="100"
              strokeDasharray={`${percent ?? 0} 100`}
              transform="rotate(-90 8 8)"
            />
          </svg>
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown
        data-context-popover
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocusCapture={enter}
        onBlurCapture={leave}
      >
        <Stack gap={8}>
          <Text size="sm" fw={600}>
            {percent == null
              ? "Context usage unavailable"
              : `${percent}% context used`}
          </Text>
          {known && (
            <Text size="xs">
              {used.toLocaleString()} / {size.toLocaleString()} tokens ·{" "}
              {(size - used).toLocaleString()} remaining
            </Text>
          )}
          {session?.status.updatedAt && (
            <Text size="xs" c="dimmed">
              Last reported{" "}
              {new Date(session.status.updatedAt).toLocaleTimeString()}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            Auto-compaction threshold not reported
          </Text>
          <Button
            size="compact-sm"
            onClick={() => void compact()}
            disabled={!!reason}
            fullWidth
          >
            Compact context
          </Button>
          {reason && (
            <Text size="xs" c="dimmed">
              {reason}
            </Text>
          )}
          <Text size="xs" role="status">
            {error ??
              session?.status.error ??
              (pending
                ? "Compacting…"
                : session?.status.compaction === "completed"
                  ? "Compaction finished. Usage updates when the agent reports it."
                  : "")}
          </Text>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
