import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconArrowBarToDown,
  IconArrowBarUp,
  IconArrowRight,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconX,
} from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";

import * as api from "./api";
import type { DebugAdapterInfo, DebugLaunch, StackFrame, StoppedState, Watch } from "./api";
import { describeError } from "./errors";

type Props = {
  projectHash: string;
  /** The language of the file in focus — what decides which adapter to use. */
  language: string | null;
  /** Jump to a stack frame's source. */
  onOpen?: (path: string, line: number) => void;
  /** Where execution is stopped, so the editor can highlight the line. */
  onStoppedAt?: (path: string | null, line: number | null) => void;
  /** The adapter's verdicts on the project's breakpoints, once a session has
   *  asked for them — the gutter draws "unknown" until it hears back, which
   *  stops being honest the moment an adapter has answered. */
  onBreakpointsChange?: (breakpoints: Record<string, api.Breakpoint[]>) => void;
  /** Every breakpoint in the project, keyed by path — the same state the
   *  editor gutter (DEB-02) toggles. Listed here too: a gutter marker is only
   *  visible in whichever file happens to be open. */
  breakpoints?: Record<string, api.Breakpoint[]>;
};

/**
 * The debugger: breakpoints bind in the editor gutter, this shows what
 * happened when one was hit.
 *
 * Honest about what it doesn't know. An adapter that isn't installed names
 * the binary to install rather than saying "unavailable"; a watch that can't
 * be evaluated shows the reason rather than a stale value; a frame outside
 * the project is shown but marked, because hiding frames makes a call stack
 * lie about how execution got where it is.
 */
