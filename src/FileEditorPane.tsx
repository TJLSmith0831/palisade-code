import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, completeAnyWord, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import * as api from "./api";
import { languageExtensionFor, mediaKindFor, mimeTypeFor } from "./codeLanguage";
import { EDITOR_FONT_CHANGED_EVENT, loadEditorFont, loadEditorFontSize } from "./SettingsPanel";

type Props = {
  projectHash: string;
  path: string | null;
  onSave?: (edit: { path: string; before: string; after: string }) => void;
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

const editorFontTheme = () =>
  EditorView.theme({
    "&": { height: "100%", fontSize: `${loadEditorFontSize()}px` },
    ".cm-scroller": { fontFamily: loadEditorFont(), lineHeight: "1.55" },
  });

export default function FileEditorPane({ projectHash, path, onSave }: Props) {
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

  const save = useCallback(() => {
    const view = viewRef.current;
    if (!path || !view || saving) return;
    const after = view.state.doc.toString();
    setSaving(true);
    setError(null);
    setFormatResult(null);
    api
      .writeFileContent(projectHash, path, after)
      .then((format) => {
        onSaveRef.current?.({ path, before: content ?? "", after });
        setContent(after);
        setDirty(false);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        if (format) {
          setFormatResult(format);
          setTimeout(() => setFormatResult(null), 4000);
        }
      })
      .catch((err) => setError(String(err)))
      .finally(() => setSaving(false));
  }, [projectHash, path, content, saving]);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Load file content on path change.
  useEffect(() => {
    setContent(null);
    setMediaSrc(null);
    setImageZoom(1);
    setError(null);
    setDirty(false);
    setSaved(false);
    if (!path) return;
    const mediaKind = mediaKindFor(path);
    if (mediaKind) {
      api
        .readFileBase64(projectHash, path)
        .then((base64) => setMediaSrc(`data:${mimeTypeFor(path)};base64,${base64}`))
        .catch((err) => setError(String(err)));
      return;
    }
    api
      .readFileContent(projectHash, path)
      .then(setContent)
      .catch((err) => setError(String(err)));
  }, [projectHash, path]);

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
  }, [path, contentLoaded]);

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
      <div className="graph-error" data-testid="file-editor-error">
        {error}
      </div>
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
        <button className="ds-editor-save-btn" onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving…" : dirty ? "Save *" : "Save"}
        </button>
      </div>
      <div className="ds-editor-body" ref={hostRef} data-testid="file-editor-cm" />
    </div>
  );
}
