import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Group } from "@mantine/core";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { autocompletion, completeAnyWord, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldGutter,
  codeFolding,
  foldKeymap,
} from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import * as api from "./api";
import { languageExtensionFor, loadLanguageFor, mediaKindFor, mimeTypeFor } from "./codeLanguage";
import { describeError } from "./errors";
import {
  EDITOR_FONT_CHANGED_EVENT,
  EDITOR_WRAP_CHANGED_EVENT,
  loadEditorFont,
  loadEditorFontSize,
  loadEditorWrap,
} from "./SettingsPanel";

type Props = {
  projectHash: string;
  path: string | null;
  onSave?: (edit: { path: string; before: string; after: string }) => void;
  /** Tagged with the path because the tab list, not this pane, owns which
   * files have unsaved edits. */
  onDirtyChange?: (path: string, dirty: boolean) => void;
  /** Bumped by `App` when the filesystem watcher reports this file changed
   * underneath us. A clean buffer reloads silently; a dirty one raises the
   * conflict banner so the user picks which version survives. */
  externalChange?: { path: string; at: number } | null;
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

/** A file's editing session: its CodeMirror state serialized (document,
 * cursor, selection, undo history) plus the text it was last in agreement
 * with on disk. Dirtiness is `doc !== baseline`, so it survives the pane
 * unmounting — switching shells or looking at the diff can't quietly turn a
 * tab with unsaved work back into a clean one.
 *
 * Serialized rather than held as a live `EditorState` because a state's
 * extensions close over the component instance that built them. Reusing one
 * after a remount would leave the update listener calling the previous
 * instance's setters, and the file would silently stop reporting dirty. */
type Session = { json: unknown; baseline: string };

/** Module-level so it outlives the component: the pane unmounts on every
 * shell toggle and diff toggle, and rebuilding from scratch each time is
 * what used to throw away cursor position and undo history. */
const sessions = new Map<string, Session>();

const sessionKey = (projectHash: string, path: string) => `${projectHash}:${path}`;

/** Forgets a file's editing session — called when its tab closes or its
 * project goes away, so a reopened tab starts from disk rather than from a
 * stale document. */
export function evictEditorSession(projectHash: string, path: string) {
  sessions.delete(sessionKey(projectHash, path));
}

export function evictProjectSessions(projectHash: string) {
  for (const key of [...sessions.keys()]) {
    if (key.startsWith(`${projectHash}:`)) sessions.delete(key);
  }
}

/** Whether a file has unsaved edits according to its cached session. Lets
 * the tab list recover dirtiness for a tab whose pane isn't mounted. */
export function sessionIsDirty(projectHash: string, path: string): boolean {
  const session = sessions.get(sessionKey(projectHash, path));
  return session ? docOf(session) !== session.baseline : false;
}

/** The document text out of a serialized session. */
function docOf(session: Session): string {
  const doc = (session.json as { doc?: unknown })?.doc;
  return typeof doc === "string" ? doc : Array.isArray(doc) ? doc.join("\n") : "";
}

/** CodeMirror's serializable state fields — undo history is the one that
 * matters here, and it has to be named on both sides of the round trip. */
const SERIALIZED_FIELDS = { history: historyField };

const formatBytes = (bytes: number) => {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
};

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
  const wrapCompartment = useRef(new Compartment());
  // Refs so the update/save listeners (bound once per file load) always see
  // the latest callback/path without re-mounting the EditorView per render.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

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
  // Files we decline to open, and why — a 40 MB log and a stray .bin are
  // both fine to have in a project, they just aren't editable here.
  const [unopenable, setUnopenable] = useState<
    { kind: "binary" } | { kind: "tooLarge"; bytes: number } | null
  >(null);
  // Bumped to re-read from disk, having dropped the cached session.
  const [reloadToken, setReloadToken] = useState(0);
  // Incremented once per session becoming available (loaded from disk, or
  // restored from cache). The view is built from this rather than from the
  // content changing, so a read that resolves inside an unrelated commit
  // can't leave a previous file's document on screen.
  const [viewSeq, setViewSeq] = useState(0);
  // What we believe is currently on disk. Dirtiness is measured against it,
  // so undoing back to the original correctly reads as clean.
  const baselineRef = useRef("");

  // Tagged with the path: the tab list owns dirtiness, and an untagged
  // report would land on whichever tab happened to be active. Deliberately
  // has no unmount reset — a tab with unsaved work stays dirty while you
  // look at the diff or switch shells.
  useEffect(() => {
    if (path) onDirtyChange?.(path, dirty);
  }, [path, dirty, onDirtyChange]);

  const reload = useCallback(() => {
    setConflict(false);
    // Drop the session so the load effect can't serve the stale document
    // back from cache.
    if (path) evictEditorSession(projectHash, path);
    setReloadToken((token) => token + 1);
  }, [projectHash, path]);

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
      const expectedPrevious = options?.overwrite ? null : baselineRef.current;
      api
        .writeFileContent(projectHash, path, after, expectedPrevious)
        .then((format) => {
          onSaveRef.current?.({ path, before: baselineRef.current, after });
          baselineRef.current = after;
          sessions.set(sessionKey(projectHash, path), {
            json: view.state.toJSON(SERIALIZED_FIELDS),
            baseline: after,
          });
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
    [projectHash, path, saving]
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  const buildExtensions = useCallback(
    (forPath: string) => [
      lineNumbers(),
      highlightActiveLine(),
      highlightSpecialChars(),
      history(),
      closeBrackets(),
      bracketMatching(),
      codeFolding(),
      foldGutter(),
      // Multi-cursor: drawSelection renders the extra carets, and
      // rectangularSelection/crosshairCursor give Alt-drag column select.
      drawSelection(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      autocompletion({ override: [completeAnyWord] }),
      keymap.of([
        { key: "Mod-s", run: () => (saveRef.current(), true) },
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      languageCompartment.current.of(languageExtensionFor(forPath)),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        setDirty(update.state.doc.toString() !== baselineRef.current);
      }),
      wrapCompartment.current.of(loadEditorWrap() ? EditorView.lineWrapping : []),
      fontCompartment.current.of(editorFontTheme()),
    ],
    []
  );

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

  // Make a session available for `path`: restored from cache when this file
  // has been open before, otherwise read from disk.
  useEffect(() => {
    setMediaSrc(null);
    setImageZoom(1);
    setError(null);
    setSaved(false);
    setConflict(false);
    setUnopenable(null);
    if (!path) return;

    const mediaKind = mediaKindFor(path);
    if (mediaKind) {
      api
        .readFileBase64(projectHash, path)
        .then((base64) => setMediaSrc(`data:${mimeTypeFor(path)};base64,${base64}`))
        .catch((err) => setError(describeError(err)));
      return;
    }

    const key = sessionKey(projectHash, path);
    const cached = sessions.get(key);
    if (cached) {
      baselineRef.current = cached.baseline;
      setDirty(docOf(cached) !== cached.baseline);
      setViewSeq((seq) => seq + 1);
      return;
    }

    let cancelled = false;
    api
      .readFileContent(projectHash, path)
      .then((text) => {
        if (cancelled) return;
        sessions.set(key, {
          json: EditorState.create({ doc: text }).toJSON(),
          baseline: text,
        });
        baselineRef.current = text;
        setDirty(false);
        setViewSeq((seq) => seq + 1);
      })
      .catch((err) => {
        if (cancelled) return;
        const bytes = api.tooLargeBytes(err);
        if (bytes !== null) setUnopenable({ kind: "tooLarge", bytes });
        else if (api.isBinaryError(err)) setUnopenable({ kind: "binary" });
        else setError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectHash, path, reloadToken]);

  // Build the view from the file's session. Recreating it from the cached
  // EditorState restores document, cursor, selection and undo history
  // together, so switching tabs (or away to the diff and back) picks up
  // exactly where the user left off.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !path || viewSeq === 0) return;
    const key = sessionKey(projectHash, path);
    const session = sessions.get(key);
    if (!session) return;

    // Extensions are rebuilt here rather than restored: they close over this
    // component instance, and a serialized session carries only document,
    // selection and undo history.
    const state = EditorState.fromJSON(
      session.json as Parameters<typeof EditorState.fromJSON>[0],
      { extensions: buildExtensions(path) },
      SERIALIZED_FIELDS
    );
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      // Stash the live state before tearing down, or every unmount would
      // roll the file back to however it looked when it was first opened.
      //
      // Only when the cache still holds the session this view was built
      // from: a reload (and a save) replaces it wholesale, and stashing
      // then would push the document we just discarded straight back over
      // the one we just fetched.
      if (sessions.get(key) === session) {
        sessions.set(key, { ...session, json: view.state.toJSON(SERIALIZED_FIELDS) });
      }
      view.destroy();
      viewRef.current = null;
    };
  }, [projectHash, path, viewSeq, buildExtensions]);

  // Live-reconfigure the font on a settings change, without waiting for the
  // next file switch to remount the view (mirrors languageCompartment's use
  // for per-file language selection).
  useEffect(() => {
    const onFontChanged = () => {
      viewRef.current?.dispatch({ effects: fontCompartment.current.reconfigure(editorFontTheme()) });
    };
    const onWrapChanged = () => {
      viewRef.current?.dispatch({
        effects: wrapCompartment.current.reconfigure(
          loadEditorWrap() ? EditorView.lineWrapping : []
        ),
      });
    };
    window.addEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
    window.addEventListener(EDITOR_WRAP_CHANGED_EVENT, onWrapChanged);
    return () => {
      window.removeEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
      window.removeEventListener(EDITOR_WRAP_CHANGED_EVENT, onWrapChanged);
    };
  }, []);

  // Highlighting for file types that aren't bundled (HTML, YAML, SQL, shell
  // and the rest) arrives a moment after the view, via the same compartment
  // the bundled languages are configured through.
  useEffect(() => {
    if (!path || viewSeq === 0) return;
    let cancelled = false;
    void loadLanguageFor(path).then((language) => {
      if (cancelled || !language) return;
      viewRef.current?.dispatch({
        effects: languageCompartment.current.reconfigure(language),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [path, viewSeq]);

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

  if (unopenable) {
    return (
      <div className="ds-media-preview" data-testid="file-unopenable">
        <div className="ds-editor-toolbar">
          <span className="ds-editor-path">{path}</span>
        </div>
        <div className="ds-media-preview-body">
          <p className="empty">
            {unopenable.kind === "binary"
              ? "This looks like a binary file, so there's nothing useful to show as text."
              : `This file is ${formatBytes(unopenable.bytes)} — too large to open in the editor without freezing it.`}
          </p>
        </div>
      </div>
    );
  }

  if (viewSeq === 0) {
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
