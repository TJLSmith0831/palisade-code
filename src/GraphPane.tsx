import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import MDEditor from "@uiw/react-md-editor";

import * as api from "./api";
import type { GraphifyOptions, GraphifyRun } from "./api";
import GraphView from "./GraphView";

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
  const [pathA, setPathA] = useState("");
  const [pathB, setPathB] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);

  // A previous run's output is still on disk; show it without re-extracting.
  // If there isn't one, compile it automatically so a freshly opened project
  // shows its codebase map without a manual "Run Graphify" click.
  useEffect(() => {
    let cancelled = false;
    setRun(null);
    setError(null);
    setAnswer(null);
    api.loadGraphify(projectHash).then(
      (loaded) => {
        if (!cancelled) setRun(loaded);
      },
      () => {
        setBusy(true);
        api
          .runGraphify(projectHash, null, "", { incremental: false, codeOnly: true, deep: false })
          .then(
            (fresh) => {
              if (!cancelled) setRun(fresh);
            },
            (err) => {
              if (!cancelled) setError(String(err));
            },
          )
          .finally(() => {
            if (!cancelled) setBusy(false);
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectHash]);

  // The always-on `graphify watch` process refreshes graph.json in the
  // background; pick up its changes without a manual re-run.
  useEffect(() => {
    const updated = listen<string>("graphify-updated", ({ payload }) => {
      if (payload === projectHash) api.loadGraphify(projectHash).then(setRun, () => {});
    });
    return () => {
      updated.then((un) => un());
    };
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
    // `path` takes two node names; `query`/`explain` take one question —
    // the real CLI shape (`graphify path "A" "B"`).
    const args = subcommand === "path" ? [pathA.trim(), pathB.trim()] : [question.trim()];
    if (args.some((arg) => !arg)) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.queryGraphify(projectHash, subcommand, args));
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
        <strong>Codebase Map</strong>
        <input
          className="scope"
          value={subpath}
          onChange={(event) => {
            const next = event.target.value;
            setSubpath(next);
            // `graphify update` has no --out override (D24) — it can't be
            // scoped to a subdirectory without writing outside where the
            // pane reads from, so incremental only applies to the whole
            // project.
            if (next.trim() && options.incremental) setOptions({ ...options, incremental: false });
          }}
          placeholder="whole project (or a subdirectory)"
          data-testid="graph-scope"
        />
        {(["incremental", "deep"] as const).map((key) => (
          <label key={key} className="toggle">
            <input
              type="checkbox"
              checked={options[key]}
              disabled={key === "incremental" && subpath.trim() !== ""}
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

          {run.graph && <GraphView graph={run.graph} />}

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
            {subcommand === "path" ? (
              <>
                <input
                  value={pathA}
                  onChange={(event) => setPathA(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && onQuery()}
                  placeholder="Node A"
                  data-testid="graph-question-a"
                />
                <input
                  value={pathB}
                  onChange={(event) => setPathB(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && onQuery()}
                  placeholder="Node B"
                  data-testid="graph-question-b"
                />
              </>
            ) : (
              <input
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && onQuery()}
                placeholder="Ask the graph…"
                data-testid="graph-question"
              />
            )}
            <button onClick={onQuery} disabled={busy} data-testid="graph-ask">
              Ask
            </button>
          </div>
          {answer && (
            <pre className="tool-body" data-testid="graph-answer">
              {answer}
            </pre>
          )}

          <details className="graph-report-wrap">
            <summary>Report (GRAPH_REPORT.md)</summary>
            <div className="graph-report" data-testid="graph-report">
              <MDEditor.Markdown source={run.report} />
            </div>
          </details>
        </div>
      ) : (
        !error && <p className="empty">{busy ? "Compiling codebase map…" : "No code map yet. Run Graphify to build one."}</p>
      )}
    </div>
  );
}
