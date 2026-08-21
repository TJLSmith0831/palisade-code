import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import SqlQueryTab from "../SqlQueryTab";
import * as api from "../api";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

vi.mock("../api", () => ({
  dbRunQuery: vi.fn(),
  dbIsDestructive: vi.fn(),
}));

const mocked = api as unknown as {
  dbRunQuery: ReturnType<typeof vi.fn>;
  dbIsDestructive: ReturnType<typeof vi.fn>;
};

const tab = (initialSql: string) => (
  <SqlQueryTab
    projectHash="h"
    connectionId="c1"
    connectionName="dev"
    initialSql={initialSql}
  />
);

beforeEach(() => {
  mocked.dbRunQuery.mockReset().mockResolvedValue({
    columns: ["id"],
    rows: [["1"]],
    rowsAffected: null,
  });
  mocked.dbIsDestructive.mockReset().mockResolvedValue(false);
});

describe("SqlQueryTab", () => {
  it("runs an ordinary query without asking twice", async () => {
    render(tab("SELECT id FROM users"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(mocked.dbRunQuery).toHaveBeenCalledWith("h", "c1", "SELECT id FROM users")
    );
    expect(await screen.findByTestId("db-grid")).toBeTruthy();
    expect(screen.queryByText(/changes or removes data/i)).toBeNull();
  });

  it("holds a destructive statement behind a confirm step", async () => {
    mocked.dbIsDestructive.mockResolvedValue(true);
    render(tab("DELETE FROM users"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText(/changes or removes data/i)).toBeTruthy();
    // The exact statement is shown before it runs — not just generic copy.
    expect(screen.getByTestId("db-confirm-sql")).toHaveTextContent(
      "DELETE FROM users"
    );
    expect(mocked.dbRunQuery).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    await waitFor(() =>
      expect(mocked.dbRunQuery).toHaveBeenCalledWith("h", "c1", "DELETE FROM users")
    );
  });

  it("lets the confirm step be declined without running anything", async () => {
    mocked.dbIsDestructive.mockResolvedValue(true);
    render(tab("DROP TABLE users"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(mocked.dbRunQuery).not.toHaveBeenCalled();
  });

  it("reports an affected-row count for a statement that returns none", async () => {
    mocked.dbRunQuery.mockResolvedValue({
      columns: [],
      rows: [],
      rowsAffected: 2,
    });
    render(tab("UPDATE users SET note = 'x' WHERE id > 1"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByTestId("db-rows-affected")).toBeTruthy();
    expect(screen.getByText("2 rows affected.")).toBeTruthy();
  });

  it("keeps the database's own error on screen", async () => {
    mocked.dbRunQuery.mockRejectedValue('query: no such table: nope');
    render(tab("SELECT * FROM nope"));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByTestId("db-query-error")).toBeTruthy();
    expect(screen.getByText(/no such table: nope/)).toBeTruthy();
  });
});
