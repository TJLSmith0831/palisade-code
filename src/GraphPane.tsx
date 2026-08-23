import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Select,
  TextInput,
} from "@mantine/core";
import { listen } from "@tauri-apps/api/event";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";

import * as api from "./api";
import type { GraphifyOptions, GraphifyRun } from "./api";
import { describeError } from "./errors";
import GraphView from "./GraphView";

type Props = {
  projectHash: string;
};

export default function GraphPane({ projectHash }: Props) {
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
          .runGraphify(projectHash, "", {
            incremental: false,
            codeOnly: true,
            deep: false,
          })
          .then(
            (fresh) => {
              if (!cancelled) setRun(fresh);
            },
            (err) => {
              if (!cancelled) setError(describeError(err));
            }
          )
          .finally(() => {
            if (!cancelled) setBusy(false);
          });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [projectHash]);

  // The always-on `graphify watch` process refreshes graph.json in the
  // background; pick up its changes without a manual re-run.
  useEffect(() => {
    const updated = listen<string>("graphify-updated", ({ payload }) => {
      if (payload === projectHash)
        api.loadGraphify(projectHash).then(setRun, () => {});
    });
    return () => {
      updated.then((un) => un());
    };
  }, [projectHash]);

  const onRun = async () => {
    setBusy(true);
    setError(null);
    try {
      setRun(await api.runGraphify(projectHash, subpath, options));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const onQuery = async () => {
    // `path` takes two node names; `query`/`explain` take one question —
    // the real CLI shape (`graphify path "A" "B"`).
    const args =
      subcommand === "path" ? [pathA.trim(), pathB.trim()] : [question.trim()];
    if (args.some((arg) => !arg)) return;
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.queryGraphify(projectHash, subcommand, args));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const nodes = Array.isArray(run?.graph?.nodes)
    ? run.graph.nodes.length
    : null;
  const links = Array.isArray(run?.graph?.links)
    ? run.graph.links.length
    : null;

  return (
    <div className="graph-pane" data-testid="graph-pane">
      <div className="pane-head">
        <TextInput
          className="scope"
          size="xs"
          flex={1}
          value={subpath}
          onChange={(event) => {
            const next = event.target.value;
            setSubpath(next);
            // `graphify update` has no --out override (D24) — it can't be
            // scoped to a subdirectory without writing outside where the
            // pane reads from, so incremental only applies to the whole
            // project.
            if (next.trim() && options.incremental)
              setOptions({ ...options, incremental: false });
          }}
          placeholder="whole project (or a subdirectory)"
          aria-label="Subdirectory scope"
          data-testid="graph-scope"
        />
        {(
          [
            ["incremental", "Incremental"],
            ["deep", "Deep scan"],
          ] as const
        ).map(([key, label]) => (
          <Checkbox
            key={key}
            size="xs"
            label={label}
            checked={options[key]}
            disabled={key === "incremental" && subpath.trim() !== ""}
            onChange={(event) =>
              setOptions({ ...options, [key]: event.currentTarget.checked })
            }
            data-testid={`graph-${key}`}
          />
        ))}
        <div className="spacer" />
        <Button
          size="xs"
          variant="default"
          onClick={onRun}
          disabled={busy}
          data-testid="graph-run"
        >
          {busy ? "Running…" : run ? "Re-run" : "Run Graphify"}
        </Button>
      </div>

      {error && (
        <Alert
          color="danger"
          variant="light"
          m="12px 16px 0"
          style={{ whiteSpace: "pre-wrap" }}
          data-testid="graph-error"
        >
          {error}
        </Alert>
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
            <Select
              size="xs"
              w={104}
              allowDeselect={false}
              value={subcommand}
              onChange={(value) => value && setSubcommand(value)}
              data={["query", "path", "explain"]}
              aria-label="Query type"
              data-testid="graph-subcommand"
            />
            {subcommand === "path" ? (
              <>
                <TextInput
                  size="xs"
                  flex={1}
                  value={pathA}
                  onChange={(event) => setPathA(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && onQuery()}
                  placeholder="Node A"
                  aria-label="Node A"
                  data-testid="graph-question-a"
                />
                <TextInput
                  size="xs"
                  flex={1}
                  value={pathB}
                  onChange={(event) => setPathB(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && onQuery()}
                  placeholder="Node B"
                  aria-label="Node B"
                  data-testid="graph-question-b"
                />
              </>
            ) : (
              <TextInput
                size="xs"
                flex={1}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && onQuery()}
                placeholder="Ask the graph…"
                aria-label="Ask the graph"
                data-testid="graph-question"
              />
            )}
            <Button
              size="xs"
              variant="default"
              onClick={onQuery}
              disabled={busy}
              data-testid="graph-ask"
            >
              Ask
            </Button>
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
        !error && (
          <p className="empty">
            {busy
              ? "Compiling codebase map…"
              : "No code map yet. Run Graphify to build one."}
          </p>
        )
      )}
    </div>
  );
}
