import { useState } from "react";
import { Badge, Loader, NavLink, Stack, Text } from "@mantine/core";
import * as api from "./api";
import type { SessionRecord, SessionStatus, ThreadMeta } from "./api";

// THR-12/THR-13: a sessions-list view distinct from the thread list, showing
// each session's busy/idle state and which agent/provider produced it — the
// Session half of the Thread-vs-Session model (CLAUDE.md), which otherwise
// has no UI surface even though list_sessions/executor_status exist.

type Loaded =
  | { sessions: SessionRecord[]; live: Map<string, SessionStatus> }
  | { error: string }
  | "loading";

function statusOf(session: SessionRecord, live: Map<string, SessionStatus>) {
  const status = live.get(session.id);
  if (status) return status.busy ? "busy" : "idle";
  return session.outcome ?? "ended";
}

export default function SessionsPanel({
  projectHash,
  threads,
}: {
  projectHash: string;
  threads: ThreadMeta[];
}) {
  const [expanded, setExpanded] = useState<Record<string, Loaded>>({});

  const toggle = (thread: ThreadMeta) => {
    if (expanded[thread.id]) {
      setExpanded((current) => {
        const next = { ...current };
        delete next[thread.id];
        return next;
      });
      return;
    }
    setExpanded((current) => ({ ...current, [thread.id]: "loading" }));
    Promise.all([api.listSessions(projectHash, thread.id), api.executorStatus()])
      .then(([sessions, statuses]) =>
        setExpanded((current) => ({
          ...current,
          [thread.id]: { sessions, live: new Map(statuses.map((s) => [s.id, s])) },
        }))
      )
      .catch((e) =>
        setExpanded((current) => ({
          ...current,
          [thread.id]: { error: String(e) },
        }))
      );
  };

  return (
    <div data-testid="sessions-panel">
      {threads.map((thread) => {
        const state = expanded[thread.id];
        return (
          <NavLink
            key={thread.id}
            label={thread.title}
            opened={!!state}
            onClick={() => toggle(thread)}
            data-testid={`sessions-thread-${thread.id}`}
          >
            {state === "loading" && <Loader size="xs" m="xs" />}
            {state && state !== "loading" && "error" in state && (
              <Text size="xs" c="dimmed" p="xs">
                {state.error}
              </Text>
            )}
            {state && state !== "loading" && "sessions" in state && (
              <Stack gap={4} p="xs">
                {state.sessions.length === 0 && (
                  <Text size="xs" c="dimmed">
                    No sessions yet.
                  </Text>
                )}
                {state.sessions.map((session) => (
                  <SessionRow key={session.id} session={session} live={state.live} />
                ))}
              </Stack>
            )}
          </NavLink>
        );
      })}
    </div>
  );
}

function SessionRow({
  session,
  live,
}: {
  session: SessionRecord;
  live: Map<string, SessionStatus>;
}) {
  const status = statusOf(session, live);
  return (
    <NavLink
      data-testid={`session-${session.id}`}
      label={
        <>
          <Text span size="xs" fw={500}>
            {session.agentId}
          </Text>{" "}
          <Text span size="xs" c="dimmed">
            {session.mode}
          </Text>
        </>
      }
      rightSection={
        <Badge size="xs" variant="light" color={status === "busy" ? "blue" : "gray"}>
          {status}
        </Badge>
      }
    />
  );
}
