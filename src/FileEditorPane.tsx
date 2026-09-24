import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Alert, Button, Group, Loader, Menu, Modal, Textarea } from "@mantine/core";
import { IconBold, IconCode, IconH2, IconItalic, IconLink, IconList, IconMinus, IconPhoto, IconPlus, IconQuote, IconTable, IconCheckbox, IconDots } from "@tabler/icons-react";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  dropCursor,
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
  indentOnInput,
  foldGutter,
  codeFolding,
  foldKeymap,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  findNext,
  findPrevious,
  gotoLine,
  openSearchPanel,
} from "@codemirror/search";
import { jumpToDefinition } from "@codemirror/lsp-client";
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import {
  languageExtensionFor,
  loadLanguageFor,
  mediaKindFor,
  mimeTypeFor,
} from "./codeLanguage";
import { definitionClick } from "./definitionClick";
import { describeError } from "./errors";
import { documentLanguageId, fileUri, languageForPath } from "./lsp";
import { clientFor } from "./lspClients";
import { isMarkdownPath } from "./openTabs";
import { markdownVisual } from "./markdownVisual";
import { formatMarkdown, type MarkdownFormat } from "./markdownFormat";
export { markdownPreviewSchema } from "./markdownVisual";
import {
  setTestMarkers,
  testMarkerGutter,
  type TestMarker,
} from "./testGutter";
import {
  breakpointGutter,
  setBreakpoints as setEditorBreakpoints,
  setDebugLine,
} from "./breakpointGutter";
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
  /** Failing tests to mark in the gutter, from the last verify run. Purely
   * additive: an empty list (or a run nobody has done) leaves the editor
   * exactly as it was. */
  testMarkers?: TestMarker[];
  /** Breakpoints to draw in the gutter for this file. */
  breakpoints?: api.Breakpoint[];
  /** A gutter click: places a breakpoint or removes the one already there. */
  onToggleBreakpoint?: (line: number) => void;
  /** The line execution is stopped on, when it is stopped in this file. */
  debugLine?: number | null;
  /** Whether to show exact Markdown source instead of Visual mode. */
  mdSource?: boolean;
  onToggleMdSource?: () => void;
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
    boxShadow: "var(--shadow-float)",
    fontSize: "12px",
    // A hover-doc signature has no natural width limit (generics, long
    // arrow types), so without a cap the card stretches to fit the content
    // instead of wrapping it.
    maxWidth: "420px",
  },
  ".cm-tooltip .cm-tooltip-arrow:before": {
    borderTopColor: "var(--border)",
    borderBottomColor: "var(--border)",
  },
  ".cm-tooltip .cm-tooltip-arrow:after": {
    borderTopColor: "var(--surface)",
    borderBottomColor: "var(--surface)",
  },
  // The LSP hover card (`.cm-lsp-documentation`) renders a signature block
  // above a markdown-derived prose description. The library's own base
  // theme gives it 7px of horizontal padding and nothing else — no header
  // treatment, no wrap guarantee, no font split. This mirrors the
  // signature-header-then-body layout of a mature IDE's quick-doc popup
  // (e.g. PyCharm/IntelliJ): the signature gets its own full-bleed header
  // strip with a divider, everything else is padded body copy. Two-Voice
  // Rule still applies: signature stays mono, prose gets the sans default.
  ".cm-tooltip .cm-lsp-documentation": {
    padding: 0,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  ".cm-tooltip .cm-lsp-documentation > pre:first-child": {
    margin: "0 0 8px",
    padding: "8px 10px",
    background: "var(--surface-warm)",
    borderBottom: "1px solid var(--border)",
    // Matches the card's own 6px radius (DESIGN.md's documented top-only
    // rounding pattern) so the header's top corners sit flush inside it.
    borderRadius: "6px 6px 0 0",
    fontFamily: "var(--mono)",
    // A bare `pre` carries its own UA-stylesheet `white-space: pre`, which
    // wins over the inherited `pre-wrap` on the parent — this is the one
    // element in the popup that actually needs the wrap, so it has to be
    // set here directly rather than relying on inheritance.
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  ".cm-tooltip .cm-lsp-documentation > :not(pre:first-child)": {
    padding: "0 10px",
  },
  ".cm-tooltip .cm-lsp-documentation > :last-child": {
    marginBottom: "8px",
  },
  ".cm-tooltip .cm-lsp-documentation p": {
    fontSize: "13px",
    lineHeight: "1.5",
    margin: "6px 0",
  },
  ".cm-tooltip .cm-lsp-documentation ul": {
    margin: "6px 0",
    paddingLeft: "16px",
  },
  ".cm-tooltip .cm-lsp-documentation li": {
    fontSize: "12px",
    lineHeight: "1.5",
    marginBottom: "2px",
  },
  ".cm-tooltip .cm-lsp-documentation li code, .cm-tooltip .cm-lsp-documentation p code": {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    padding: "0 4px",
    borderRadius: "4px",
    fontSize: "11px",
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
export const codeColorTheme = EditorView.theme({
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
export const codeHighlightStyle = syntaxHighlighting(
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
  testMarkers,
  breakpoints,
  onToggleBreakpoint,
  debugLine,
  mdSource = false,
  onToggleMdSource,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageCompartment = useRef(new Compartment());
  const visualCompartment = useRef(new Compartment());
  const fontCompartment = useRef(new Compartment());
  const wrapCompartment = useRef(new Compartment());
  const fimCompartment = useRef(new Compartment());
  // The LSP plugin arrives after a round-trip to the backend, so it goes in
  // its own compartment rather than blocking the file from opening.
  const lspCompartment = useRef(new Compartment());
  const focusedPathRef = useRef<string | null>(null);
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
  const onToggleMdSourceRef = useRef(onToggleMdSource);
  onToggleMdSourceRef.current = onToggleMdSource;
  const onToggleBreakpointRef = useRef(onToggleBreakpoint);
  onToggleBreakpointRef.current = onToggleBreakpoint;

  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  const [sourceEdit, setSourceEdit] = useState<{
    from: number; to: number; before: string; value: string; label: string;
  } | null>(null);
  const [sourceEditStale, setSourceEditStale] = useState(false);
  const mdSourceRef = useRef(mdSource);
  mdSourceRef.current = mdSource;
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

  // The single place `dirty` changes: local state and the tab list's copy
  // are set together, in the same call, so the two can never observe a
  // different order than the caller wrote them in. An effect reacting to
  // `dirty` here would re-report it a render late — exactly the gap that let
  // a save's `onSave` callback (which can swap this pane for another editor,
  // e.g. notebook recovery) run before the tab list heard the buffer was
  // clean. Tagged with `path`, not `forPath`-at-callback-time, because the
  // tab list owns dirtiness per path and an untagged report would land on
  // whichever tab happened to be active.
  const markDirty = useCallback(
    (next: boolean) => {
      setDirty(next);
      if (path) onDirtyChange?.(path, next);
    },
    [path, onDirtyChange]
  );

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
          // A successful save can switch this pane to another editor (notebook
          // recovery does this). Clear dirtiness — locally and in the tab
          // list, atomically via markDirty — before that parent callback has
          // a chance to replace this component.
          markDirty(false);
          onSaveRef.current?.({ path, before: baselineRef.current, after });
          baselineRef.current = after;
          sessions.set(sessionKey(projectHash, path), {
            json: view.state.toJSON(SERIALIZED_FIELDS),
            baseline: after,
          });
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
    [projectHash, path, saving, markDirty]
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  const editMarkdownBlock = useCallback((from: number, to: number, label: string) => {
    const before = viewRef.current?.state.doc.sliceString(from, to);
    if (before !== undefined) {
      setSourceEditStale(false);
      setSourceEdit({ from, to, before, value: before, label });
    }
  }, []);

  const applyMarkdownBlock = useCallback(() => {
    const view = viewRef.current;
    if (!view || !sourceEdit) return;
    if (view.state.doc.sliceString(sourceEdit.from, sourceEdit.to) !== sourceEdit.before) {
      setSourceEditStale(true);
      return;
    }
    view.dispatch({ changes: { from: sourceEdit.from, to: sourceEdit.to, insert: sourceEdit.value } });
    setSourceEdit(null);
    view.focus();
  }, [sourceEdit]);

  const applyFormat = useCallback((kind: MarkdownFormat) => {
    const view = viewRef.current;
    if (view) formatMarkdown(view, kind);
  }, []);

  const buildExtensions = useCallback(
    (forPath: string) => [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      closeBrackets(),
      bracketMatching(),
      // Re-indent as you type a closing bracket or `else`, and show where a
      // dragged selection will land — both things a hand expects from an
      // editor and notices only when missing.
      indentOnInput(),
      dropCursor(),
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
      testMarkerGutter(),
      // Read through a ref: the extension list is built once per file load,
      // and closing over the callback directly would freeze the first one.
      breakpointGutter((line) => onToggleBreakpointRef.current?.(line)),
      definitionClick(),
      keymap.of([
        { key: "Mod-s", run: () => (saveRef.current(), true) },
        { key: "Mod-b", run: (view) => isMarkdownPath(forPath) && !mdSourceRef.current && (formatMarkdown(view, "bold"), true) },
        { key: "Mod-i", run: (view) => isMarkdownPath(forPath) && !mdSourceRef.current && (formatMarkdown(view, "italic"), true) },
        { key: "Mod-k", run: (view) => isMarkdownPath(forPath) && !mdSourceRef.current && (formatMarkdown(view, "link"), true) },
        ...closeBracketsKeymap,
        ...searchKeymap,
        ...foldKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      languageCompartment.current.of(languageExtensionFor(forPath)),
      EditorView.contentAttributes.of({ "aria-label": isMarkdownPath(forPath) ? "Markdown document" : `Editor for ${forPath}` }),
      visualCompartment.current.of(
        isMarkdownPath(forPath) && !mdSourceRef.current
          ? markdownVisual(editMarkdownBlock, projectHash, forPath)
          : []
      ),
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
        markDirty(update.state.doc.toString() !== baselineRef.current);
      }),
      wrapCompartment.current.of(
        loadEditorWrap() ? EditorView.lineWrapping : []
      ),
      fontCompartment.current.of(editorFontTheme()),
    ],
    [projectHash, path, markDirty, editMarkdownBlock]
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
      markDirty(docOf(cached) !== cached.baseline);
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
        markDirty(false);
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
  }, [projectHash, path, reloadToken, markDirty]);

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
    // Focus follows the file the user just opened, so typing works at once.
    // Not on a rebuild of the same path (an external reload), which would
    // steal focus from whatever they were typing into.
    if (focusedPathRef.current !== path) {
      focusedPathRef.current = path;
      const active = document.activeElement;
      const typing =
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement;
      if (!typing) view.focus();
    }
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

  // Push the failing-test markers into the view. Keyed on viewSeq too, so a
  // file that is re-opened (or reloaded from disk) gets its markers back
  // rather than showing a bare gutter until the next test run.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || viewSeq === 0) return;
    view.dispatch({ effects: setTestMarkers.of(testMarkers ?? []) });
  }, [testMarkers, viewSeq, path]);

  // Push breakpoints and the stopped line into the view. Keyed on viewSeq so
  // re-opening a file restores its breakpoints rather than showing a bare
  // gutter until the next toggle.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || viewSeq === 0) return;
    view.dispatch({ effects: setEditorBreakpoints.of(breakpoints ?? []) });
  }, [breakpoints, viewSeq, path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || viewSeq === 0) return;
    view.dispatch({ effects: setDebugLine.of(debugLine ?? null) });
  }, [debugLine, viewSeq, path]);

  // Both modes are one CodeMirror document; changing modes only changes its
  // presentation extension, never the buffer, history, or selection.
  useEffect(() => {
    if (!isMarkdownPath(path) || viewSeq === 0) return;
    viewRef.current?.dispatch({
      effects: visualCompartment.current.reconfigure(
        mdSource ? [] : markdownVisual(editMarkdownBlock, projectHash, path ?? "")
      ),
    });
  }, [path, viewSeq, mdSource, editMarkdownBlock, projectHash]);

  // Cmd+Shift+V toggles Visual/Markdown while focus is in the document.
  useEffect(() => {
    if (!isMarkdownPath(path)) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "v"
      ) {
        event.preventDefault();
        onToggleMdSourceRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path]);

  // The native Edit and Go menus cannot use WebKit's responder chain for
  // CodeMirror-specific actions. Keep that platform adapter at the editor
  // boundary: App only emits a stable command id, and the focused view owns
  // the actual CodeMirror operation (including its search panel and LSP
  // client). Ordinary inputs and terminals continue to use native roles.
  useEffect(() => {
    const onNativeEditorCommand = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (command === "save") return void saveRef.current();
      const view = viewRef.current;
      if (!view) return;
      switch (command) {
        case "find": openSearchPanel(view); break;
        case "findNext": findNext(view); break;
        case "findPrevious": findPrevious(view); break;
        case "goToLine": gotoLine(view); break;
        case "goToDefinition": jumpToDefinition(view); break;
        default: return;
      }
      view.focus();
    };
    window.addEventListener("palisade-editor-command", onNativeEditorCommand);
    return () => window.removeEventListener("palisade-editor-command", onNativeEditorCommand);
  }, [path, viewSeq]);

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
    if (!mediaSrc)
      return (
        <p className="empty is-loading" role="status" data-testid="file-editor-loading">
          <Loader size="xs" /> Loading…
        </p>
      );
    return (
      <div className="ds-media-preview" data-testid="file-editor-media">
        <div className="ds-editor-toolbar">
          <span className="ds-editor-path">{path}</span>
          {mediaKind === "image" && (
            <>
              <span className="ds-editor-spacer" />
              <ActionIcon
                variant="subtle"
                className="ds-icon-btn"
                onClick={() => setImageZoom((z) => clampZoom(z - 0.25))}
                title="Zoom out"
                aria-label="Zoom out"
                data-testid="image-zoom-out"
              >
                <IconMinus size={14} />
              </ActionIcon>
              <span className="ds-zoom-level" data-testid="image-zoom-level">
                {Math.round(imageZoom * 100)}%
              </span>
              <ActionIcon
                variant="subtle"
                className="ds-icon-btn"
                onClick={() => setImageZoom((z) => clampZoom(z + 0.25))}
                title="Zoom in"
                aria-label="Zoom in"
                data-testid="image-zoom-in"
              >
                <IconPlus size={14} />
              </ActionIcon>
              <Button
                variant="subtle"
                size="xs"
                className="ds-icon-btn"
                onClick={() => setImageZoom(1)}
                title="Reset zoom"
                data-testid="image-zoom-reset"
              >
                Reset
              </Button>
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
    return (
      <p className="empty is-loading" role="status" data-testid="file-editor-loading">
        <Loader size="xs" /> Loading…
      </p>
    );
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
      {isMarkdownPath(path) && !mdSource && (
        <div className="ds-md-format-toolbar" role="toolbar" aria-label="Markdown formatting">
          <ActionIcon variant="subtle" aria-label="Bold" title="Bold (⌘B)" onClick={() => applyFormat("bold")}><IconBold size={17} /></ActionIcon>
          <ActionIcon variant="subtle" aria-label="Italic" title="Italic (⌘I)" onClick={() => applyFormat("italic")}><IconItalic size={17} /></ActionIcon>
          <ActionIcon variant="subtle" aria-label="Heading" title="Heading" onClick={() => applyFormat("heading")}><IconH2 size={17} /></ActionIcon>
          <ActionIcon variant="subtle" aria-label="List" title="List" onClick={() => applyFormat("list")}><IconList size={17} /></ActionIcon>
          <ActionIcon variant="subtle" aria-label="Link" title="Link (⌘K)" onClick={() => applyFormat("link")}><IconLink size={17} /></ActionIcon>
          <Menu withinPortal position="bottom-start">
            <Menu.Target><ActionIcon variant="subtle" aria-label="More formatting" title="More formatting"><IconDots size={17} /></ActionIcon></Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconCheckbox size={16} />} onClick={() => applyFormat("task")}>Task</Menu.Item>
              <Menu.Item leftSection={<IconQuote size={16} />} onClick={() => applyFormat("quote")}>Quote</Menu.Item>
              <Menu.Item leftSection={<IconCode size={16} />} onClick={() => applyFormat("code")}>Inline code</Menu.Item>
              <Menu.Item leftSection={<IconPhoto size={16} />} onClick={() => applyFormat("image")}>Image</Menu.Item>
              <Menu.Item leftSection={<IconTable size={16} />} onClick={() => applyFormat("table")}>Table</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
      )}
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
      <div
        className={`ds-editor-body${isMarkdownPath(path) && !mdSource ? " ds-md-visual" : ""}`}
        ref={hostRef}
        data-testid="file-editor-cm"
      />
      <Modal opened={sourceEdit !== null} onClose={() => setSourceEdit(null)} title={sourceEdit?.label} centered>
        {sourceEditStale && <Alert color="warn" mb="sm">This block changed while you were editing it. Close and reopen it to avoid overwriting newer text.</Alert>}
        <Textarea
          aria-label={sourceEdit?.label}
          rows={8}
          value={sourceEdit?.value ?? ""}
          onChange={(event) => setSourceEdit((current) => current && { ...current, value: event.target.value })}
        />
        <Group justify="flex-end" mt="md">
          <Button variant="subtle" onClick={() => setSourceEdit(null)}>Cancel</Button>
          <Button onClick={applyMarkdownBlock} disabled={sourceEditStale}>Apply</Button>
        </Group>
      </Modal>
    </div>
  );
}
