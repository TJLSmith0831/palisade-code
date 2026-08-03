import { useEffect, useState } from "react";
import MDEditor from "@uiw/react-md-editor";

import * as api from "./api";
import type { GraphifyOptions, GraphifyRun } from "./api";

type Props = {
  projectHash: string;
  threadId: string | null;
  /** Called after a successful run so the chat pane picks up the injection. */
  onInjected: () => void;
};

export default function GraphPane({ projectHash, threadId, onInjected }: Props) {
  const [run, setRun] = useState<GraphifyRun | null>(null);
  const [subpath, setSubpath] = useState("");
  const [options, setOptions] = useState<GraphifyOptions>({
    incremental: false,
    codeOnly: true,
    deep: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subcommand, setSubcommand] = useState("query");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);

  // A previous run's output is still on disk; show it without re-extracting.
  useEffect(() => {
    setRun(null);
    setError(null);
    setAnswer(null);
    api.loadGraphify(projectHash).then(setRun, () => setRun(null));
  }, [projectHash]);

  const onRun = async () => {
    if (!threadId) {
      setError("Select a thread first — the run summary is injected into it.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setRun(await api.runGraphify(projectHash, threadId, subpath, options));
      onInjected();
    } catch (err) {
      // A failed run shows why here and injects nothing into the thread.
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const onQuery = async () => {
    if (!question.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.queryGraphify(projectHash, subcommand, question.trim()));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const nodes = Array.isArray(run?.graph?.nodes) ? run.graph.nodes.length : null;
  const links = Array.isArray(run?.graph?.links) ? run.graph.links.length : null;

  return (
    <div className="graph-pane" data-testid="graph-pane">
      <div className="pane-head">
        <strong>Code map</strong>
        <input
          className="scope"
          value={subpath}
          onChange={(event) => setSubpath(event.target.value)}
          placeholder="whole project (or a subdirectory)"
          data-testid="graph-scope"
        />
        {(["incremental", "deep"] as const).map((key) => (
          <label key={key} className="toggle">
            <input
              type="checkbox"
              checked={options[key]}
              onChange={(event) => setOptions({ ...options, [key]: event.target.checked })}
              data-testid={`graph-${key}`}
            />
            {key}
          </label>
        ))}
        <div className="spacer" />
        <button onClick={onRun} disabled={busy} data-testid="graph-run">
          {busy ? "running…" : run ? "Re-run" : "Run Graphify"}
        </button>
      </div>

      {error && (
        <div className="graph-error" data-testid="graph-error">
          {error}
        </div>
      )}

      {run ? (
        <div className="graph-body">
          <div className="graph-stats" data-testid="graph-stats">
            <code>{run.outDir}</code>
            {nodes !== null && <span>{nodes} nodes</span>}
            {links !== null && <span>{links} edges</span>}
            {run.graph === null && <span className="dim">no graph.json</span>}
          </div>

          <div className="graph-query">
            <select
              value={subcommand}
              onChange={(event) => setSubcommand(event.target.value)}
              data-testid="graph-subcommand"
            >
              <option value="query">query</option>
              <option value="path">path</option>
              <option value="explain">explain</option>
            </select>
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && onQuery()}
              placeholder="Ask the graph…"
              data-testid="graph-question"
            />
            <button onClick={onQuery} disabled={busy} data-testid="graph-ask">
              Ask
            </button>
          </div>
          {answer && (
            <pre className="tool-body" data-testid="graph-answer">
              {answer}
            </pre>
          )}

          <div className="graph-report" data-testid="graph-report">
            <MDEditor.Markdown source={run.report} />
          </div>
        </div>
      ) : (
        !error && <p className="empty">No code map yet. Run Graphify to build one.</p>
      )}
    </div>
  );
}