export default function DebugPanel({
  projectHash,
  language,
  onOpen,
  onStoppedAt,
  onBreakpointsChange,
  breakpoints = {},
}: Props) {
  const [adapter, setAdapter] = useState<DebugAdapterInfo | null | undefined>(undefined);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [stopped, setStopped] = useState<StoppedState | null>(null);
  const [selectedFrame, setSelectedFrame] = useState<number | null>(null);
  const [watches, setWatches] = useState<string[]>([]);
  const [watchValues, setWatchValues] = useState<Watch[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [launches, setLaunches] = useState<DebugLaunch[]>([]);
  const [launchName, setLaunchName] = useState<string | null>(null);

  useEffect(() => {
    if (!language) {
      setAdapter(null);
      return;
    }
    let cancelled = false;
    api
      .debugAdapter(language)
      .then((found) => !cancelled && setAdapter(found))
      .catch(() => !cancelled && setAdapter(null));
    return () => {
      cancelled = true;
    };
  }, [language]);

  // What Start will actually launch. Derived from the project's `run` map:
  // asking for the same command twice, once to run and once to debug, is how
  // launch.json became something people dread.
  useEffect(() => {
    if (!language) {
      setLaunches([]);
      return;
    }
    let cancelled = false;
    api
      .debugLaunchOptions(projectHash, language)
      .then((options) => !cancelled && setLaunches(options))
      .catch(() => !cancelled && setLaunches([]));
    return () => {
      cancelled = true;
    };
  }, [projectHash, language]);

  useEffect(() => {
    let cancelled = false;
    api
      .debugStatus(projectHash)
      .then((status) => {
        if (cancelled) return;
        setSessionId(status.sessionId);
        setStopped(status.stopped);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectHash]);

  // Through refs so the listeners below are bound once per session rather
  // than re-subscribing on every keystroke in the watch box.
  const watchesRef = useRef(watches);
  watchesRef.current = watches;
  const onStoppedAtRef = useRef(onStoppedAt);
  onStoppedAtRef.current = onStoppedAt;
  const onBreakpointsRef = useRef(onBreakpointsChange);
  onBreakpointsRef.current = onBreakpointsChange;

  const evaluateWatches = useCallback((expressions: string[], frameId: number | undefined) => {
    if (expressions.length === 0) {
      setWatchValues([]);
      return;
    }
    api
      .debugEvaluate(expressions, frameId)
      .then(setWatchValues)
      // A failed batch is reported per-expression by the backend; a failure
      // of the call itself means no session, which the panel already shows.
      .catch(() => setWatchValues([]));
  }, []);

  useEffect(() => {
    const subscriptions = [
      listen<StoppedState>("debug-stopped", ({ payload }) => {
        setStopped(payload);
        setSessionId((current) => current ?? "live");
        const top = payload.frames[0];
        setSelectedFrame(top?.id ?? null);
        onStoppedAtRef.current?.(top?.path ?? null, top?.line ?? null);
        evaluateWatches(watchesRef.current, top?.id);
      }),
      listen("debug-continued", () => {
        // The last stop's stack is not where the program is now, and its
        // frame ids are already invalid — clicking one would evaluate
        // against a frame that no longer exists.
        setStopped(null);
        setSelectedFrame(null);
        setWatchValues([]);
        onStoppedAtRef.current?.(null, null);
      }),
      listen("debug-ended", () => {
        setSessionId(null);
        setStopped(null);
        setSelectedFrame(null);
        setWatchValues([]);
        onStoppedAtRef.current?.(null, null);
      }),
    ];
    return () => {
      subscriptions.forEach((s) => s.then((un) => un()));
    };
  }, [evaluateWatches]);

  const launch = useMemo(
    () => launches.find((l) => l.name === launchName) ?? launches[0] ?? null,
    [launches, launchName]
  );

  const start = useCallback(() => {
    if (!language || !launch) return;
    setStarting(true);
    setError(null);
    api
      .debugStart(projectHash, language, launch.configuration)
      .then((status) => {
        setSessionId(status.sessionId);
        setStopped(status.stopped);
        onBreakpointsRef.current?.(status.breakpoints);
      })
      .catch((err) => {
        // A failed launch must not leave the panel looking live: there is no
        // session, and the reason is the only useful thing here.
        setSessionId(null);
        setError(describeError(err));
      })
      .finally(() => setStarting(false));
  }, [projectHash, language, launch]);

  const stop = useCallback(() => {
    api.debugStop().catch((err) => setError(describeError(err)));
    setSessionId(null);
    setStopped(null);
  }, []);

  const step = useCallback(
    (action: api.DebugAction) => {
      if (!stopped) return;
      api.debugStep(action, stopped.threadId).catch((err) => setError(describeError(err)));
    },
    [stopped]
  );

  const selectFrame = useCallback(
    (frame: StackFrame) => {
      setSelectedFrame(frame.id);
      if (frame.path) onOpen?.(frame.path, frame.line);
      // Watches are frame-scoped: selecting a caller re-reads them there.
      evaluateWatches(watchesRef.current, frame.id);
    },
    [onOpen, evaluateWatches]
  );

  const addWatch = useCallback(() => {
    const expression = draft.trim();
    if (!expression) return;
    setDraft("");
    setWatches((previous) => {
      if (previous.includes(expression)) return previous;
      const next = [...previous, expression];
      if (stopped) evaluateWatches(next, selectedFrame ?? undefined);
      return next;
    });
  }, [draft, stopped, selectedFrame, evaluateWatches]);

  const removeWatch = useCallback((expression: string) => {
    setWatches((previous) => previous.filter((e) => e !== expression));
    setWatchValues((previous) => previous.filter((w) => w.expression !== expression));
  }, []);

  const valueFor = useMemo(
    () => new Map(watchValues.map((w) => [w.expression, w])),
    [watchValues]
  );

  // Flattened across every file so the list doesn't care which tab is open —
  // the gutter marker (DEB-02's toggle) is the source of truth, this just
  // shows all of it at once.
  const breakpointEntries = useMemo(
    () =>
      Object.entries(breakpoints)
        .flatMap(([path, list]) => list.map((b) => ({ ...b, path })))
        .sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path))),
    [breakpoints]
  );

  const live = sessionId != null;
  const canStart = adapter?.installed === true && launch != null && !live && !starting;

  return (
    <Stack gap="xs" p="xs">
      <Group gap={4}>
        {live ? (
          <Tooltip label="Stop debugging" withinPortal>
            <ActionIcon
              variant="subtle"
              size="sm"
              color="red"
              aria-label="Stop debugging"
              onClick={stop}
              data-testid="debug-stop"
            >
              <IconPlayerStop size={14} />
            </ActionIcon>
          </Tooltip>
        ) : (
          <Button
            size="compact-xs"
            variant="light"
            leftSection={<IconPlayerPlay size={12} />}
            disabled={!canStart}
            loading={starting}
            onClick={start}
            data-testid="debug-start"
          >
            Start
          </Button>
        )}
        <Tooltip label="Continue" withinPortal>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="Continue"
            disabled={!stopped}
            onClick={() => step("continue")}
            data-testid="debug-continue"
          >
            <IconPlayerPlay size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Step over" withinPortal>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="Step over"
            disabled={!stopped}
            onClick={() => step("stepOver")}
            data-testid="debug-step-over"
          >
            <IconArrowRight size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Step into" withinPortal>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="Step into"
            disabled={!stopped}
            onClick={() => step("stepIn")}
            data-testid="debug-step-in"
          >
            <IconArrowBarToDown size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Step out" withinPortal>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="Step out"
            disabled={!stopped}
            onClick={() => step("stepOut")}
            data-testid="debug-step-out"
          >
            <IconArrowBarUp size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {error && (
        <Alert color="danger" variant="light" onClose={() => setError(null)} withCloseButton>
          {error}
        </Alert>
      )}

      {adapter === null && (
        <Text size="xs" c="dimmed" data-testid="debug-no-adapter">
          {language
            ? `Palisade knows no debug adapter for ${language}.`
            : "Open a file to debug."}
        </Text>
      )}

      {adapter && !adapter.installed && (
        <Alert color="yellow" variant="light">
          {/* "Unavailable" with no reason is a dead end; the binary is the
              actionable part. Palisade finds a debugger, it never installs one. */}
          <Text size="xs">
            No debug adapter for {adapter.language} on this machine. Palisade looks for{" "}
            <Code>{adapter.command}</Code> on your PATH.
          </Text>
        </Alert>
      )}

      {!live && adapter?.installed && launches.length > 1 && (
        <Select
          size="xs"
          aria-label="What to debug"
          data={launches.map((l) => l.name)}
          value={launch?.name ?? null}
          onChange={setLaunchName}
          data-testid="debug-launch-select"
        />
      )}

      {!live && adapter?.installed && launch && (
        <Text size="xs" c="dimmed" data-testid="debug-idle">
          {"Not running. Set a breakpoint in the gutter, then Start — this debugs "}
          <Code fz="10px">{launch.command}</Code>.
        </Text>
      )}

      {!live && adapter?.installed && launches.length === 0 && (
        <Text size="xs" c="dimmed" data-testid="debug-nothing-to-launch">
          {"Nothing here can be debugged yet. Add a `run` command that starts "}
          {"this project to "}
          <Code fz="10px">.palisade/project-settings.json</Code>
          {" — the debugger launches whatever Run does."}
        </Text>
      )}

      {live && !stopped && (
        <Text size="xs" c="dimmed" data-testid="debug-running">
          Running.
        </Text>
      )}

      {stopped && (
        <>
          <Group gap="xs">
            <Badge size="xs" color="orange" variant="light">
              {stopped.reason}
            </Badge>
            {stopped.description && (
              <Text size="10px" c="dimmed">
                {stopped.description}
              </Text>
            )}
          </Group>

          <div>
            <h2 className="ds-section-heading">Call stack</h2>
            <Stack gap={0}>
              {stopped.frames.map((frame) => (
                <div
                  key={frame.id}
                  className={`ds-debug-frame${selectedFrame === frame.id ? " is-selected" : ""}${
                    frame.isLibrary ? " is-library" : ""
                  }`}
                  data-testid={`debug-frame-${frame.id}`}
                  data-library={String(frame.isLibrary)}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectFrame(frame)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") selectFrame(frame);
                  }}
                >
                  <Text span size="xs" className="ds-debug-frame-name">
                    {frame.name}
                  </Text>
                  <Text span size="10px" c="dimmed">
                    {frame.path ? `${frame.path}:${frame.line}` : "no source"}
                  </Text>
                </div>
              ))}
            </Stack>
          </div>
        </>
      )}

      <div>
        <h2 className="ds-section-heading">Breakpoints</h2>
        {breakpointEntries.length === 0 ? (
          <Text size="xs" c="dimmed" data-testid="debug-breakpoints-empty">
            No breakpoints set. Click a line number in the gutter to add one.
          </Text>
        ) : (
          <Stack gap={0}>
            {breakpointEntries.map((bp) => (
              <div
                key={`${bp.path}:${bp.line}`}
                className="ds-debug-frame"
                data-testid={`debug-breakpoint-${bp.path}:${bp.line}`}
                role="button"
                tabIndex={0}
                onClick={() => onOpen?.(bp.path, bp.line)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onOpen?.(bp.path, bp.line);
                }}
              >
                <Text span size="xs" className="ds-debug-frame-name">
                  {bp.path}:{bp.line}
                </Text>
                {!bp.enabled && (
                  <Text span size="10px" c="dimmed">
                    disabled
                  </Text>
                )}
              </div>
            ))}
          </Stack>
        )}
      </div>

      <div>
        <h2 className="ds-section-heading">Watch</h2>
        <Group gap={4} wrap="nowrap">
          <TextInput
            size="xs"
            flex={1}
            placeholder="Expression"
            aria-label="Watch expression"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addWatch();
            }}
            data-testid="debug-watch-input"
          />
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="Add watch"
            onClick={addWatch}
            data-testid="debug-watch-add"
          >
            <IconPlus size={14} />
          </ActionIcon>
        </Group>
        <Stack gap={0} mt={4}>
          {watches.map((expression) => {
            const result = valueFor.get(expression);
            return (
              <div
                key={expression}
                className="ds-debug-watch"
                data-testid={`debug-watch-row-${expression}`}
              >
                <Text span size="xs" className="ds-debug-watch-name">
                  {expression}
                </Text>
                {result?.error ? (
                  // The reason replaces the value; a stale number beside a
                  // failed evaluation is worse than no number.
                  <Text span size="10px" c="orange">
                    {result.error}
                  </Text>
                ) : (
                  <Text span size="10px" c="dimmed" data-testid={`debug-watch-${expression}`}>
                    {result?.value ?? (stopped ? "…" : "not running")}
                    {result?.type ? ` (${result.type})` : ""}
                  </Text>
                )}
                <ActionIcon
                  variant="subtle"
                  size="xs"
                  aria-label={`Remove watch ${expression}`}
                  onClick={() => removeWatch(expression)}
                  data-testid={`debug-watch-remove-${expression}`}
                >
                  <IconX size={11} />
                </ActionIcon>
              </div>
            );
          })}
        </Stack>
      </div>
    </Stack>
  );
}
