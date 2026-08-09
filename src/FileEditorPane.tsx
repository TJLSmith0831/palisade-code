import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Group } from "@mantine/core";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, completeAnyWord, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import * as api from "./api";
import { languageExtensionFor, mediaKindFor, mimeTypeFor } from "./codeLanguage";
import { describeError } from "./errors";
import { EDITOR_FONT_CHANGED_EVENT, loadEditorFont, loadEditorFontSize } from "./SettingsPanel";

type Props = {
  projectHash: string;
  path: string | null;
  onSave?: (edit: { path: string; before: string; after: string }) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Bumped by `App` when the filesystem watcher reports this file changed
   * underneath us. A clean buffer reloads silently; a dirty one raises the
   * conflict banner so the user picks which version survives. */
  externalChange?: { path: string; at: number } | null;
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

const editorFontTheme = () =>
  EditorView.theme({
    "&": { height: "100%", fontSize: `${loadEditorFontSize()}px` },
    ".cm-scroller": { fontFamily: loadEditorFont(), lineHeight: "1.55" },
  });

export default function FileEditorPane({
  projectHash,
  path,
  onSave,
  onDirtyChange,
  externalChange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const fontCompartment = useRef(new Compartment());
  // Refs so the update/save listeners (bound once per file load) always see
  // the latest callback/path without re-mounting the EditorView per render.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const [content, setContent] = useState<string | null>(null);
  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  const [imageZoom, setImageZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formatResult, setFormatResult] = useState<string | null>(null);
  // The file changed on disk while this buffer was dirty, so neither version
  // can be discarded without asking.
  const [conflict, setConflict] = useState(false);
  // Bumped to re-read the file — the reload half of the conflict banner, and
  // the silent path when the buffer was clean.
  const [reloadToken, setReloadToken] = useState(0);
  // Incremented once per *load*, and never on save. The view is rebuilt from
  // this rather than from "content stopped being null", because a reload's
  // read can resolve before React commits the intervening `setContent(null)`
  // — the content then changes without ever crossing the null boundary, and
  // a view keyed on that boundary would keep showing the previous file.
  const [loadSeq, setLoadSeq] = useState(0);

  useEffect(() => {
    onDirtyChange?.(dirty);
    // Without this, unmounting the pane (shell toggle, editor/diff switch)
    // leaves the parent believing a file it no longer shows is still dirty,
    // and the discard guards then fire against nothing.
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  const reload = useCallback(() => {
    setConflict(false);
    setReloadToken((token) => token + 1);
  }, []);

  const save = useCallback(
    (options?: { overwrite?: boolean }) => {
      const view = viewRef.current;
      if (!path || !view || saving) return;
      const after = view.state.doc.toString();
      setSaving(true);
      setError(null);
      setFormatResult(null);
      // What we believe is on disk. The backend refuses the write if that's
      // no longer true, which catches a change that landed inside the
      // watcher's debounce window. "Keep mine" deliberately drops the claim.
      const expectedPrevious = options?.overwrite ? null : content;
      api
        .writeFileContent(projectHash, path, after, expectedPrevious)
        .then((format) => {
          onSaveRef.current?.({ path, before: content ?? "", after });
          setContent(after);
          setDirty(false);
          setConflict(false);
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
          if (format) {
            setFormatResult(format);
            setTimeout(() => setFormatResult(null), 4000);
          }
        })
        .catch((err) => {
          // A stale save isn't a failure to report, it's a choice to offer.
          if (api.isConflictError(err)) setConflict(true);
          else setError(describeError(err));
        })
        .finally(() => setSaving(false));
    },
    [projectHash, path, content, saving]
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  // Read through a ref so this reacts only to a new change event, not to the
  // buffer going dirty afterwards.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!externalChange || !path || externalChange.path !== path) return;
    // Nothing of the user's to lose, so take the new version silently —
    // this is also what makes an agent's edit show up while you watch.
    if (!dirtyRef.current) reload();
    else setConflict(true);
  }, [externalChange, path, reload]);

  // Load file content on path change.
  useEffect(() => {
    setContent(null);
    setMediaSrc(null);
    setImageZoom(1);
    setError(null);
    setDirty(false);
    setSaved(false);
    setConflict(false);
    if (!path) return;
    const mediaKind = mediaKindFor(path);
    if (mediaKind) {
      api
        .readFileBase64(projectHash, path)
        .then((base64) => setMediaSrc(`data:${mimeTypeFor(path)};base64,${base64}`))
        .catch((err) => setError(describeError(err)));
      return;
    }
    api
      .readFileContent(projectHash, path)
      .then((text) => {
        setContent(text);
        setLoadSeq((seq) => seq + 1);
      })
      .catch((err) => setError(describeError(err)));
  }, [projectHash, path, reloadToken]);

  // Mount the CM6 view once a file's content has loaded; remount only on a
  // real file switch (path change), not on every save — `save()` also calls
  // `setContent`, and keying this effect on `content` would tear down and
  // recreate the view (losing cursor/selection/undo history) on every save.
  const contentLoaded = content !== null;
  useEffect(() => {
    const host = hostRef.current;
    if (!host || content === null || !path) return;

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        closeBrackets(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        autocompletion({ override: [completeAnyWord] }),
        keymap.of([
          { key: "Mod-s", run: () => (saveRef.current(), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        languageCompartment.current.of(languageExtensionFor(path)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) setDirty(true);
        }),
        fontCompartment.current.of(editorFontTheme()),
      ],
    });

    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, contentLoaded, loadSeq]);

  // Live-reconfigure the font on a settings change, without waiting for the
  // next file switch to remount the view (mirrors languageCompartment's use
  // for per-file language selection).
  useEffect(() => {
    const onFontChanged = () => {
      viewRef.current?.dispatch({ effects: fontCompartment.current.reconfigure(editorFontTheme()) });
    };
    window.addEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
    return () => window.removeEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
  }, []);

  if (!path) {
    return <p className="empty">Select a file from the explorer to view it.</p>;
  }
  if (error) {
    return (
      <Alert
        color="var(--danger)"
        variant="light"
        m="12px 16px 0"
        style={{ whiteSpace: "pre-wrap" }}
        data-testid="file-editor-error"
      >
        {error}
      </Alert>
    );
  }
  const mediaKind = mediaKindFor(path);
  if (mediaKind) {
    if (!mediaSrc) return <p className="empty">Loading…</p>;
    return (
      <div className="ds-media-preview" data-testid="file-editor-media">
        <div className="ds-editor-toolbar">
          <span className="ds-editor-path">{path}</span>
          {mediaKind === "image" && (
            <>
              <span className="ds-editor-spacer" />
              <button
                className="ds-icon-btn"
                onClick={() => setImageZoom((z) => clampZoom(z - 0.25))}
                title="Zoom out"
                aria-label="Zoom out"
                data-testid="image-zoom-out"
              >
                −
              </button>
              <span className="ds-zoom-level" data-testid="image-zoom-level">
                {Math.round(imageZoom * 100)}%
              </span>
              <button
                className="ds-icon-btn"
                onClick={() => setImageZoom((z) => clampZoom(z + 0.25))}
                title="Zoom in"
                aria-label="Zoom in"
                data-testid="image-zoom-in"
              >
                +
              </button>
              <button
                className="ds-icon-btn"
                onClick={() => setImageZoom(1)}
                title="Reset zoom"
                data-testid="image-zoom-reset"
              >
                Reset
              </button>
            </>
          )}
        </div>
        <div
          className="ds-media-preview-body"
          onWheel={(event) => {
            if (mediaKind !== "image" || !(event.ctrlKey || event.metaKey)) return;
            event.preventDefault();
            setImageZoom((z) => clampZoom(z - event.deltaY * 0.01));
          }}
        >
          {mediaKind === "image" ? (
            <img src={mediaSrc} alt={path} style={{ transform: `scale(${imageZoom})` }} />
          ) : (
            <video src={mediaSrc} controls autoPlay loop muted />
          )}
        </div>
      </div>
    );
  }

  if (content === null) {
    return <p className="empty">Loading…</p>;
  }

  return (
    <div className="ds-code-editor" data-testid="file-editor">
      <div className="ds-editor-toolbar">
        <span className="ds-editor-path">{path}</span>
        <span className="ds-editor-spacer" />
        {formatResult && (
          <span className="ds-editor-format-result" data-testid="format-on-save-result">
            {formatResult}
          </span>
        )}
        {saved && <span className="ds-editor-saved">Saved</span>}
        <button className="ds-editor-save-btn" onClick={() => save()} disabled={!dirty || saving}>
          {saving ? "Saving…" : dirty ? "Save *" : "Save"}
        </button>
      </div>
      {conflict && (
        <Alert
          color="var(--warning)"
          variant="light"
          m="8px 16px 0"
          title="Changed on disk"
          data-testid="file-conflict-banner"
        >
          <p>
            {path} was changed by something else — the agent, a branch switch, or another
            editor — and you have unsaved edits. Only one version can survive.
          </p>
          <Group gap="xs" mt="xs">
            <Button
              size="xs"
              variant="default"
              onClick={reload}
              data-testid="conflict-reload"
            >
              Discard mine, reload
            </Button>
            <Button
              size="xs"
              variant="default"
              onClick={() => save({ overwrite: true })}
              disabled={saving}
              data-testid="conflict-overwrite"
            >
              Keep mine, overwrite
            </Button>
          </Group>
        </Alert>
      )}
      <div className="ds-editor-body" ref={hostRef} data-testid="file-editor-cm" />
    </div>
  );
}
