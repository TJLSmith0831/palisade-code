import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import DatabasePanel from "../DatabasePanel";
import * as api from "../api";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

vi.mock("../api", () => ({
  dbListConnections: vi.fn(),
  dbAddConnection: vi.fn(),
  dbRemoveConnection: vi.fn(),
  dbRenameConnection: vi.fn(),
  dbListTables: vi.fn(),
}));

const mocked = api as unknown as {
  dbListConnections: ReturnType<typeof vi.fn>;
  dbAddConnection: ReturnType<typeof vi.fn>;
  dbRemoveConnection: ReturnType<typeof vi.fn>;
  dbRenameConnection: ReturnType<typeof vi.fn>;
  dbListTables: ReturnType<typeof vi.fn>;
};

const dev: api.DbConnection = {
  id: "c1",
  name: "dev",
  url: "postgres://localhost/dev",
  backend: "postgres",
};

const onOpenTable = vi.fn();
const onOpenQuery = vi.fn();

const panel = () => (
  <DatabasePanel
    projectHash="h"
    onOpenTable={onOpenTable}
    onOpenQuery={onOpenQuery}
  />
);

beforeEach(() => {
  onOpenTable.mockReset();
  onOpenQuery.mockReset();
  mocked.dbListConnections.mockReset().mockResolvedValue([]);
  mocked.dbAddConnection.mockReset().mockResolvedValue(dev);
  mocked.dbRemoveConnection.mockReset().mockResolvedValue(undefined);
  mocked.dbRenameConnection.mockReset().mockResolvedValue({ ...dev, name: "prod" });
  mocked.dbListTables.mockReset().mockResolvedValue([
    { schema: "public", name: "users", kind: "table" },
    { schema: "public", name: "recent", kind: "view" },
  ]);
});

describe("DatabasePanel", () => {
  it("offers a way in rather than a blank panel when nothing is saved", async () => {
    render(panel());
    expect(await screen.findByTestId("db-empty")).toBeTruthy();
    expect(screen.getByText(/no database connections yet/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    expect(screen.getByTestId("db-connection-form")).toBeTruthy();
  });

  it("reports a connection that does not connect instead of saving it", async () => {
    mocked.dbAddConnection.mockRejectedValue("connect to dev: no such host");
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Add connection" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "dev" } });
    fireEvent.change(screen.getByLabelText("Connection string"), {
      target: { value: "postgres://nope/dev" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    // Inline, not a toast (D18) — and the form stays open with the text in it.
    expect(await screen.findByTestId("db-error")).toBeTruthy();
    expect(screen.getByText(/no such host/)).toBeTruthy();
    expect(screen.getByTestId("db-connection-form")).toBeTruthy();
  });

  it("lists tables and views when a connection is expanded, and opens one", async () => {
    mocked.dbListConnections.mockResolvedValue([dev]);
    render(panel());
    fireEvent.click(await screen.findByTestId("db-connection-c1"));

    await waitFor(() => expect(screen.getAllByTestId("db-table")).toHaveLength(2));
    fireEvent.click(screen.getByText("users"));
    expect(onOpenTable).toHaveBeenCalledWith(dev, "public", "users");
  });

  it("keeps the connection row's action icons upright, not chevron-rotated", async () => {
    // Mantine's NavLink auto-rotates rightSection 90deg on expand, treating
    // it as the default chevron unless disableRightSectionRotation is set.
    mocked.dbListConnections.mockResolvedValue([dev]);
    render(panel());
    const row = await screen.findByTestId("db-connection-c1");
    const section = row.querySelector(".mantine-NavLink-section");
    expect(section?.getAttribute("data-rotate")).toBeNull();
  });

  it("renames a connection in place", async () => {
    mocked.dbListConnections.mockResolvedValue([dev]);
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Rename dev" }));
    const input = await screen.findByLabelText("Connection name");
    fireEvent.change(input, { target: { value: "prod" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(mocked.dbRenameConnection).toHaveBeenCalledWith("h", "c1", "prod")
    );
  });

  it("removes a connection", async () => {
    mocked.dbListConnections.mockResolvedValue([dev]);
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Remove dev" }));
    await waitFor(() =>
      expect(mocked.dbRemoveConnection).toHaveBeenCalledWith("h", "c1")
    );
  });

  it("opens the SQL editor for a connection without expanding it", async () => {
    mocked.dbListConnections.mockResolvedValue([dev]);
    render(panel());
    fireEvent.click(
      await screen.findByRole("button", { name: "SQL editor for dev" })
    );
    expect(onOpenQuery).toHaveBeenCalledWith(dev);
    expect(mocked.dbListTables).not.toHaveBeenCalled();
  });
});
