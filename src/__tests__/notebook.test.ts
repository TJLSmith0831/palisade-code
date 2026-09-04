import { describe, expect, it } from "vitest";
import {
  deleteCell,
  insertCell,
  kernelspecName,
  moveCell,
  newCell,
  parseNotebook,
  serializeNotebook,
  setCellSource,
  setCellType,
} from "../notebook";

const fixture = {
  cells: [
    {
      id: "c1",
      cell_type: "markdown",
      source: ["# Title\n", "\n", "Some text."],
      metadata: {},
    },
    {
      id: "c2",
      cell_type: "code",
      source: ["import matplotlib.pyplot as plt\n", "plt.plot([1, 2, 3])"],
      execution_count: 3,
      outputs: [
        {
          output_type: "display_data",
          data: { "image/png": "iVBORw0KGgoAAAANSU=" },
        },
      ],
      metadata: {},
    },
  ],
  metadata: { kernelspec: { name: "python3", display_name: "Python 3" } },
  nbformat: 4,
  nbformat_minor: 5,
};

describe("notebook doc model", () => {
  it("parses nbformat's list-of-lines source into a plain string", () => {
    const doc = parseNotebook(JSON.stringify(fixture));
    expect(doc.cells[0].source).toBe("# Title\n\nSome text.");
    expect(doc.cells[1].cell_type).toBe("code");
    expect(doc.cells[1].execution_count).toBe(3);
    expect(doc.cells[1].outputs).toHaveLength(1);
  });

  it("reads the notebook's own kernelspec name", () => {
    const doc = parseNotebook(JSON.stringify(fixture));
    expect(kernelspecName(doc)).toBe("python3");
  });

  it("round-trips parse -> serialize -> parse to the same structural content", () => {
    const doc = parseNotebook(JSON.stringify(fixture));
    const reparsed = parseNotebook(serializeNotebook(doc));
    expect(reparsed).toEqual(doc);
  });

  it("rejects a file with no cells array", () => {
    expect(() => parseNotebook(JSON.stringify({ nbformat: 4 }))).toThrow();
  });

  it("supports structural edits: add, delete, reorder, retype", () => {
    let doc = parseNotebook(JSON.stringify(fixture));

    doc = insertCell(doc, 1, newCell("code"));
    expect(doc.cells).toHaveLength(3);
    expect(doc.cells[1].cell_type).toBe("code");
    expect(doc.cells[1].source).toBe("");

    doc = setCellSource(doc, doc.cells[1].id, "print('hi')");
    expect(doc.cells[1].source).toBe("print('hi')");

    doc = moveCell(doc, doc.cells[1].id, "up");
    expect(doc.cells[0].source).toBe("print('hi')");

    doc = setCellType(doc, doc.cells[0].id, "markdown");
    expect(doc.cells[0].cell_type).toBe("markdown");
    expect(doc.cells[0].source).toBe("print('hi')");

    const idToDelete = doc.cells[0].id;
    doc = deleteCell(doc, idToDelete);
    expect(doc.cells.find((c) => c.id === idToDelete)).toBeUndefined();
    expect(doc.cells).toHaveLength(2);
  });

  it("moveCell is a no-op at the boundaries", () => {
    const doc = parseNotebook(JSON.stringify(fixture));
    const first = doc.cells[0].id;
    const last = doc.cells[doc.cells.length - 1].id;
    expect(moveCell(doc, first, "up")).toEqual(doc);
    expect(moveCell(doc, last, "down")).toEqual(doc);
  });
});
