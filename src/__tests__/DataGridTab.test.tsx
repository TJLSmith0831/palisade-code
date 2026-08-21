import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import DataGridTab from "../DataGridTab";
import * as api from "../api";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

vi.mock("../api", () => ({
  dbFetchPage: vi.fn(),
  dbPreviewEdits: vi.fn(),
  dbApplyEdits: vi.fn(),
}));

const mocked = api as unknown as {
  dbFetchPage: ReturnType<typeof vi.fn>;
  dbPreviewEdits: ReturnType<typeof vi.fn>;
  dbApplyEdits: ReturnType<typeof vi.fn>;
};

const page = (over: Partial<api.DbPage> = {}): api.DbPage => ({
  columns: [
    { name: "id", dataType: "int4", primaryKey: true },
    { name: "name", dataType: "text", primaryKey: false },
    { name: "note", dataType: "text", primaryKey: false },
  ],
  // Row 1 has a NULL note, row 2 an empty string — the pair the grid must not
  // render the same way.
  rows: [
    ["1", "ada", null],
    ["2", "grace", ""],
  ],
  page: 0,
  pageSize: 200,
  hasMore: false,
  editable: true,
  ...over,
});

const tab = () => (
  <DataGridTab
    projectHash="h"
    connectionId="c1"
    connectionName="dev"
    schema={null}
    table="users"
  />
);

const editCell = async (label: string, value: string) => {
  const cells = await screen.findAllByTestId("db-cell");
  const cell = cells.find((c) => c.textContent === label)!;
  fireEvent.doubleClick(cell);
  const input = await screen.findByLabelText("name value");
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
  return cell;
};

/** Apply now always confirms (user chose "require confirm on every Apply") —
 * this drives both clicks so existing-behavior tests don't repeat the pair. */
const clickApplyAndConfirm = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  fireEvent.click(await screen.findByTestId("db-confirm-apply-submit"));
};

beforeEach(() => {
  mocked.dbFetchPage.mockReset().mockResolvedValue(page());
  mocked.dbPreviewEdits
    .mockReset()
    .mockResolvedValue(['UPDATE "users" SET "name" = \'Ada\' WHERE ...;']);
  mocked.dbApplyEdits.mockReset().mockResolvedValue(1);
});

