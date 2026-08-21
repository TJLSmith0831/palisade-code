import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Group } from "@mantine/core";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
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
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  COMPLETION_SETTINGS_CHANGED_EVENT,
  fimCompletion,
  loadCompletionSettings,
} from "./completion/GhostTextPlugin";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  foldGutter,
  codeFolding,
  foldKeymap,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
} from "@codemirror/search";
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import {
  languageExtensionFor,
  loadLanguageFor,
  mediaKindFor,
  mimeTypeFor,
} from "./codeLanguage";
import { describeError } from "./errors";
import { documentLanguageId, fileUri, languageForPath } from "./lsp";
import { clientFor } from "./lspClients";
import { isMarkdownPath } from "./openTabs";
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
  /** Shown as the leading breadcrumb segment in the toolbar. */
  projectName?: string;
  /** Absolute project root — the language server speaks in `file://` URIs. */
  projectRoot?: string;
  onSave?: (edit: { path: string; before: string; after: string }) => void;
  /** Tagged with the path because the tab list, not this pane, owns which
   * files have unsaved edits. */
  onDirtyChange?: (path: string, dirty: boolean) => void;
  /** Bumped by `App` when the filesystem watcher reports this file changed
   * underneath us. A clean buffer reloads silently; a dirty one raises the
   * conflict banner so the user picks which version survives. */
  externalChange?: { path: string; at: number } | null;
  /** A line to scroll to and select, from a workspace-search result. */
  revealLine?: { path: string; line: number; at: number } | null;
  /** Cursor offset to open a restored tab at. Applied only when the file is
   * first read from disk, never over an in-memory session. */
  initialCursor?: number;
  onCursorChange?: (path: string, offset: number) => void;
  /** 1-based line/column for the shell's status bar. */
  onCursorPosition?: (position: { line: number; col: number }) => void;
  /** Language-server state for the shell's status bar. The pane owns the
   *  editor view the server is attached to, so it is what knows. */
  onLspStatus?: (status: api.LspStatus | null) => void;
  /** Whether to show the Markdown preview pane alongside the WYSIWYG editor.
   * Only honored for `.md`/`.markdown` files; ignored otherwise. */
  mdPreview?: boolean;
  onToggleMdPreview?: () => void;
};

/** Resolves the app's effective color mode from the `data-theme` attribute on
 * <html> ("light" | "dark" | absent for "auto"), falling back to the system
 * preference via `prefers-color-scheme`. The WYSIWYG Markdown editor needs a
 * concrete "light" | "dark" value for its `data-color-mode` prop since it
 * doesn't read the app's own `data-theme` cascade. */
