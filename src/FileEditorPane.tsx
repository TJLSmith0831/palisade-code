import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "./api";

type Props = {
  projectHash: string;
  path: string | null;
  onSave?: (edit: { path: string; before: string; after: string }) => void;
};

export default function FileEditorPane({ projectHash, path, onSave }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setContent(null);
    setDraft(null);
    setError(null);
    setSaved(false);
    if (!path) return;
    api
      .readFileContent(projectHash, path)
      .then((text) => {
        setContent(text);
        setDraft(text);
      })
      .catch((err) => setError(String(err)));
  }, [projectHash, path]);

  const dirty = draft !== content;

  const save = useCallback(() => {
    if (!path || draft === null || saving) return;
    setSaving(true);
    setError(null);
    api
      .writeFileContent(projectHash, path, draft)
      .then(() => {
        onSave?.({ path, before: content!, after: draft });
        setContent(draft);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setSaving(false));
  }, [projectHash, path, draft, saving]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

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
  if (draft === null) {
    return <p className="empty">Loading…</p>;
  }

  const lines = draft.split("\n");
  const lineCount = lines.length;

  return (
    <div className="ds-code-editor" data-testid="file-editor">
      <div className="ds-editor-toolbar">
        <span className="ds-editor-path">{path}</span>
        <span className="ds-editor-spacer" />
        {saved && <span className="ds-editor-saved">Saved</span>}
        <button
          className="ds-editor-save-btn"
          onClick={save}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : dirty ? "Save *" : "Save"}
        </button>
      </div>
      <div className="ds-editor-body">
        <div className="ds-code-gutter" aria-hidden>
          {Array.from({ length: lineCount }, (_, i) => (
            <div className="ds-code-lineno" key={i}>
              {i + 1}
            </div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          className="ds-code-textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          data-testid="file-editor-textarea"
        />
      </div>
    </div>
  );
}
