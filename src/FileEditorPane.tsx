import { useEffect, useState } from "react";
import * as api from "./api";

type Props = {
  projectHash: string;
  path: string | null;
};

// ponytail: renders every line as a DOM row — fine for source files, add
// virtualization if someone opens a multi-thousand-line generated file.
export default function FileEditorPane({ projectHash, path }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContent(null);
    setError(null);
    if (!path) return;
    api.readFileContent(projectHash, path).then(setContent, (err) => setError(String(err)));
  }, [projectHash, path]);

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
  if (content === null) {
    return <p className="empty">Loading…</p>;
  }

  const lines = content.split("\n");
  return (
    <div className="ds-code-editor" data-testid="file-editor">
      <div className="ds-code-scroll">
        {lines.map((line, i) => (
          <div className="ds-code-row" key={i}>
            <span className="ds-code-lineno">{i + 1}</span>
            <span className="ds-code-text">{line.length ? line : " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
