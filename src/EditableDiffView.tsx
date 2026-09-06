import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Group, Text } from "@mantine/core";
import { IconArrowLeft, IconDeviceFloppy } from "@tabler/icons-react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import type { StructuredPatch } from "diff";

import * as api from "./api";
import { languageExtensionFor, loadLanguageFor } from "./codeLanguage";
import { addedLines, diffGutter, setDiffLines } from "./diffGutter";
import { describeError } from "./errors";

type Props = {
  projectHash: string;
  /** The working tree this file lives in — a thread's worktree or the project
   *  root. Reads and the save both go through it, so the file edited is the
   *  file shown. */
  threadId?: string;
  path: string;
  /** This file's working-tree patch, for the gutter marks. */
  patch?: StructuredPatch;
  onBack: () => void;
  /** A save changed the tree: the pane re-reads status and diffs. */
  onSaved?: () => void;
};

/** One changed file, open as itself.
 *
 *  The review surfaces in Cursor, Windsurf and Zed all converged on the same
 *  thing: the diff is shown *in* the real buffer, not in a locked-down diff
 *  viewer beside it. So this is an ordinary editor with the changed lines
 *  marked — fixing a typo the agent left is an edit, not a round trip through
 *  a separate editor tab and back. */
export default function EditableDiffView({
  projectHash,
  threadId,
  path,
  patch,
  onBack,
  onSaved,
}: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  /** What was last read from (or written to) disk — the save's staleness
   *  check compares against this, so a change that landed underneath us is
   *  refused instead of silently overwriting it. */
  const baseline = useRef<string>("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    const current = view.current?.state.doc.toString();
    if (current === undefined || current === baseline.current) return;
    setSaving(true);
    try {
      await api.writeFileContent(projectHash, path, current, baseline.current, threadId);
      baseline.current = current;
      setDirty(false);
      setError(null);
      onSaved?.();
    } catch (err) {
      setError(
        api.isConflictError(err)
          ? `${path} changed on disk since you opened it — go back and reopen it.`
          : describeError(err),
      );
    } finally {
      setSaving(false);
    }
  }, [projectHash, path, threadId, onSaved]);

  // Read through a ref: the keymap is built once per file, and closing over
  // the first `save` would freeze the first baseline with it.
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDirty(false);
    api
      .readFileContent(projectHash, path, threadId)
      .then(async (content) => {
        if (cancelled || !host.current) return;
        baseline.current = content;
        view.current?.destroy();
        // The full grammar loads asynchronously; the compartment lets it slot
        // into a buffer the user is already typing in.
        const languageCompartment = new Compartment();
        const editor = new EditorView({
          state: EditorState.create({
            doc: content,
            extensions: [
              lineNumbers(),
              diffGutter(),
              history(),
              highlightActiveLine(),
              syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
              languageCompartment.of(languageExtensionFor(path)),
              keymap.of([
                { key: "Mod-s", run: () => (void saveRef.current(), true) },
                ...defaultKeymap,
                ...historyKeymap,
                indentWithTab,
              ]),
              EditorView.updateListener.of((update) => {
                if (!update.docChanged) return;
                setDirty(update.state.doc.toString() !== baseline.current);
              }),
            ],
          }),
          parent: host.current,
        });
        view.current = editor;
        editor.dispatch({ effects: setDiffLines.of(addedLines(patch)) });
        // Grammars load on demand; the buffer is usable before it arrives.
        const language = await loadLanguageFor(path);
        if (!cancelled && language) {
          editor.dispatch({ effects: languageCompartment.reconfigure(language) });
        }
      })
      .catch((err) => !cancelled && setError(describeError(err)));
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
  }, [projectHash, path, threadId, patch]);

  return (
    <div className="diff-editable" data-testid="editable-diff">
      <Group gap={8} px={12} py={8} wrap="nowrap">
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconArrowLeft size={13} />}
          onClick={onBack}
          data-testid="editable-diff-back"
        >
          All changes
        </Button>
        <Text size="xs" ff="monospace" truncate style={{ flex: 1 }}>
          {path}
        </Text>
        <Button
          size="compact-xs"
          leftSection={<IconDeviceFloppy size={13} />}
          disabled={!dirty}
          loading={saving}
          onClick={() => void save()}
          data-testid="editable-diff-save"
        >
          Save
        </Button>
      </Group>
      {error && (
        <Alert color="danger" variant="light" m="0 12px 8px" data-testid="editable-diff-error">
          {error}
        </Alert>
      )}
      <div ref={host} data-testid="editable-diff-editor" />
    </div>
  );
}