const resolvedColorMode = (): "light" | "dark" => {
  const attr = document.documentElement.dataset.theme;
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const clampZoom = (zoom: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

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

const sessionKey = (projectHash: string, path: string) =>
  `${projectHash}:${path}`;

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
  return typeof doc === "string"
    ? doc
    : Array.isArray(doc)
      ? doc.join("\n")
      : "";
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

// Every popup CodeMirror draws — LSP hover cards, completion lists, the
// lint tooltip, the search panel — is themed off the app's own tokens.
// Untouched they render in CodeMirror's default light styling regardless of
// the app theme, so a hover card in dark mode came back white-on-white.
const popupTheme = EditorView.theme({
  ".cm-tooltip": {
    background: "var(--surface)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    boxShadow: "0 4px 20px rgba(0, 0, 0, 0.35)",
    fontSize: "12px",
  },
  ".cm-tooltip .cm-tooltip-arrow:before": {
    borderTopColor: "var(--border)",
    borderBottomColor: "var(--border)",
  },
  ".cm-tooltip .cm-tooltip-arrow:after": {
    borderTopColor: "var(--surface)",
    borderBottomColor: "var(--surface)",
  },
  ".cm-tooltip-autocomplete > ul > li": {
    color: "var(--fg)",
    fontFamily: "var(--mono)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--active-row)",
    color: "var(--fg)",
  },
  ".cm-completionDetail": { color: "var(--muted)" },
  ".cm-completionInfo": {
    background: "var(--surface)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
  },
  ".cm-tooltip code, .cm-tooltip pre": {
    background: "var(--surface-warm)",
    color: "var(--code-text)",
    borderRadius: "4px",
  },
  ".cm-tooltip a": { color: "var(--accent)" },
  ".cm-diagnostic": {
    background: "var(--surface)",
    color: "var(--fg)",
    borderLeftColor: "var(--danger)",
  },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--warn)" },
  ".cm-diagnostic-info": { borderLeftColor: "var(--muted)" },
  ".cm-panels, .cm-panel": {
    background: "var(--chrome-bg)",
    color: "var(--fg)",
    borderColor: "var(--border)",
  },
  ".cm-panel input, .cm-panel button": {
    background: "var(--surface)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
  },
  ".cm-searchMatch": {
    background: "color-mix(in oklab, var(--warn), transparent 65%)",
  },
  ".cm-searchMatch-selected": {
    background: "color-mix(in oklab, var(--accent), transparent 55%)",
  },
});

// Base text color for the CodeMirror editor, driven by the project-scoped
// --code-text CSS variable. The CSS variable indirection means this updates
// live when applyAppearance() sets the override property — no compartment or
// reconfigure needed.
const codeColorTheme = EditorView.theme({
  ".cm-content": { color: "var(--code-text)" },
});

// Full syntax highlighting theme — replaces defaultHighlightStyle with a
// custom HighlightStyle that uses CSS variables for every token type, so
// colors adapt to light/dark theme automatically. The comment color uses
// --code-comment (user-customizable via Settings panel); all other token
// types use fixed theme-aware CSS variables defined in App.css.
//
// This MUST be a single non-fallback syntaxHighlighting extension —
// CodeMirror's getHighlighters() skips all fallback highlighters the moment
// any non-fallback highlighter exists, so adding a second
// syntaxHighlighting() alongside defaultHighlightStyle({fallback:true})
// silently disables every token type the fallback covered.
const codeHighlightStyle = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword, color: "var(--code-keyword)" },
    {
      tag: [
        tags.atom,
        tags.bool,
        tags.url,
        tags.contentSeparator,
        tags.labelName,
      ],
      color: "var(--code-atom)",
    },
    {
      tag: [tags.literal, tags.number, tags.inserted],
      color: "var(--code-number)",
    },
    { tag: [tags.string, tags.deleted], color: "var(--code-string)" },
    {
      tag: [tags.regexp, tags.escape, tags.special(tags.string)],
      color: "var(--code-regexp)",
    },
    {
      tag: tags.definition(tags.variableName),
      color: "var(--code-text)",
    },
    { tag: tags.local(tags.variableName), color: "var(--code-text)" },
    {
      tag: [tags.variableName, tags.special(tags.variableName), tags.macroName],
      color: "var(--code-text)",
    },
    { tag: [tags.typeName, tags.namespace], color: "var(--code-type)" },
    { tag: tags.className, color: "var(--code-type)" },
    { tag: tags.definition(tags.propertyName), color: "var(--code-text)" },
    { tag: tags.propertyName, color: "var(--code-text)" },
    { tag: tags.function(tags.variableName), color: "var(--code-function)" },
    { tag: tags.comment, color: "var(--code-comment)", fontStyle: "italic" },
    { tag: tags.invalid, color: "var(--code-invalid)" },
    { tag: tags.meta, color: "var(--code-meta)" },
    { tag: tags.link, textDecoration: "underline" },
    { tag: tags.heading, textDecoration: "underline", fontWeight: "bold" },
    { tag: tags.emphasis, fontStyle: "italic" },
    { tag: tags.strong, fontWeight: "bold" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
  ])
);

