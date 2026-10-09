import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import AccountSignIn from "./AccountSignIn";
import * as api from "./api";
import { bindProfileStorage, hasImportedPreferences } from "./profileStorage";
import { errorMessage } from "./errors";
import wordmark from "../assets/palisade-wordmark-darkmode-no-bg.png";
import lightWordmark from "../assets/palisade-wordmark-lightmode-no-bg.png";
import "./AccountGate.css";

export const AccountSettingsContext = createContext<ReactNode>(null);

const permitted = (status: api.AccountStatus | null) =>
  status?.state === "online" || status?.state === "offline";
export default function AccountGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<api.AccountStatus | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [stage, setStage] = useState<"sign-in" | "waiting" | "error">(
    "sign-in"
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const attempt = useRef(0);
  const setup = useRef(false);
  const accept = useCallback(async (next: api.AccountStatus) => {
    setRestricted(false);
    setStatus(next);
    if (!permitted(next) || !next.profileKey) return;
    if (next.workspaceReady) {
      bindProfileStorage(next.profileKey);
      setMounted(true);
    } else if (!next.legacyAvailable && !setup.current) {
      setup.current = true;
      try {
        const ready = await api.accountPrepareWorkspace(false);
        bindProfileStorage(next.profileKey);
        setStatus(ready);
        setMounted(true);
      } finally {
        setup.current = false;
      }
    }
  }, []);
  const update = useCallback(
    async (refresh = false) => {
      try {
        await accept(
          await (refresh ? api.accountRefresh() : api.accountStatus())
        );
      } catch (failure) {
        setRestricted(true);
        setError(errorMessage(failure));
      }
    },
    [accept]
  );
  useEffect(() => {
    let live = true;
    void api
      .accountStatus()
      .then(async (next) => {
        if (!live) return;
        await accept(next);
        if (next.identity) void update(true);
      })
      .catch((failure) => {
        if (live) setError(errorMessage(failure));
      });
    const transition = listen<boolean>(
      "account-restart-state",
      (event) => setFrozen(event.payload),
      { target: getCurrentWindow().label }
    );
    const timer = window.setInterval(() => void update(), 30_000);
    const refreshTimer = window.setInterval(
      () => void update(true),
      15 * 60_000
    );
    const resume = () => void update(true);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    return () => {
      void transition.then((off) => off());
      live = false;
      window.clearInterval(timer);
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
    };
  }, [accept, update]);
  useEffect(() => {
    document.querySelector<HTMLElement>(".account-preview h1")?.focus();
  }, [stage, status?.state]);
  async function start() {
    const current = ++attempt.current;
    setError("");
    setStage("waiting");
    try {
      await api.accountBeginSignIn();
      if (attempt.current === current) {
        await update();
        setStage("sign-in");
      }
    } catch (failure) {
      if (attempt.current === current) {
        setError(errorMessage(failure));
        setStage("error");
      }
    }
  }
  async function cancel() {
    attempt.current++;
    try {
      await api.accountCancelSignIn();
      setStage("sign-in");
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }
  async function prepare(importLegacy: boolean) {
    if (!status?.profileKey) return;
    setBusy(true);
    setError("");
    try {
      bindProfileStorage(status.profileKey, importLegacy);
      const ready = await api.accountPrepareWorkspace(importLegacy);
      await accept(ready);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  const signIn = (
    <AccountSignIn
      stage={stage}
      onStart={() => void start()}
      onCancel={() => void cancel()}
      onReopen={() =>
        void api
          .accountReopenSignIn()
          .catch((failure) => setError(errorMessage(failure)))
      }
      error={error}
      onManageBrowserAccount={() =>
        void api
          .accountOpenBrowserAccount()
          .catch((failure) => setError(errorMessage(failure)))
      }
      notice={status?.message ?? undefined}
    />
  );
  const ready =
    !restricted && permitted(status) && status?.workspaceReady === true;
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("palisade-account-access", { detail: ready })
    );
  }, [ready]);
  const account = (
    <Stack className="account-settings" gap="md">
      <Group wrap="nowrap" align="center">
        <Avatar src={status?.identity?.picture} radius="xl" size={44} alt="" />
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Text fw={600} style={{ overflowWrap: "anywhere" }}>
            {status?.identity?.name || "Your Palisade account"}
          </Text>
          <Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>
            {status?.identity?.email}
          </Text>
        </Stack>
        <Badge variant="light">
          {status?.state === "online" ? "Connected" : "Offline"}
        </Badge>
      </Group>
      <Text size="sm" c="dimmed">
        Your projects, conversations and preferences stay in this local profile.
      </Text>
      {status?.offlineUntil && (
        <Text size="sm" c="dimmed">
          Offline access until{" "}
          {new Date(status.offlineUntil * 1000).toLocaleString()}.
        </Text>
      )}
      <Text size="sm" c="dimmed">
        Signing out restarts Palisade. Your browser may still remember your
        account; use Open browser account on the sign-in screen to sign out
        there before choosing another. Stop running work first; every window
        will ask about unsaved changes.
      </Text>
      {error && (
        <Alert color="danger" title="Account action failed">
          {error}
        </Alert>
      )}
      <Group>
        <Button
          variant="default"
          onClick={() =>
            void api
              .accountStopWork()
              .catch((failure) => setError(errorMessage(failure)))
          }
        >
          Stop running work
        </Button>
        <Button
          variant="default"
          onClick={() =>
            void api
              .accountRequestRestart()
              .catch((failure) => setError(errorMessage(failure)))
          }
        >
          Sign out and restart
        </Button>
      </Group>
    </Stack>
  );
  return (
    <>
      {mounted && (
        <div inert={!ready || frozen}>
          <AccountSettingsContext.Provider value={account}>
            {children}
          </AccountSettingsContext.Provider>
        </div>
      )}
      {(!mounted || !ready) && (
        <main
          className="account-preview"
          style={
            mounted ? { position: "fixed", inset: 0, zIndex: 1000 } : undefined
          }
        >
          <div className="account-preview-content">
            <header className="account-brand">
              <picture>
                <source
                  media="(prefers-color-scheme: light)"
                  srcSet={lightWordmark}
                />
                <img src={wordmark} alt="Palisade" />
              </picture>
            </header>
            {!status && !error ? (
              <Stack align="center" gap="lg">
                <Loader aria-label="Restoring account" />
                <Text>Restoring your account</Text>
                <Text c="dimmed">
                  If macOS asks, allow Palisade to read its saved credential.
                </Text>
              </Stack>
            ) : permitted(status) && !status?.workspaceReady ? (
              <Paper className="account-card" withBorder radius="lg">
                <Stack gap="xl">
                  <Title order={1}>Make this workspace yours</Title>
                  <Text>
                    Import your existing projects, conversations and
                    preferences, or start with an empty profile. Import keeps
                    the original and a recovery copy. If an import is
                    interrupted, choose Import again to finish it safely.
                  </Text>
                  {error && <Alert color="danger">{error}</Alert>}
                  <Button loading={busy} onClick={() => void prepare(true)}>
                    Import existing workspace
                  </Button>
                  <Button
                    disabled={
                      busy ||
                      (!!status?.profileKey &&
                        hasImportedPreferences(status.profileKey))
                    }
                    variant="default"
                    onClick={() => void prepare(false)}
                  >
                    Start fresh
                  </Button>
                </Stack>
              </Paper>
            ) : (
              <Stack gap="lg">
                {mounted && (
                  <Alert color="warn" title="Account access needs attention">
                    Your open buffers and output are preserved. Sign in to
                    resume new work.
                    <Group mt="md">
                      <Button
                        variant="default"
                        onClick={() => {
                          const promises: Promise<void>[] = [];
                          window.dispatchEvent(
                            new CustomEvent("palisade-account-save-all", {
                              detail: { promises },
                            })
                          );
                          void Promise.all(promises).catch((failure) =>
                            setError(errorMessage(failure))
                          );
                        }}
                      >
                        Save open files
                      </Button>
                      <Button
                        variant="default"
                        onClick={() =>
                          void api
                            .accountStopWork()
                            .catch((failure) => setError(errorMessage(failure)))
                        }
                      >
                        Stop running work
                      </Button>
                      <Button
                        variant="default"
                        onClick={() =>
                          void api
                            .accountRequestRestart()
                            .catch((failure) => setError(errorMessage(failure)))
                        }
                      >
                        Sign out and restart
                      </Button>
                    </Group>
                  </Alert>
                )}
                {error && stage !== "error" && (
                  <Alert color="danger">{error}</Alert>
                )}
                {signIn}
              </Stack>
            )}
          </div>
        </main>
      )}
      {frozen && ready && (
        <Alert
          title="Preparing account restart"
          style={{
            position: "fixed",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
          }}
        >
          Waiting for every window to settle its unsaved work.{" "}
          <Button
            variant="subtle"
            onClick={() =>
              void api
                .accountCancelRestart()
                .catch((failure) => setError(errorMessage(failure)))
            }
          >
            Cancel restart
          </Button>
        </Alert>
      )}
    </>
  );
}
