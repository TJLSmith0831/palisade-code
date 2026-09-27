import { ActionIcon, Button, Group, Loader, Stack, Text, TextInput, Tooltip } from "@mantine/core";
import {
  IconArrowLeft,
  IconArrowRight,
  IconExternalLink,
  IconPlugConnectedX,
  IconRefresh,
  IconWorld,
} from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import { overlayCovers, punchHole } from "./nativeOverlay";

type Props = {
  /** The project this preview belongs to: each has its own browser and its
   * own cookies and storage. */
  projectHash: string;
  /** The URL to show, or null before anything has been navigated to. */
  url: string | null;
  /** Called when the user submits a new URL in the address bar. */
  onNavigate: (url: string) => void;
};

/** `localhost:5173` -> `http://localhost:5173`, so the address bar accepts
 * what people actually type. */
const normalize = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
};

/** Loopback addresses, the ones `preview_probe` will check. */
const isLocal = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host.endsWith(".localhost") || ["127.0.0.1", "[::1]", "0.0.0.0"].includes(host);
  } catch {
    return false;
  }
};

/** How often to look again while a local server isn't answering — it is
 * usually just still starting. */
const RETRY_MS = 2000;

const sameBounds = (a: api.PreviewBounds, b: api.PreviewBounds) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * A browser, shown inline.
 *
 * The page lives in a native webview the backend parks over the placeholder
 * below (`preview_cmds.rs`) — not an iframe — so sites that forbid framing
 * load, logins and popups work, and the page keeps its own history. The
 * webview outlives this component: switching away hides it, coming back shows
 * the same page. Closing the tab ends it (`App` calls `previewClose`).
 */
