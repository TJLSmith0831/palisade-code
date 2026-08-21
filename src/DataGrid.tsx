import type { ReactNode } from "react";
import { Table, Text } from "@mantine/core";
import type { DbCell } from "./api";

// The result grid, shared by the table tab and the SQL editor's results.
//
// Values arrive as text with `null` for SQL NULL, and NULL is drawn as its own
// mark rather than as blank text — a NULL and an empty string must never look
// the same, because setting one is not the same edit as setting the other.

export function NullMark() {
  return (
    <Text component="span" size="xs" c="dimmed" fs="italic" data-testid="db-null">
      NULL
    </Text>
  );
}

/** The default read-only rendering of one value. */
export const renderValue = (value: DbCell): ReactNode =>
  value === null ? <NullMark /> : value;

export default function DataGrid({
  columns,
  rows,
  renderCell = (_row, _column, value) => renderValue(value),
  empty = "No rows",
  header,
}: {
  columns: string[];
  rows: DbCell[][];
  /** Lets the owner draw an editable cell in place of plain text. */
  renderCell?: (row: number, column: number, value: DbCell) => ReactNode;
  /** What an empty result says — never a blank void (D18). */
  empty?: string;
  /** Optional per-column adornment (sort/filter controls). */
  header?: (column: string, index: number) => ReactNode;
}) {
  if (columns.length === 0 && rows.length === 0) {
    return (
      <Text size="xs" c="dimmed" p="md" data-testid="db-grid-empty">
        {empty}
      </Text>
    );
  }
  return (
    <div className="ds-db-grid-scroll" data-testid="db-grid">
      <Table
        striped
        highlightOnHover
        withTableBorder
        withColumnBorders
        stickyHeader
        horizontalSpacing="xs"
        verticalSpacing={4}
        className="ds-db-grid"
      >
        <Table.Thead>
          <Table.Tr>
            {columns.map((column, index) => (
              <Table.Th key={column} scope="col">
                {header ? header(column, index) : column}
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row, rowIndex) => (
            <Table.Tr key={rowIndex}>
              {row.map((value, columnIndex) => (
                <Table.Td key={columnIndex}>
                  {renderCell(rowIndex, columnIndex, value)}
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {rows.length === 0 && (
        <Text size="xs" c="dimmed" p="md" data-testid="db-grid-empty">
          {empty}
        </Text>
      )}
    </div>
  );
}
