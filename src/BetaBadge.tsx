/**
 * The beta affordance in the titlebar: what version you're running, whether
 * an update is waiting, and the way to report a bug.
 *
 * Deliberately one component. All three concerns are the same thing from a
 * tester's side — "this is prerelease software, here's how you deal with
 * it" — and keeping them together is what lets App.tsx take a one-line diff.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Modal,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { IconBug } from "@tabler/icons-react";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import * as api from "./api";
import { sendFeedback } from "./feedback";
import { setModelInstalling } from "./completion/GhostTextPlugin";

/** Re-check this often while the app stays open. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

type ModelProgress = { stage: string; done: number; total: number };

export default function BetaBadge() {
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [modelProgress, setModelProgress] = useState<ModelProgress | null>(null);

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(""));
  }, []);

  // An update check that fails is not worth telling a tester about: they
  // cannot act on it, and it fires again in half an hour.
  useEffect(() => {
    let cancelled = false;
    const look = () =>
      check()
        .then((found) => {
          if (!cancelled) setUpdate(found);
        })
        .catch(() => {});
    look();
    const timer = setInterval(look, CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // The model install runs on first launch and after a model upgrade. It is
  // the one thing here that blocks a feature, so it gets a progress bar.
  useEffect(() => {
    const un = listen<ModelProgress>("model-install", ({ payload }) => {
      const ready = payload.stage === "ready";
      setModelProgress(ready ? null : payload);
      setModelInstalling(!ready);
    });
    return () => {
      un.then((off) => off());
    };
  }, []);

  const install = useCallback(async () => {
    if (!update) return;
    setInstalling(true);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch {
      // Leave the badge in its update-ready state: the tester can retry, and
      // a half-applied update is the one case where saying nothing is wrong.
      setInstalling(false);
    }
  }, [update]);

  const submit = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      const diagnostics = await api.collectDiagnostics().catch(() => null);
      const result = await sendFeedback(title.trim(), body.trim(), diagnostics);
      setSent(result.url);
      setTitle("");
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [title, body]);

  const close = useCallback(() => {
    setOpen(false);
    setSent(null);
    setError(null);
  }, []);

  return (
    <>
      <Group gap="xs" data-tauri-drag-region-exclude data-testid="beta-controls">
        {update ? (
          <Tooltip label={`Version ${update.version} is ready to install`}>
            <Button
              size="compact-xs"
              variant="light"
              color="accent"
              loading={installing}
              onClick={install}
              data-testid="restart-to-update"
            >
              Restart &amp; update
            </Button>
          </Tooltip>
        ) : (
          <Tooltip
            label={
              modelProgress
                ? "Setting up the AI model — the app is usable meanwhile"
                : `Prerelease build${version ? ` · ${version}` : ""}`
            }
          >
            <Badge
              size="sm"
              variant="light"
              color="warn"
              data-testid="beta-badge"
            >
              {modelProgress
                ? `Beta · setting up${
                    modelProgress.total > 0
                      ? ` · ${Math.round((modelProgress.done / modelProgress.total) * 100)}%`
                      : ""
                  }`
                : "Beta"}
            </Badge>
          </Tooltip>
        )}
        <Tooltip label="Bug Report / Feature Request">
          <ActionIcon
            variant="subtle"
            className="ds-icon-btn"
            onClick={() => setOpen(true)}
            aria-label="Bug Report / Feature Request"
            data-testid="open-feedback"
          >
            <IconBug size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Modal
        opened={open}
        onClose={close}
        title="Bug Report / Feature Request"
        data-testid="feedback-modal"
      >
        {sent ? (
          <Stack gap="sm">
            <Text size="sm">Thanks — that's filed. Nothing else needed.</Text>
            <Text size="xs" c="dimmed">
              {sent}
            </Text>
            <Group justify="flex-end">
              <Button size="xs" onClick={close}>
                Done
              </Button>
            </Group>
          </Stack>
        ) : (
          <Stack gap="sm">
            <TextInput
              label="What happened?"
              placeholder="Editor froze when I opened a second thread"
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              data-testid="feedback-title"
            />
            <Textarea
              label="Any detail you can add"
              description="What you were doing, and what you expected instead."
              rows={4}
              value={body}
              onChange={(event) => setBody(event.currentTarget.value)}
              data-testid="feedback-body"
            />
            <Text size="xs" c="dimmed">
              Your app version, macOS version, and which agents are installed
              are attached automatically. No file contents are sent.
            </Text>
            {error && (
              <Text size="xs" c="danger" data-testid="feedback-error">
                {error}
              </Text>
            )}
            <Group justify="flex-end">
              <Button size="xs" variant="subtle" onClick={close}>
                Cancel
              </Button>
              <Button
                size="xs"
                loading={sending}
                disabled={!title.trim()}
                onClick={submit}
                data-testid="send-feedback"
              >
                Send
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
