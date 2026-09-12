import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ActionIcon, Alert, Badge, Button, Group, Image, Loader, Menu, Stack, Text } from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconMarkdown,
  IconPlayerPlay,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { Prec } from "@codemirror/state";
import { python } from "@codemirror/lang-python";
import MDEditor from "@uiw/react-md-editor";
import rehypeSanitize from "rehype-sanitize";
import * as api from "./api";
import type { NotebookEnvelope, NotebookWarning } from "./api";
import { codeColorTheme, codeHighlightStyle, markdownPreviewSchema } from "./FileEditorPane";
import {
  appendOutput,
  Cell,
  CellOutput,
  deleteCell,
  insertCell,
  kernelspecName,
  moveCell,
  joinLines,
  newCell,
  NotebookDoc,
  outputFromEvent,
  parseNotebook,
  serializeNotebook,
  setCellSource,
  setCellType,
} from "./notebook";

/** One code cell's CodeMirror instance — mounted once, mirrors
 *  SqlQueryTab's single-editor pattern (basicSetup + the app's shared
 *  highlight theme, no LSP/FIM per notebook-editor spec's "code cells
 *  display with syntax highlighting" requirement, deliberately not the
 *  file editor's full LSP/FIM stack). */
function CellEditor({
  source,
  onChange,
  onRun,
  colorMode,
}: {
  source: string;
  onChange: (value: string) => void;
  onRun: () => void;
  colorMode: "light" | "dark";
}) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  useEffect(() => {
    onChangeRef.current = onChange;
    onRunRef.current = onRun;
  }, [onChange, onRun]);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      doc: source,
      parent: host.current,
      extensions: [
        basicSetup,
        codeHighlightStyle,
        codeColorTheme,
        python(),
        Prec.highest(
          keymap.of([
            { key: "Shift-Enter", run: () => (onRunRef.current(), true) },
            { key: "Mod-Enter", run: () => (onRunRef.current(), true) },
          ])
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    return () => view.destroy();
    // Mounted once per cell instance (keyed by cell id in the parent list);
    // `source` is the seed doc, not a controlled value — external changes
    // to it (e.g. undo) aren't expected for a first cut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} className="ds-notebook-cell-editor" data-color-mode={colorMode} />;
}

// Kernel tracebacks arrive with the ANSI color codes IPython renders for a
// terminal; nothing here interprets them, so they'd show up as literal escape
// sequences in the output block.
const ANSI = /\u001b\[[0-9;]*m/g;

function OutputBlock({ output }: { output: CellOutput }) {
  if (output.output_type === "stream") {
    return <pre className="ds-notebook-output-text">{joinLines(output.text)}</pre>;
  }
  if (output.output_type === "execute_result" || output.output_type === "display_data") {
    const data = output.data ?? {};
    const png = joinLines(data["image/png"]);
    if (png) {
      // alignSelf: the output Stack is a flex column, so a bare image would
      // be stretched to the full pane width instead of its natural size.
      return (
        <Image
          className="ds-notebook-output-image"
          src={`data:image/png;base64,${png}`}
          alt="cell output"
          w="auto"
          maw="100%"
          fit="contain"
          style={{ alignSelf: "flex-start" }}
        />
      );
    }
    // Unsupported rich types (text/html and friends) fall back to the
    // text/plain nbformat always carries alongside them.
    return <pre className="ds-notebook-output-text">{joinLines(data["text/plain"])}</pre>;
  }
  if (output.output_type === "error") {
    const traceback = output.traceback.join("\n").replace(ANSI, "");
    return (
      <pre className="ds-notebook-output-error">
        {traceback || `${output.ename}: ${output.evalue}`}
      </pre>
    );
  }
  return null;
}

export default function NotebookTab({
  projectHash,
  path,
  onDirtyChange,
  onUnopenable,
}: {
  projectHash: string;
  path: string;
  onDirtyChange: (path: string, dirty: boolean) => void;
  /** Malformed nbformat JSON — parent falls back to FileEditorPane
   *  (design.md Migration Plan). */
  onUnopenable: () => void;
}) {
  const [doc, setDoc] = useState<NotebookDoc | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runningCellId, setRunningCellId] = useState<string | null>(null);
  const [kernelStarting, setKernelStarting] = useState(false);
  const [outputsByCellRun, setOutputsByCellRun] = useState<Map<string, CellOutput[]>>(new Map());
  const [warning, setWarning] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [colorMode] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light"
  );

  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  const savedContent = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setLoadError(null);
    api
      .readFileContent(projectHash, path)
      .then((content) => {
        if (cancelled) return;
        try {
          const parsed = parseNotebook(content);
          savedContent.current = content;
          setDoc(parsed);
        } catch {
          onUnopenable();
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(String(err));
      });
    return () => {
      cancelled = true;
    };
    // `onUnopenable` is a stable callback from the parent's render function;
    // re-running this on its identity would reload the file every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectHash, path]);

  const markDirty = useCallback(
    (next: NotebookDoc) => {
      setDoc(next);
      setDirty(true);
      onDirtyChange(path, true);
    },
    [onDirtyChange, path]
  );

  const save = useCallback(
    async (toSave: NotebookDoc) => {
      const content = serializeNotebook(toSave);
      await api.writeFileContent(projectHash, path, content, savedContent.current);
      savedContent.current = content;
      setDirty(false);
      onDirtyChange(path, false);
    },
    [onDirtyChange, path, projectHash]
  );

  // File > Save reaches every editable pane through the same command, so the
  // native row is honest here too: a notebook is not a CodeMirror buffer and
  // has no window-level Cmd+S handler the menu accelerator could fall back on.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onNativeEditorCommand = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== "save") return;
      const current = docRef.current;
      if (current) void saveRef.current(current);
    };
    window.addEventListener("palisade-editor-command", onNativeEditorCommand);
    return () => window.removeEventListener("palisade-editor-command", onNativeEditorCommand);
  }, []);

  // The live output map, held in a ref as well as state: the event listener
  // below closes over stale state otherwise, and adding the map to its deps
  // would re-subscribe the listener on every streamed chunk. Every writer
  // updates both, so the ref is always current — including within the tick
  // an ExecuteReply arrives in.
  const outputsRef = useRef(outputsByCellRun);

  // notebook-event / notebook-warning: driver events for *this* notebook's
  // kernel only (`notebookId` matches `notebook::notebook_id` on the Rust
  // side — see notebook.rs).
  useEffect(() => {
    const notebookId = `${projectHash}::${path}`;
    const eventUnlisten = listen<NotebookEnvelope>("notebook-event", ({ payload }) => {
      if (payload.notebookId !== notebookId) return;
      const event = payload.event;
      const kind = event.event as string;
      const cellId = event.cellId as string | undefined;

      // Any event at all means the kernel is up — "Started" only fires on
      // the first spawn, so clearing the badge on that alone would leave it
      // stuck on every later run.
      setKernelStarting(false);
      if (kind === "Started") return;
      if (kind === "Restarted") {
        // Nothing in flight survives a restart, so no ExecuteReply is coming
        // for a cell that was mid-run — clear it here or its spinner sticks.
        setRunningCellId(null);
        outputsRef.current = new Map();
        setOutputsByCellRun(new Map());
        return;
      }
      if (kind === "Crashed") {
        setKernelStarting(false);
        setRunningCellId(null);
        setWarning(`Notebook kernel crashed: ${String(event.message ?? "unknown error")}`);
        return;
      }
      if (!cellId) return;

      if (kind === "ExecuteReply") {
        setRunningCellId(null);
        const current = docRef.current;
        if (!current) return;
        const executionCount = (event.executionCount as number | null) ?? null;
        const collected = outputsRef.current.get(cellId) ?? [];
        const next: NotebookDoc = {
          ...current,
          cells: current.cells.map((c) =>
            c.id === cellId ? { ...c, outputs: collected, execution_count: executionCount } : c
          ),
        };
        setDoc(next);
        void save(next);
        return;
      }

      // Stream/ExecuteResult/DisplayData/Error: accumulate for this cell's
      // current run, and show live in the outputs map immediately.
      // Converted to its nbformat output here, on arrival, so the live list
      // and the one loaded from the file are the same shape (see
      // outputFromEvent). Written through the ref synchronously rather than
      // via the state updater: ExecuteReply can arrive in the same tick as
      // the output events, before a state update has been applied, and the
      // snapshot it takes would otherwise be empty.
      const output = outputFromEvent(event);
      if (!output) return;
      const next = new Map(outputsRef.current);
      next.set(cellId, appendOutput(next.get(cellId) ?? [], output));
      outputsRef.current = next;
      setOutputsByCellRun(next);
    });

    const warningUnlisten = listen<NotebookWarning>("notebook-warning", ({ payload }) => {
      if (payload.notebookId !== notebookId) return;
      setWarning(payload.message);
    });

    return () => {
      void eventUnlisten.then((f) => f());
      void warningUnlisten.then((f) => f());
    };
  }, [projectHash, path, save]);


  useEffect(() => {
    return () => {
      void api.closeNotebookKernel(projectHash, path);
    };
    // Tab-close cleanup (design.md D6) — fires once, on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(
    (cell: Cell) => {
      // The driver can technically queue multiple executions, but the UI
      // stores one active cell and snapshots output on each reply. Letting a
      // second cell start before the first settles can therefore clear the
      // first spinner and race its automatic save.
      if (!doc || runningCellId !== null) return;
      setWarning(null);
      const cleared = new Map(outputsRef.current);
      cleared.set(cell.id, []);
      outputsRef.current = cleared;
      setOutputsByCellRun(cleared);
      setRunningCellId(cell.id);
      setKernelStarting(true);
      api
        .runNotebookCell(projectHash, path, kernelspecName(doc), cell.id, cell.source)
        .catch((err) => {
          setRunningCellId(null);
          setKernelStarting(false);
          setWarning(String(err));
        });
    },
    [doc, path, projectHash, runningCellId]
  );

  const interrupt = useCallback(() => {
    void api.interruptNotebookKernel(projectHash, path);
  }, [projectHash, path]);

  const restart = useCallback(() => {
    void api.restartNotebookKernel(projectHash, path);
  }, [projectHash, path]);

  if (loadError) {
    return (
      <Alert color="danger" icon={<IconAlertTriangle size={16} />} m="md" title="Couldn't open notebook">
        {loadError}
      </Alert>
    );
  }
  if (!doc) {
    return (
      <Group justify="center" p="xl">
        <Loader size="sm" />
      </Group>
    );
  }

  return (
    // flex/mih/overflow: the editor column is a flex box that doesn't scroll,
    // so a notebook taller than the pane was simply clipped — it has to be its
    // own scroll container.
    <Stack gap="sm" p="md" className="ds-notebook-tab" flex={1} mih={0} style={{ overflowY: "auto" }}>
      <Group justify="space-between">
        <Group gap="xs">
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => markDirty(insertCell(doc, doc.cells.length, newCell()))}>
            Add cell
          </Button>
          {dirty && <Badge color="warn">Unsaved</Badge>}
          {kernelStarting && (
            <Badge color="blue" leftSection={<Loader size={10} color="white" />}>
              Starting kernel…
            </Badge>
          )}
        </Group>
        <Group gap="xs">
          <Button size="xs" variant="default" leftSection={<IconPlayerStop size={14} />} onClick={interrupt}>
            Interrupt
          </Button>
          <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={restart}>
            Restart kernel
          </Button>
          <Button size="xs" disabled={!dirty} onClick={() => void save(doc)}>
            Save
          </Button>
        </Group>
      </Group>

      {warning && (
        <Alert color="warn" icon={<IconAlertTriangle size={16} />} withCloseButton onClose={() => setWarning(null)}>
          {warning}
        </Alert>
      )}

      {doc.cells.map((cell, index) => {
        const outputs = outputsByCellRun.get(cell.id) ?? cell.outputs;
        const isRunning = runningCellId === cell.id;
        return (
          <Stack key={cell.id} gap={4} className="ds-notebook-cell" data-testid={`notebook-cell-${index}`}>
            <Group gap={4} justify="space-between">
              <Group gap={4}>
                {cell.cell_type === "code" && (
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    loading={isRunning}
                    disabled={runningCellId !== null && !isRunning}
                    onClick={() => run(cell)}
                    aria-label={`Run cell ${index + 1}`}
                    data-testid={`run-cell-${index}`}
                  >
                    <IconPlayerPlay size={14} />
                  </ActionIcon>
                )}
                <Text size="xs" c="dimmed">
                  {cell.cell_type === "code" ? `[${cell.execution_count ?? " "}]` : "markdown"}
                </Text>
              </Group>
              <Group gap={2}>
                <ActionIcon size="sm" variant="subtle" aria-label={`Move cell ${index + 1} up`} onClick={() => markDirty(moveCell(doc, cell.id, "up"))}>
                  <IconArrowUp size={14} />
                </ActionIcon>
                <ActionIcon size="sm" variant="subtle" aria-label={`Move cell ${index + 1} down`} onClick={() => markDirty(moveCell(doc, cell.id, "down"))}>
                  <IconArrowDown size={14} />
                </ActionIcon>
                <Menu>
                  <Menu.Target>
                    <ActionIcon size="sm" variant="subtle" aria-label={`Change cell ${index + 1} type`}>
                      <IconMarkdown size={14} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => markDirty(setCellType(doc, cell.id, "code"))}>Code</Menu.Item>
                    <Menu.Item onClick={() => markDirty(setCellType(doc, cell.id, "markdown"))}>Markdown</Menu.Item>
                  </Menu.Dropdown>
                </Menu>
                <ActionIcon size="sm" variant="subtle" color="danger" aria-label={`Delete cell ${index + 1}`} onClick={() => markDirty(deleteCell(doc, cell.id))}>
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            </Group>

            {cell.cell_type === "markdown" ? (
              <div
                onDoubleClick={(e) => e.currentTarget.querySelector("textarea")?.focus()}
                className="ds-notebook-markdown"
              >
                <MDEditor.Markdown
                  source={cell.source || "*empty*"}
                  rehypePlugins={[[rehypeSanitize, markdownPreviewSchema]]}
                />
                <textarea
                  className="ds-notebook-markdown-source"
                  value={cell.source}
                  onChange={(e) => markDirty(setCellSource(doc, cell.id, e.target.value))}
                  placeholder="Markdown source"
                />
              </div>
            ) : (
              <CellEditor
                source={cell.source}
                onChange={(value) => markDirty(setCellSource(doc, cell.id, value))}
                onRun={() => run(cell)}
                colorMode={colorMode}
              />
            )}

            {outputs.length > 0 && (
              <Stack gap={2} className="ds-notebook-output">
                {outputs.map((output, i) => (
                  <OutputBlock key={i} output={output} />
                ))}
              </Stack>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}