export default function PreviewPane({ projectHash, url, onNavigate }: Props) {
  const [draft, setDraft] = useState(url ?? "");
  const [page, setPage] = useState<api.PreviewState | null>(null);
  // Why nothing answers at `url`, or null when something does. A native view
  // shows a refused connection as a blank white page and says nothing, so a
  // local URL is probed first and an error shown here instead.
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const blocked = useRef(false);
  blocked.current = unreachable !== null;
  const hostRef = useRef<HTMLDivElement>(null);

  const measure = (): api.PreviewBounds | null => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };

  // Show (or navigate) the native view whenever the target URL changes — or,
  // for a local URL that isn't answering, an error until it does.
  useEffect(() => {
    if (!url) {
      setUnreachable(null);
      void api.previewHide(projectHash).catch(() => {});
      return;
    }
    let live = true;
    const show = () => {
      const bounds = measure();
      if (bounds) void api.previewOpen(projectHash, url, bounds).catch(() => {});
    };
    if (!isLocal(url)) {
      setUnreachable(null);
      show();
      return;
    }
    api
      .previewProbe(url)
      .then((reason) => {
        if (!live) return;
        setUnreachable(reason);
        if (reason) void api.previewHide(projectHash).catch(() => {});
        else show();
      })
      // A probe that cannot run (a host that will not resolve, a bridge
      // hiccup) is not evidence the server is down: show the view, as the
      // backend's own rule says unprobeable URLs count as reachable.
      // Clearing the error alone left an empty pane with no retry.
      .catch(() => {
        if (!live) return;
        setUnreachable(null);
        show();
      });
    return () => {
      live = false;
    };
  }, [projectHash, url, attempt]);

  // While a local server isn't answering, look again — it is usually still starting.
  useEffect(() => {
    if (unreachable === null) return;
    const timer = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
    return () => clearTimeout(timer);
  }, [unreachable, attempt]);

  // Follow the placeholder. A layout change elsewhere (a sidebar toggling)
  // moves it without resizing it, which a ResizeObserver never reports, so
  // compare its rect once per frame instead. The app's webview is see-through
  // over the placeholder (`punchHole`), so the native view shows whether it
  // sits in front (taking clicks) or behind (while a tooltip, menu or dialog
  // overlaps it, so that overlay draws on top) — the same loop flips which.
  // ponytail: per-frame rect check, upgrade if profiling ever shows it.
  useEffect(() => {
    let last: api.PreviewBounds | null = null;
    let lastTheme = "";
    let covered = false;
    let unpunch = () => {};
    let frame = requestAnimationFrame(function tick() {
      const next = measure();
      if (next && url && !blocked.current) {
        // A theme or accent-hue switch changes the colours the hole is cut from.
        const root = document.documentElement;
        const theme = `${root.dataset.theme}|${root.style.cssText}|${matchMedia?.("(prefers-color-scheme: dark)").matches}`;
        if (!last || !sameBounds(last, next) || theme !== lastTheme) {
          last = next;
          lastTheme = theme;
          unpunch();
          unpunch = hostRef.current ? punchHole(hostRef.current, next) : () => {};
          void api.previewBounds(projectHash, next).catch(() => {});
        }
        const nowCovered = overlayCovers(next);
        if (nowCovered !== covered) {
          covered = nowCovered;
          void api.previewLayer(projectHash, !covered).catch(() => {});
        }
      } else if (last) {
        last = null;
        covered = false;
        unpunch();
        unpunch = () => {};
      }
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      unpunch();
    };
  }, [projectHash, url]);

  // Leaving the tab hides the view; the page stays alive behind it.
  useEffect(
    () => () => {
      void api.previewHide(projectHash).catch(() => {});
    },
    [projectHash]
  );

  useEffect(() => {
    setPage(null);
    const off = listen<api.PreviewState>("preview-state", ({ payload }) => {
      // Another project's browser keeps loading in the background.
      if (payload.projectHash !== projectHash) return;
      setPage((prior) => ({ ...payload, title: payload.title ?? prior?.title ?? null }));
    });
    return () => void off.then((un) => un());
  }, [projectHash]);

  // The address bar shows where the page actually is (redirects, links
  // clicked inside it), falling back to what we asked for.
  const shown = page?.url || url || "";
  useEffect(() => setDraft(shown), [shown]);

  const submit = () => {
    const next = normalize(draft);
    if (next && next !== url) onNavigate(next);
    else if (next) reload();
  };

  const reload = () => {
    if (unreachable !== null) setAttempt((n) => n + 1);
    else void api.previewReload(projectHash).catch(() => {});
  };

  return (
    <div
      className="ds-preview-pane"
      data-testid="preview-pane"
      // `overflow: hidden` and `minWidth: 0`: a squeezed column must clip the
      // toolbar, never let it spill over the panel beside it.
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden" }}
    >
      {/* Wraps: in a narrow column the address bar drops to its own row
          instead of shrinking to nothing beside three buttons. */}
      <Group gap={4} p="xs" wrap="wrap" className="ds-preview-toolbar">
        <Tooltip label="Back" position="top" withinPortal>
          <ActionIcon
            variant="subtle"
            aria-label="Back"
            data-testid="preview-back"
            disabled={!url}
            onClick={() => void api.previewHistory(projectHash, -1).catch(() => {})}
          >
            <IconArrowLeft size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Forward" position="top" withinPortal>
          <ActionIcon
            variant="subtle"
            aria-label="Forward"
            data-testid="preview-forward"
            disabled={!url}
            onClick={() => void api.previewHistory(projectHash, 1).catch(() => {})}
          >
            <IconArrowRight size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Reload" position="top" withinPortal>
          <ActionIcon
            variant="subtle"
            aria-label="Reload"
            data-testid="preview-reload"
            disabled={!url}
            onClick={reload}
          >
            <IconRefresh size={16} />
          </ActionIcon>
        </Tooltip>
        <TextInput
          size="xs"
          className="ds-preview-address"
          style={{ flex: "1 1 160px", minWidth: 0 }}
          placeholder="localhost:5173"
          aria-label="Preview URL"
          data-testid="preview-url"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          rightSection={page?.loading ? <Loader size={12} data-testid="preview-loading" /> : null}
        />
        <Tooltip label="Open in browser" position="top" withinPortal>
          <ActionIcon
            variant="subtle"
            aria-label="Open in browser"
            className="ds-preview-external"
            data-testid="preview-external"
            disabled={!url}
            onClick={() => void openUrl(shown || (url as string))}
          >
            <IconExternalLink size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {/* The native webview is drawn over this box; when there is no URL the
          box shows the empty state instead. */}
      <div
        ref={hostRef}
        data-testid={url ? "preview-frame" : "preview-empty"}
        title={page?.title ?? undefined}
        style={{ flex: 1, minHeight: 0 }}
      >
        {!url && (
          <Group justify="center" gap="xs" style={{ height: "100%" }}>
            <IconWorld size={16} stroke={1.5} opacity={0.5} />
            <Text size="sm" c="dimmed">
              Enter a URL, or start a dev server.
            </Text>
          </Group>
        )}
        {url && unreachable !== null && (
          <Stack align="center" justify="center" gap="xs" p="md" style={{ height: "100%" }} data-testid="preview-unreachable">
            <IconPlugConnectedX size={22} stroke={1.5} opacity={0.6} />
            <Text size="sm" fw={600}>
              Can't reach {new URL(url).host}
            </Text>
            <Group gap={6} wrap="nowrap" title={unreachable}>
              <Loader size={10} />
              <Text size="xs" c="dimmed">
                Nothing is listening yet. Retrying…
              </Text>
            </Group>
            <Button size="compact-xs" variant="light" onClick={reload} data-testid="preview-retry">
              Try again
            </Button>
          </Stack>
        )}
      </div>
    </div>
  );
}
