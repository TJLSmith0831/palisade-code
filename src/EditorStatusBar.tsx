import { useEffect, useState } from "react";
import { Menu, Tooltip } from "@mantine/core";
import { IconBraces, IconDownload, IconSparkles } from "@tabler/icons-react";
import * as api from "./api";
import type { LspStatus } from "./api";
import { describeError } from "./errors";
import { stateLabel, stateTone } from "./lsp";
import {
  COMPLETION_SETTINGS_CHANGED_EVENT,
  loadCompletionSettings,
  persistCompletionEnabled,
} from "./completion/GhostTextPlugin";

// Amendment 2's status surface. D14 requires that a server which is
// missing, starting, crashing or disabled says so somewhere the user can
// see — this bar is that somewhere. The dot is never the only signal: the
// state is always spelled out in the label beside it.

export default function EditorStatusBar({
  language,
  lsp,
  cursor,
}: {
  /** Display name for the file's language, e.g. "TypeScript". */
  language: string | null;
  lsp: LspStatus | null;
  /** 1-based, from the open editor. Absent when no file is open. */
  cursor?: { line: number; col: number } | null;
}) {
  const tone = stateTone(lsp?.state ?? null);
  const label = stateLabel(lsp);

  // Amendment 4: FIM already worked, it was just invisible — buried in
  // Settings with no in-editor sign of whether it was on. Same persistence
  // path as the Settings switch, so the two can never disagree.
  const [fim, setFim] = useState(() => loadCompletionSettings().enabled);
  useEffect(() => {
    const sync = () => setFim(loadCompletionSettings().enabled);
    window.addEventListener(COMPLETION_SETTINGS_CHANGED_EVENT, sync);
    return () =>
      window.removeEventListener(COMPLETION_SETTINGS_CHANGED_EVENT, sync);
  }, []);

  // A missing server used to be a sentence telling the user to go install
  // something. Palisade still bundles nothing (D6) — but it knows the one command
  // for each of the languages it promises, and the toolchain to run it with is
  // already on the machine, so the sentence may as well be the button.
  const lspLanguage = lsp?.language ?? null;
  const missing = lsp?.state === "notInstalled";
  const [installCmd, setInstallCmd] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    setInstallCmd(null);
    setInstallError(null);
    setInstalled(false);
    if (!missing || !lspLanguage) return;
    let cancelled = false;
    api
      .lspInstallCommand(lspLanguage)
      .then((cmd) => {
        if (!cancelled) setInstallCmd(cmd);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [missing, lspLanguage]);

  const install = () => {
    if (!lspLanguage || installing) return;
    setInstalling(true);
    setInstallError(null);
    api
      .lspInstall(lspLanguage)
      // The server is spawned from the file's first open, so the new binary
      // is picked up on reopen rather than mid-buffer.
      .then(() => setInstalled(true))
      .catch((err) => setInstallError(describeError(err)))
      .finally(() => setInstalling(false));
  };

  return (
    <div className="ds-editor-status" data-testid="editor-status-bar">
      <Menu withinPortal position="top-start">
        <Menu.Target>
          <button
            className="ds-status-item"
            data-testid="lsp-indicator"
            aria-label={`Language server: ${label}`}
          >
            <IconBraces size={12} />
            {language ?? "Plain text"}
            <span
              className={`ds-status-dot ds-status-dot-${tone}`}
              aria-hidden="true"
            />
          </button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Language server</Menu.Label>
          <Menu.Item disabled data-testid="lsp-state">
            {label}
          </Menu.Item>
          {lsp?.detail && (
            <Menu.Item disabled data-testid="lsp-detail">
              {lsp.detail}
            </Menu.Item>
          )}
          {missing &&
            (installCmd ? (
              <>
                <Menu.Item
                  closeMenuOnClick={false}
                  leftSection={<IconDownload size={13} />}
                  onClick={install}
                  disabled={installing}
                  data-testid="lsp-install"
                >
                  {installing ? "Installing…" : installCmd}
                </Menu.Item>
                {installError && (
                  <Menu.Item disabled data-testid="lsp-install-error">
                    {installError}
                  </Menu.Item>
                )}
                {installed && (
                  <Menu.Item disabled data-testid="lsp-installed">
                    Installed — reopen this file to start it.
                  </Menu.Item>
                )}
              </>
            ) : (
              // No installer Palisade can drive here: name the binary so the
              // instruction is at least actionable by hand.
              <Menu.Item disabled>
                Install {lsp?.server} and reopen this file.
              </Menu.Item>
            ))}
          {lsp?.state === "disabled" && (
            <Menu.Item disabled>
              Restart Palisade to try this server again.
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
      <Tooltip
        label={
          fim ? "Inline completion is on" : "Inline completion is off"
        }
        withinPortal
      >
        <button
          className="ds-status-item"
          aria-pressed={fim}
          aria-label={`Inline completion: ${fim ? "on" : "off"}`}
          onClick={() =>
            void persistCompletionEnabled(!fim, api.setCompletionEnabled)
          }
          data-testid="fim-toggle"
        >
          <IconSparkles size={12} />
          FIM
          <span
            className={`ds-status-dot ds-status-dot-${fim ? "success" : "muted"}`}
            aria-hidden="true"
          />
        </button>
      </Tooltip>
      <Tooltip label={label} withinPortal>
        <span className="ds-status-note" data-testid="lsp-note">
          {label}
        </span>
      </Tooltip>
      <span className="ds-status-spacer" />
      {cursor && (
        <span className="ds-status-note" data-testid="cursor-position">
          Ln {cursor.line}, Col {cursor.col}
        </span>
      )}
    </div>
  );
}
