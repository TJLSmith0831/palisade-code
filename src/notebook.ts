// nbformat v4 doc model, parsed/edited/serialized entirely on the frontend
// (decisions.md D16) — Rust owns kernel processes only, never notebook
// content. Save is always whole-document (design.md D7): there's no patch
// format for nbformat worth building for files this small.

export type CellType = "code" | "markdown";

export type StreamOutput = { output_type: "stream"; name: "stdout" | "stderr"; text: string[] };
export type ExecuteResultOutput = {
  output_type: "execute_result";
  execution_count: number | null;
  data: Record<string, string[] | string>;
};
export type DisplayDataOutput = {
  output_type: "display_data";
  data: Record<string, string[] | string>;
};
export type ErrorOutput = {
  output_type: "error";
  ename: string;
  evalue: string;
  traceback: string[];
};
export type CellOutput = StreamOutput | ExecuteResultOutput | DisplayDataOutput | ErrorOutput;

export type Cell = {
  id: string;
  cell_type: CellType;
  source: string;
  outputs: CellOutput[];
  execution_count: number | null;
};

export type NotebookDoc = {
  cells: Cell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
};

/** The notebook's own recorded kernel name (`metadata.kernelspec.name`), or
 *  `null` when the file doesn't record one. Passed to the backend for
 *  resolution (design.md D4) — parsing stays here, resolution stays in Rust. */
export function kernelspecName(doc: NotebookDoc): string | null {
  const kernelspec = doc.metadata?.kernelspec as { name?: string } | undefined;
  return kernelspec?.name ?? null;
}

function joinSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join("") : source;
}

let cellIdSeq = 0;
function nextCellId(): string {
  cellIdSeq += 1;
  return `cell-${Date.now()}-${cellIdSeq}`;
}

/** Throws on anything that isn't a parseable nbformat v4 document — callers
 *  fall back to opening the file in FileEditorPane instead (design.md
 *  Migration Plan), same as any other unopenable file. */
export function parseNotebook(json: string): NotebookDoc {
  const raw = JSON.parse(json);
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.cells)) {
    throw new Error("not a notebook: missing cells array");
  }
  const cells: Cell[] = raw.cells.map((cell: Record<string, unknown>) => ({
    id: typeof cell.id === "string" ? cell.id : nextCellId(),
    cell_type: cell.cell_type === "markdown" ? "markdown" : "code",
    source: joinSource((cell.source as string | string[]) ?? ""),
    outputs: Array.isArray(cell.outputs) ? (cell.outputs as CellOutput[]) : [],
    execution_count:
      typeof cell.execution_count === "number" ? cell.execution_count : null,
  }));
  return {
    cells,
    metadata: (raw.metadata as Record<string, unknown>) ?? {},
    nbformat: typeof raw.nbformat === "number" ? raw.nbformat : 4,
    nbformat_minor: typeof raw.nbformat_minor === "number" ? raw.nbformat_minor : 5,
  };
}

/** nbformat stores `source` as a list of lines (each ending in `\n` except
 *  the last) rather than one string — matches what Jupyter itself writes,
 *  so a round-tripped file doesn't show as changed in `git diff`. */
function splitSource(source: string): string[] {
  if (source === "") return [];
  const lines = source.split("\n");
  return lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line));
}

export function serializeNotebook(doc: NotebookDoc): string {
  const raw = {
    cells: doc.cells.map((cell) => ({
      id: cell.id,
      cell_type: cell.cell_type,
      source: splitSource(cell.source),
      outputs: cell.cell_type === "code" ? cell.outputs : undefined,
      execution_count: cell.cell_type === "code" ? cell.execution_count : undefined,
      metadata: {},
    })),
    metadata: doc.metadata,
    nbformat: doc.nbformat,
    nbformat_minor: doc.nbformat_minor,
  };
  return JSON.stringify(raw, null, 1) + "\n";
}

export function newCell(cell_type: CellType = "code"): Cell {
  return { id: nextCellId(), cell_type, source: "", outputs: [], execution_count: null };
}

export function insertCell(doc: NotebookDoc, index: number, cell: Cell): NotebookDoc {
  const cells = doc.cells.slice();
  cells.splice(index, 0, cell);
  return { ...doc, cells };
}

export function deleteCell(doc: NotebookDoc, cellId: string): NotebookDoc {
  return { ...doc, cells: doc.cells.filter((c) => c.id !== cellId) };
}

export function moveCell(doc: NotebookDoc, cellId: string, direction: "up" | "down"): NotebookDoc {
  const index = doc.cells.findIndex((c) => c.id === cellId);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || swapWith < 0 || swapWith >= doc.cells.length) return doc;
  const cells = doc.cells.slice();
  [cells[index], cells[swapWith]] = [cells[swapWith], cells[index]];
  return { ...doc, cells };
}

export function setCellType(doc: NotebookDoc, cellId: string, cell_type: CellType): NotebookDoc {
  return {
    ...doc,
    cells: doc.cells.map((c) => (c.id === cellId ? { ...c, cell_type } : c)),
  };
}

export function setCellSource(doc: NotebookDoc, cellId: string, source: string): NotebookDoc {
  return {
    ...doc,
    cells: doc.cells.map((c) => (c.id === cellId ? { ...c, source } : c)),
  };
}
