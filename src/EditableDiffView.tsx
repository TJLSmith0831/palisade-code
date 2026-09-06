import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Alert, Button, Group, Text, Tooltip } from "@mantine/core";
import {
  IconArrowLeft,
  IconChevronDown,
  IconChevronUp,
  IconDeviceFloppy,
} from "@tabler/icons-react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
// The project's own token colors, not CodeMirror's defaults: one
// syntaxHighlighting extension only — a second one silently disables the
// first (see the note on codeHighlightStyle).
import { codeColorTheme, codeHighlightStyle } from "./FileEditorPane";
import type { StructuredPatch } from "diff";

import * as api from "./api";
import { languageExtensionFor, loadLanguageFor } from "./codeLanguage";
import { addedLines, diffGutter, markedLines, setDiffLines } from "./diffGutter";
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
  /** How many lines this working tree changed — the header's way of saying
   *  "this is the whole file, and this much of it is new". */
  const [changed, setChanged] = useState(0);
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
              codeHighlightStyle,
              codeColorTheme,
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
        setChanged(markedLines(editor.state).length);
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

  /** Move the cursor to the next (or previous) changed line and scroll it
   *  into view. The file is shown whole, so on a large file the changes need
   *  a way to be reached that isn't scrolling until one appears. */
  const jump = (direction: 1 | -1) => {
    const editor = view.current;
    if (!editor) return;
    const lines = markedLines(editor.state);
    if (lines.length === 0) return;
    const here = editor.state.doc.lineAt(editor.state.selection.main.head).number;
    const next =
      direction === 1
        ? (lines.find((line) => line > here) ?? lines[0])
        : ([...lines].reverse().find((line) => line < here) ?? lines[lines.length - 1]);
    const pos = editor.state.doc.line(next).from;
    editor.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    editor.focus();
  };

  return (
    <div className="diff-editable ds-editor-body" data-testid="editable-diff">
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
        {/* The whole file is here, not just its hunks — this says how much of
            it changed, and the arrows walk between those lines. */}
        <Text size="xs" c="dimmed" data-testid="editable-diff-changed">
          {changed === 0 ? "full file" : `full file · ${changed} changed`}
        </Text>
        <Tooltip label="Previous change" openDelay={300}>
          <ActionIcon
            size="sm"
            variant="subtle"
            onClick={() => jump(-1)}
            disabled={changed === 0}
            aria-label="Previous change"
            data-testid="editable-diff-prev"
          >
            <IconChevronUp size={13} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Next change" openDelay={300}>
          <ActionIcon
            size="sm"
            variant="subtle"
            onClick={() => jump(1)}
            disabled={changed === 0}
            aria-label="Next change"
            data-testid="editable-diff-next"
          >
            <IconChevronDown size={13} />
          </ActionIcon>
        </Tooltip>
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