export default function FileEditorPane({
  projectHash,
  path,
  projectName,
  projectRoot,
  onSave,
  onDirtyChange,
  externalChange,
  revealLine,
  initialCursor,
  onCursorChange,
  onCursorPosition,
  onLspStatus,
  mdPreview = false,
  onToggleMdPreview,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const fontCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const fimCompartment = useRef(new Compartment());
  // The LSP plugin arrives after a round-trip to the backend, so it goes in
  // its own compartment rather than blocking the file from opening.
  const lspCompartment = useRef(new Compartment());
  // Refs so the update/save listeners (bound once per file load) always see
  // the latest callback/path without re-mounting the EditorView per render.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorRef = useRef(onCursorChange);
  onCursorRef.current = onCursorChange;
  const onPositionRef = useRef(onCursorPosition);
  onPositionRef.current = onCursorPosition;
  const initialCursorRef = useRef(initialCursor);
  initialCursorRef.current = initialCursor;
  const onToggleMdPreviewRef = useRef(onToggleMdPreview);
  onToggleMdPreviewRef.current = onToggleMdPreview;

  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  // The controlled value for the WYSIWYG Markdown editor. The CodeMirror doc
  // remains the source of truth for save/dirty/session; this mirrors it so
  // the rich editor renders the same text and writes edits back through
  // `view.dispatch`.
  const [mdValue, setMdValue] = useState("");
  // Resolved color mode for the WYSIWYG editor, which uses `data-color-mode`
  // rather than inheriting from the app's `data-theme` cascade. Tracks the
  // app's theme attribute on <html> and the system preference when it's "auto".
  const [colorMode, setColorMode] = useState<"light" | "dark">(() =>
    resolvedColorMode()
  );
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

  // Writes a WYSIWYG edit back into the CodeMirror doc, which owns save/dirty
  // state. A full-document replacement keeps the session in sync; the undo
  // stack grows one entry per edit, which is acceptable for a first pass.
  const handleMdChange = useCallback((value?: string) => {
    if (value === undefined) return;
    setMdValue(value);
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, []);

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
      codeHighlightStyle,
      codeColorTheme,
      popupTheme,
      fimCompartment.current.of(
        fimCompletion(loadCompletionSettings(), projectHash, forPath)
      ),
      lspCompartment.current.of([]),
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
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head;
          onCursorRef.current?.(forPath, head);
          const line = update.state.doc.lineAt(head);
          onPositionRef.current?.({
            line: line.number,
            col: head - line.from + 1,
          });
        }
        if (!update.docChanged) return;
        setDirty(update.state.doc.toString() !== baselineRef.current);
      }),
      wrapCompartment.current.of(
        loadEditorWrap() ? EditorView.lineWrapping : []
      ),
      fontCompartment.current.of(editorFontTheme()),
    ],
    [projectHash, path]
  );

  // Read through a ref so this reacts only to a new change event, not to the
  // buffer going dirty afterwards.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!externalChange || !path || externalChange.path !== path) return;
    if (dirtyRef.current) {
      setConflict(true);
      return;
    }
    // Palisade's own save trips the watcher too, and a reload rebuilds the view
    // from scratch — which threw the cursor and scroll position back to the
    // top of the file on every save. Only rebuild when disk actually differs
    // from what's on screen; that also skips no-op writes from anyone else.
    let cancelled = false;
    api
      .readFileContent(projectHash, path)
      .then((text) => {
        if (cancelled) return;
        // Nothing of the user's to lose, so take the new version silently —
        // this is also what makes an agent's edit show up while you watch.
        if (text !== viewRef.current?.state.doc.toString()) reload();
      })
      .catch(() => {
        // A read that fails here is the watcher's problem, not the user's:
        // leave the buffer alone rather than blanking it.
      });
    return () => {
      cancelled = true;
    };
  }, [externalChange, path, projectHash, reload]);

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
        .then((base64) =>
          setMediaSrc(`data:${mimeTypeFor(path)};base64,${base64}`)
        )
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
        // Restored cursor is clamped: the file may have changed on disk
        // since the session was written.
        const anchor = Math.min(
          Math.max(initialCursorRef.current ?? 0, 0),
          text.length
        );
        sessions.set(key, {
          json: EditorState.create({
            doc: text,
            selection: { anchor },
          }).toJSON(),
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
    // Report where the cursor already is: the update listener only fires on
    // a change, so without this the status bar stays blank until you type.
    {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      onPositionRef.current?.({ line: line.number, col: head - line.from + 1 });
    }
    return () => {
      // Stash the live state before tearing down, or every unmount would
      // roll the file back to however it looked when it was first opened.
      //
      // Only when the cache still holds the session this view was built
      // from: a reload (and a save) replaces it wholesale, and stashing
      // then would push the document we just discarded straight back over
      // the one we just fetched.
      if (sessions.get(key) === session) {
        sessions.set(key, {
          ...session,
          json: view.state.toJSON(SERIALIZED_FIELDS),
        });
      }
      view.destroy();
      viewRef.current = null;
    };
  }, [projectHash, path, viewSeq, buildExtensions]);

  // Amendment 2: attach a language server to this file, if there is one.
  // Everything here is additive — a missing, slow or crashed server leaves
  // the editor exactly as it was, with syntax highlighting intact (D14).
  const onLspStatusRef = useRef(onLspStatus);
  onLspStatusRef.current = onLspStatus;
  const setLspStatus = useCallback((status: api.LspStatus | null) => {
    onLspStatusRef.current?.(status);
  }, []);
  const language = path ? languageForPath(path) : null;
  useEffect(() => {
    if (!path || !language || !projectRoot) {
      setLspStatus(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const client = await clientFor(projectHash, projectRoot, language);
        const status = await api.lspStatus(projectHash, language);
        if (cancelled) return;
        setLspStatus(status);
        if (!client) return;
        viewRef.current?.dispatch({
          effects: lspCompartment.current.reconfigure(
            client.plugin(
              fileUri(projectRoot, path),
              documentLanguageId(path) ?? language
            )
          ),
        });
      } catch (err) {
        if (!cancelled) {
          setLspStatus({
            language,
            state: "unsupported",
            server: null,
            restarts: 0,
            detail: describeError(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectHash, projectRoot, path, language, viewSeq]);

  // A crash, a restart or a disable all arrive as a status event; the bar
  // has to follow them or D14's states are invisible.
  useEffect(() => {
    if (!language) return;
    const off = listen<api.LspStatus>("lsp-status", (event) => {
      if (event.payload.language === language) setLspStatus(event.payload);
    });
    return () => {
      void off.then((fn) => fn());
    };
  }, [language]);

  // Live-reconfigure the font on a settings change, without waiting for the
  // next file switch to remount the view (mirrors languageCompartment's use
  // for per-file language selection).
  useEffect(() => {
    const onFontChanged = () => {
      viewRef.current?.dispatch({
        effects: fontCompartment.current.reconfigure(editorFontTheme()),
      });
    };
    const onWrapChanged = () => {
      viewRef.current?.dispatch({
        effects: wrapCompartment.current.reconfigure(
          loadEditorWrap() ? EditorView.lineWrapping : []
        ),
      });
    };
    const onCompletionSettingsChanged = () => {
      viewRef.current?.dispatch({
        effects: fimCompartment.current.reconfigure(
          fimCompletion(loadCompletionSettings(), projectHash, path ?? "")
        ),
      });
    };
    window.addEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
    window.addEventListener(EDITOR_WRAP_CHANGED_EVENT, onWrapChanged);
    window.addEventListener(
      COMPLETION_SETTINGS_CHANGED_EVENT,
      onCompletionSettingsChanged
    );
    return () => {
      window.removeEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
      window.removeEventListener(EDITOR_WRAP_CHANGED_EVENT, onWrapChanged);
      window.removeEventListener(
        COMPLETION_SETTINGS_CHANGED_EVENT,
        onCompletionSettingsChanged
      );
    };
  }, [projectHash, path]);

  // Scroll a searched-for line into view once the document is actually
  // there. Keyed on the event rather than the line so jumping to the same
  // result twice still moves the cursor back to it.
  useEffect(() => {
    if (!revealLine || !path || revealLine.path !== path || viewSeq === 0)
      return;
    const view = viewRef.current;
    if (!view) return;
    const lineCount = view.state.doc.lines;
    const target = Math.min(Math.max(revealLine.line, 1), lineCount);
    const line = view.state.doc.line(target);
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
  }, [revealLine, path, viewSeq]);

  // Seed the WYSIWYG editor from the CodeMirror doc whenever a Markdown file
  // is loaded. CodeMirror stays the source of truth, so this is a one-way
  // pull at the view-build boundary.
  useEffect(() => {
    if (!isMarkdownPath(path) || viewSeq === 0) return;
    setMdValue(viewRef.current?.state.doc.toString() ?? "");
  }, [path, viewSeq]);

  // Keep the WYSIWYG editor's color mode in sync with the app's theme. The
  // app sets `data-theme` on <html>; when it's "auto" the system preference
  // decides. We watch both so cycling the theme updates the RTE live.
  useEffect(() => {
    const update = () => setColorMode(resolvedColorMode());
    update();
    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => {
      themeObserver.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);

  // Cmd+Shift+V toggles the Markdown preview pane, but only for Markdown
  // files. Bound at the window level so it works whether focus is in the
  // WYSIWYG editor or its preview.
  useEffect(() => {
    if (!isMarkdownPath(path)) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.shiftKey && event.key.toLowerCase() === "v") {
        event.preventDefault();
        onToggleMdPreviewRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path]);

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
        color="danger"
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
            if (mediaKind !== "image" || !(event.ctrlKey || event.metaKey))
              return;
            event.preventDefault();
            setImageZoom((z) => clampZoom(z - event.deltaY * 0.01));
          }}
        >
          {mediaKind === "image" ? (
            <img
              src={mediaSrc}
              alt={path}
              style={{ transform: `scale(${imageZoom})` }}
            />
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
        <span className="ds-breadcrumbs" data-testid="breadcrumbs">
          <span>{projectName ?? "—"}</span>
          <span className="ds-crumb-sep">/</span>
          <span className="ds-crumb-active ds-editor-path">{path}</span>
        </span>
        <span className="ds-editor-spacer" />
        {formatResult && (
          <span
            className="ds-editor-format-result"
            data-testid="format-on-save-result"
          >
            {formatResult}
          </span>
        )}
        {saved && <span className="ds-editor-saved">Saved</span>}
        <button
          className="ds-editor-save-btn"
          onClick={() => save()}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : dirty ? "Save *" : "Save"}
        </button>
      </div>
      {conflict && (
        <Alert
          color="warn"
          variant="light"
          m="8px 16px 0"
          title="Changed on disk"
          data-testid="file-conflict-banner"
        >
          <p>
            {path} was changed by something else — the agent, a branch switch,
            or another editor — and you have unsaved edits. Only one version can
            survive.
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
      {isMarkdownPath(path) && (
        <div className="ds-editor-body ds-md-rich" data-testid="file-editor-md">
          <MDEditor
            value={mdValue}
            onChange={handleMdChange}
            data-color-mode={colorMode}
            preview={mdPreview ? "live" : "edit"}
            height="100%"
          />
        </div>
      )}
      {/* CodeMirror stays mounted (hidden for Markdown files) so it remains
       * the source of truth for save/dirty/session state. The WYSIWYG editor
       * writes back through `view.dispatch`. */}
      <div
        className="ds-editor-body"
        ref={hostRef}
        data-testid="file-editor-cm"
        style={isMarkdownPath(path) ? { display: "none" } : undefined}
      />
    </div>
  );
}
