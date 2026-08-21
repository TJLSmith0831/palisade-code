import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Code, Group, Loader, Modal, Text } from "@mantine/core";
import { IconAlertTriangle, IconPlayerPlay } from "@tabler/icons-react";
import { Compartment, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import * as api from "./api";
import { loadLanguageFor } from "./codeLanguage";
import DataGrid from "./DataGrid";
import { codeColorTheme, codeHighlightStyle } from "./FileEditorPane";

// The free-form SQL console for one connection.
//
// It runs whatever the user writes — a read-only console isn't a console — but
// a statement that deletes or restructures data without a narrowing condition
// goes behind a confirm step first (D12). The matcher lives in the backend, so
// there is one definition of "destructive" rather than two that can drift.

export default function SqlQueryTab({
  projectHash,
  connectionId,
  connectionName,
  initialSql = "",
}: {
  projectHash: string;
  connectionId: string;
  connectionName: string;
  /** Seed text for a freshly opened editor. */
  initialSql?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [sql, setSql] = useState(initialSql);
  const [result, setResult] = useState<api.DbQueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const execute = useCallback(
    (statement: string) => {
      setRunning(true);
      setError(null);
      setConfirming(false);
      api
        .dbRunQuery(projectHash, connectionId, statement)
        .then(setResult)
        // The database's own message, shown in place — not a toast that is
        // gone before you have finished reading which column it named (D18).
        .catch((e) => setError(String(e)))
        .finally(() => setRunning(false));
    },
    [projectHash, connectionId]
  );

  const run = useCallback(
    (statement: string) => {
      const trimmed = statement.trim();
      if (!trimmed) return;
      api
        .dbIsDestructive(trimmed)
        .then((destructive) =>
          destructive ? setConfirming(true) : execute(trimmed)
        )
        .catch((e) => setError(String(e)));
    },
    [execute]
  );

  // The keymap needs the latest text without re-mounting the editor on every
  // keystroke, so it reads through a ref rather than closing over state.
  const runRef = useRef(run);
  const sqlRef = useRef(sql);
  useEffect(() => {
    runRef.current = run;
    sqlRef.current = sql;
  }, [run, sql]);

  useEffect(() => {
    if (!host.current) return;
    let cancelled = false;
    const language = new Compartment();
    const view = new EditorView({
      doc: initialSql,
      parent: host.current,
      extensions: [
        basicSetup,
        // Same token colors as every other CodeMirror surface in the app —
        // basicSetup alone pulls in CodeMirror's stock highlight style, which
        // reads noticeably worse against this app's dark theme.
        codeHighlightStyle,
        codeColorTheme,
        language.of([]),
        Prec.highest(
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                runRef.current(sqlRef.current);
                return true;
              },
            },
          ])
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) setSql(update.state.doc.toString());
        }),
      ],
    });
    // Same on-demand language pack a `.sql` file gets in the editor, rather
    // than a second SQL grammar bundled just for this tab.
    void loadLanguageFor("query.sql").then((extension) => {
      if (!cancelled && extension) {
        view.dispatch({ effects: language.reconfigure(extension) });
      }
    });
    return () => {
      cancelled = true;
      view.destroy();
    };
  }, [initialSql]);

  return (
    <div className="ds-db-tab" data-testid="db-query-tab">
      <Group gap="xs" p="xs" className="ds-db-toolbar" justify="space-between">
        <Text size="xs" c="dimmed" ff="monospace">
          {connectionName}
        </Text>
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            ⌘⏎
          </Text>
          <Button
            size="xs"
            leftSection={<IconPlayerPlay size={13} />}
            loading={running}
            disabled={!sql.trim()}
            onClick={() => run(sql)}
          >
            Run
          </Button>
        </Group>
      </Group>

      <div className="ds-db-sql" ref={host} data-testid="db-sql-editor" />

      {error && (
        <Alert
          variant="light"
          color="red"
          icon={<IconAlertTriangle size={14} />}
          m="xs"
          data-testid="db-query-error"
          withCloseButton
          onClose={() => setError(null)}
        >
          <Text size="xs" style={{ wordBreak: "break-word" }}>
            {error}
          </Text>
        </Alert>
      )}

      {running && <Loader size="xs" m="md" />}

      {!running && result && result.rowsAffected !== null && (
        <Text size="xs" p="md" data-testid="db-rows-affected">
          {result.rowsAffected} row{result.rowsAffected === 1 ? "" : "s"} affected.
        </Text>
      )}

      {!running && result && result.rowsAffected === null && (
        <DataGrid
          columns={result.columns}
          rows={result.rows}
          empty="The query returned no rows."
        />
      )}

      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="This statement changes or removes data"
        data-testid="db-confirm"
      >
        <Text size="sm" mb="xs">
          It deletes or restructures without a narrowing condition. Run this
          against <strong>{connectionName}</strong>?
        </Text>
        <Code block data-testid="db-confirm-sql">
          {sql.trim()}
        </Code>
        <Group gap="xs" justify="flex-end" mt="md">
          <Button size="xs" variant="subtle" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button size="xs" color="red" onClick={() => execute(sql.trim())}>
            Run it
          </Button>
        </Group>
      </Modal>
    </div>
  );
}