describe("DataGridTab", () => {
  it("renders NULL as its own mark, distinct from an empty string", async () => {
    render(tab());
    const grid = await screen.findByTestId("db-grid");
    expect(within(grid).getAllByTestId("db-null")).toHaveLength(1);
    // The empty-string cell exists and is blank — not labelled NULL.
    const cells = within(grid).getAllByTestId("db-cell");
    expect(cells.filter((c) => c.textContent === "")).toHaveLength(1);
  });

  it("says a table is read-only, and why, when it has no primary key", async () => {
    mocked.dbFetchPage.mockResolvedValue(
      page({ editable: false, columns: [{ name: "a", dataType: "text", primaryKey: false }], rows: [["x"]] })
    );
    render(tab());
    expect(await screen.findByText("Read-only")).toBeTruthy();
    const cell = (await screen.findAllByTestId("db-cell"))[0];
    expect(cell.getAttribute("title")).toMatch(/no primary key/i);
    fireEvent.doubleClick(cell);
    expect(screen.queryByLabelText("a value")).toBeNull();
  });

  it("stages an edit rather than writing it, then applies the batch after confirming", async () => {
    render(tab());
    await editCell("ada", "Ada");

    expect(await screen.findByTestId("db-commit-bar")).toBeTruthy();
    expect(screen.getByText("1 row with pending changes")).toBeTruthy();
    expect(mocked.dbApplyEdits).not.toHaveBeenCalled();

    await clickApplyAndConfirm();
    await waitFor(() => expect(mocked.dbApplyEdits).toHaveBeenCalledTimes(1));
    // The whole original row travels with the edit — that is what the WHERE
    // clause matches on, and what makes a concurrent change detectable (D10).
    expect(mocked.dbApplyEdits).toHaveBeenCalledWith("h", "c1", null, "users", [
      {
        original: { id: "1", name: "ada", note: null },
        changes: { name: "Ada" },
      },
    ]);
  });

  it("requires confirmation before Apply writes anything, and Cancel writes nothing", async () => {
    render(tab());
    await editCell("ada", "Ada");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await screen.findByTestId("db-confirm-apply-submit");
    expect(mocked.dbApplyEdits).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("db-confirm-apply-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("db-confirm-apply-submit")).toBeNull()
    );
    expect(mocked.dbApplyEdits).not.toHaveBeenCalled();
    // The edit is still staged — cancelling the confirm is not discarding.
    expect(screen.getByTestId("db-commit-bar")).toBeTruthy();
  });

  it("shows the SQL before it runs, and still confirms Apply from the preview modal", async () => {
    render(tab());
    await editCell("ada", "Ada");
    fireEvent.click(screen.getByRole("button", { name: "Preview SQL" }));
    expect(await screen.findByTestId("db-preview-sql")).toBeTruthy();
    expect(screen.getByText(/UPDATE "users" SET/)).toBeTruthy();
    expect(mocked.dbApplyEdits).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("db-preview-apply"));
    fireEvent.click(await screen.findByTestId("db-confirm-apply-submit"));
    await waitFor(() => expect(mocked.dbApplyEdits).toHaveBeenCalledTimes(1));
  });

  it("keeps a conflict on screen and leaves the edits staged", async () => {
    mocked.dbApplyEdits.mockRejectedValue(
      "conflict: the row where id=1 changed in the database since it was loaded"
    );
    render(tab());
    await editCell("ada", "Ada");
    await clickApplyAndConfirm();

    expect(await screen.findByTestId("db-grid-error")).toBeTruthy();
    expect(screen.getByText(/conflict/)).toBeTruthy();
    expect(screen.getByTestId("db-commit-bar")).toBeTruthy();
  });

  it("will not refetch under pending edits, which would discard them", async () => {
    render(tab());
    await editCell("ada", "Ada");
    const sort = screen.getByRole("button", { name: "Sort by name" });
    expect(sort.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("textbox", { name: "Filter rows" }).hasAttribute("disabled")
    ).toBe(true);
  });

  it("says so when a table has no rows", async () => {
    mocked.dbFetchPage.mockResolvedValue(page({ rows: [] }));
    render(tab());
    expect(await screen.findByTestId("db-grid-empty")).toBeTruthy();
    expect(screen.getByText("No rows")).toBeTruthy();
  });

  it("sets a cell to NULL from a keyboard click on the ∅ control, not only a mouse one", async () => {
    render(tab());
    const cells = await screen.findAllByTestId("db-cell");
    const cell = cells.find((c) => c.textContent === "ada")!;
    fireEvent.doubleClick(cell);
    const nullButton = await screen.findByLabelText("Set to NULL");
    // Keyboard activation (Enter/Space on a focused button) fires a bare
    // click with no preceding mousedown — this must still work.
    fireEvent.click(nullButton);
    expect(await screen.findByTestId("db-commit-bar")).toBeTruthy();
  });

  it("lets a staged cell be reverted from the open editor, not only via right-click", async () => {
    render(tab());
    await editCell("ada", "Ada");
    const cells = await screen.findAllByTestId("db-cell");
    fireEvent.doubleClick(cells.find((c) => c.textContent === "Ada")!);
    const revert = await screen.findByLabelText("Revert to original value");
    fireEvent.click(revert);
    expect(screen.queryByTestId("db-commit-bar")).toBeNull();
  });

  it("returns focus to the cell after a keyboard commit, instead of dropping it", async () => {
    render(tab());
    await editCell("ada", "Ada");
    // The commit re-renders the cell (span <-> input swap), so re-find it by
    // its new value rather than trust the pre-edit DOM node's identity.
    const committed = await screen.findAllByTestId("db-cell");
    const cell = committed.find((c) => c.textContent === "Ada")!;
    await waitFor(() => expect(document.activeElement).toBe(cell));
  });

  it("returns focus to the cell after Escape cancels an edit", async () => {
    render(tab());
    const cells = await screen.findAllByTestId("db-cell");
    fireEvent.doubleClick(cells.find((c) => c.textContent === "ada")!);
    const input = await screen.findByLabelText("name value");
    fireEvent.keyDown(input, { key: "Escape" });
    const after = await screen.findAllByTestId("db-cell");
    const cell = after.find((c) => c.textContent === "ada")!;
    await waitFor(() => expect(document.activeElement).toBe(cell));
  });

  it("shows which column the filter box matches, defaulting to the first column", async () => {
    render(tab());
    await screen.findByTestId("db-grid");
    expect(screen.getByPlaceholderText("Filter id…")).toBeTruthy();
    const columnPicker = screen.getByRole("combobox", { name: "Filter column" });
    expect(columnPicker).toHaveValue("id");
  });

  it("re-labels the filter box once a value narrows it to a specific column", async () => {
    render(tab());
    const input = await screen.findByRole("textbox", { name: "Filter rows" });
    fireEvent.change(input, { target: { value: "a" } });
    // The typed filter is bound to whatever column the picker currently shows
    // (defaulting to the first column, "id") — the placeholder names it rather
    // than leaving the user to guess or remember (P1: filter-column blindness).
    expect(screen.getByPlaceholderText("Filter id…")).toBeTruthy();
  });
});
