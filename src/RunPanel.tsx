import { useCallback, useEffect, useState } from "react";
import { ActionIcon, Button, TextInput, Tooltip } from "@mantine/core";
import {
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import * as api from "./api";

// Amendment 1's Run panel: where run configuration actually happens. The
// title bar's split button is the quick-access shortcut over the same
// `run` map — two views of one config, not two features.
//
// Deliberately not a verify surface: `verify` commands are evidence a spec
// is green and live in VerifyPane. These are just shortcuts.

type Entry = [string, string];

export default function RunPanel({
  projectHash,
  onRun,
  onChanged,
  onError,
}: {
  projectHash: string;
  /** The shell owns the terminal, so running is the caller's job. */
  onRun: (name: string, command: string) => void;
  /** The title bar reads the same map — tell it when this one writes. */
  onChanged?: () => void;
  onError: (message: unknown) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [suggestions, setSuggestions] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  // The row being edited, or "" for a new one; null when no draft is open.
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftCommand, setDraftCommand] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const configured = await api.runCommands(projectHash);
      setEntries(configured);
      // Detection only speaks up when there is nothing configured — an
      // established project doesn't need suggestions.
      setSuggestions(
        configured.length === 0 ? await api.detectRunCommands(projectHash) : []
      );
    } catch (err) {
      onError(err);
    } finally {
      setLoading(false);
    }
  }, [projectHash, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = async (next: Entry[]) => {
    const sorted = [...next].sort(([a], [b]) => a.localeCompare(b));
    setEntries(sorted);
    setSuggestions([]);
    try {
      await api.saveRunCommands(projectHash, sorted);
      onChanged?.();
    } catch (err) {
      onError(err);
      void load();
    }
  };

  const openDraft = (name: string) => {
    setDraftFor(name);
    setDraftName(name);
    setDraftCommand(entries.find(([n]) => n === name)?.[1] ?? "");
  };

  const saveDraft = () => {
    const name = draftName.trim();
    const command = draftCommand.trim();
    if (!name || !command) return;
    const without = entries.filter(([n]) => n !== draftFor && n !== name);
    setDraftFor(null);
    void persist([...without, [name, command]]);
  };

  const draftValid = Boolean(draftName.trim() && draftCommand.trim());

  return (
    <>
      <div className="ds-panel-head">
        <span>Run Configurations</span>
        <Tooltip label="Add command" withinPortal>
          <ActionIcon
            variant="subtle"
            size="sm"
            aria-label="Add command"
            onClick={() => openDraft("")}
            data-testid="run-add"
          >
            <IconPlus size={15} />
          </ActionIcon>
        </Tooltip>
      </div>
      <div className="ds-panel-body">
        {entries.map(([name, command]) => (
          <div key={name} className="ds-run-row" data-testid={`run-row-${name}`}>
            <Tooltip label={`Run ${name}`} withinPortal>
              <ActionIcon
                variant="subtle"
                size="sm"
                aria-label={`Run ${name}`}
                onClick={() => onRun(name, command)}
                data-testid={`run-play-${name}`}
              >
                <IconPlayerPlay size={14} />
              </ActionIcon>
            </Tooltip>
            <span className="ds-run-text">
              <span className="ds-run-name">{name}</span>
              <span className="ds-run-command">{command}</span>
            </span>
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label={`Edit ${name}`}
              onClick={() => openDraft(name)}
              data-testid={`run-edit-${name}`}
            >
              <IconPencil size={14} />
            </ActionIcon>
            <ActionIcon
              variant="subtle"
              size="sm"
              aria-label={`Delete ${name}`}
              onClick={() => persist(entries.filter(([n]) => n !== name))}
              data-testid={`run-delete-${name}`}
            >
              <IconTrash size={14} />
            </ActionIcon>
          </div>
        ))}

        {draftFor !== null && (
          <div className="ds-run-draft">
            <TextInput
              size="xs"
              placeholder="Name"
              aria-label="Command name"
              value={draftName}
              onChange={(e) => setDraftName(e.currentTarget.value)}
              data-testid="run-draft-name"
            />
            <TextInput
              size="xs"
              placeholder="Shell command"
              aria-label="Shell command"
              value={draftCommand}
              onChange={(e) => setDraftCommand(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftValid) saveDraft();
              }}
              data-testid="run-draft-command"
            />
            <div className="ds-run-draft-actions">
              <Button
                size="compact-xs"
                variant="default"
                onClick={() => setDraftFor(null)}
              >
                Cancel
              </Button>
              <Button
                size="compact-xs"
                disabled={!draftValid}
                onClick={saveDraft}
                data-testid="run-draft-save"
              >
                Save
              </Button>
            </div>
          </div>
        )}

        {suggestions.length > 0 && (
          <>
            <h2 className="ds-section-heading">Detected in this project</h2>
            <p className="hint">
              Nothing is configured yet. These are proposals — accept one to
              write it to <code>.project-settings.json</code>.
            </p>
            {suggestions.map(([name, command]) => (
              <div
                key={name}
                className="ds-run-row"
                data-testid={`run-suggestion-${name}`}
              >
                <span className="ds-run-text">
                  <span className="ds-run-name">{name}</span>
                  <span className="ds-run-command">{command}</span>
                </span>
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={() => persist([...entries, [name, command]])}
                  data-testid={`run-accept-${name}`}
                >
                  Add
                </Button>
              </div>
            ))}
          </>
        )}

        {!loading &&
          entries.length === 0 &&
          suggestions.length === 0 &&
          draftFor === null && (
            <p className="empty" data-testid="run-empty">
              No run commands configured, and nothing obvious to suggest. Add
              one with +.
            </p>
          )}
      </div>
    </>
  );
}
