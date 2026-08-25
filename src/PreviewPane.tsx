import { ActionIcon, Group, Text, TextInput, Tooltip } from "@mantine/core";
import { IconExternalLink, IconRefresh, IconWorld } from "@tabler/icons-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";

type Props = {
  /** The URL to show, or null before anything has been navigated to. */
  url: string | null;
  /** Called when the user submits a new URL in the address bar. */
  onNavigate: (url: string) => void;
};

/** ponytail: fixed 4s guess — tune once real dev servers have been watched. */
const LOAD_TIMEOUT_MS = 4000;

/** `localhost:5173` -> `http://localhost:5173`, so the address bar accepts
 * what people actually type. */
const normalize = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
};

/**
 * A local URL, shown inline.
 *
 * No back/forward history (D4) and no programmatic detection of framing
 * failures — WKWebView gives no signal for X-Frame-Options/CSP blocks, so
 * the external-open button is always present and a passive hint appears if
 * the frame hasn't loaded in time (D8).
 */
export default function PreviewPane({ url, onNavigate }: Props) {
  const [draft, setDraft] = useState(url ?? "");
  // Bumped on reload to remount the iframe — the only way to re-fetch a
  // cross-origin frame without touching its contentWindow.
  const [reloadKey, setReloadKey] = useState(0);
  const [slow, setSlow] = useState(false);
  // Separate from `slow`: the timer fires whether or not the frame already
  // loaded, so "did it load" has to be its own fact.
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-detection (D9) navigates the tab from outside, so the address bar
  // follows the URL rather than owning it.
  useEffect(() => setDraft(url ?? ""), [url]);

  useEffect(() => {
    if (!url) return;
    setSlow(false);
    setLoaded(false);
    const timer = setTimeout(() => setSlow(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [url, reloadKey]);

  const submit = () => {
    const next = normalize(draft);
    if (next && next !== url) onNavigate(next);
    else if (next) setReloadKey((k) => k + 1);
  };

  return (
    <div
      className="ds-preview-pane"
      data-testid="preview-pane"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <Group gap="xs" p="xs" wrap="nowrap">
        <TextInput
          ref={inputRef}
          size="xs"
          style={{ flex: 1 }}
          placeholder="localhost:5173"
          aria-label="Preview URL"
          data-testid="preview-url"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        <Tooltip label="Reload" withinPortal>
          <ActionIcon
            variant="subtle"
            aria-label="Reload"
            data-testid="preview-reload"
            disabled={!url}
            onClick={() => setReloadKey((k) => k + 1)}
          >
            <IconRefresh size={16} />
          </ActionIcon>
        </Tooltip>
        {/* Always visible, never conditional on detecting a failure (D8). */}
        <Tooltip label="Open in browser" withinPortal>
          <ActionIcon
            variant="subtle"
            aria-label="Open in browser"
            data-testid="preview-external"
            disabled={!url}
            onClick={() => url && void openUrl(url)}
          >
            <IconExternalLink size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>

      {slow && !loaded && url && (
        <Text size="xs" c="dimmed" px="xs" pb="xs" data-testid="preview-slow-hint">
          Not loading? Open externally.
        </Text>
      )}

      {url ? (
        <iframe
          key={`${url}#${reloadKey}`}
          src={url}
          title="Preview"
          data-testid="preview-frame"
          onLoad={() => {
            setLoaded(true);
            setSlow(false);
          }}
          // Deliberately outside the app palette: this is the previewed
          // page's canvas, not app chrome, and a page that paints no
          // background must not inherit Palisade's dark surface.
          style={{ flex: 1, border: "none", background: "#fff", minHeight: 0 }}
        />
      ) : (
        <Group
          justify="center"
          gap="xs"
          style={{ flex: 1 }}
          data-testid="preview-empty"
        >
          <IconWorld size={16} opacity={0.5} />
          <Text size="sm" c="dimmed">
            Enter a URL, or start a dev server.
          </Text>
        </Group>
      )}
    </div>
  );
}
