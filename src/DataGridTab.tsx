import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Menu,
  Modal,
  Select,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowNarrowDown,
  IconArrowNarrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconFilter,
  IconLock,
} from "@tabler/icons-react";
import * as api from "./api";
import DataGrid, { renderValue } from "./DataGrid";

// One table's rows, in the centre workspace.
//
// Edits stage here and go nowhere until Apply, which runs them as one
// transaction after showing the exact SQL (D2/D11). While anything is pending,
// paging, sorting and filtering are disabled: refetching would throw the
// pending edits away, and silently losing typed-in work is worse than a
// disabled button that says why.

/** rowIndex -> column -> the value the user typed (null means SQL NULL). */
type Pending = Record<number, Record<string, api.DbCell>>;

export default function DataGridTab({
  projectHash,
  connectionId,
  connectionName,
  schema,
  table,
}: {
  projectHash: string;
  connectionId: string;
  connectionName: string;
  schema: string | null;
  table: string;
}) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<api.DbSort | null>(null);
  const [filter, setFilter] = useState<api.DbFilter | null>(null);
  const [data, setData] = useState<api.DbPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState<Pending>({});
  const [editing, setEditing] = useState<{ row: number; column: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [menuAt, setMenuAt] = useState<{ row: number; column: number } | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [applying, setApplying] = useState(false);
  const editRef = useRef<HTMLInputElement>(null);
  // Keyed `${row}-${column}`, so a keyboard-only edit (Enter to commit, Esc to
  // cancel) returns focus to the cell it was editing instead of dropping it to
  // <body> — losing your place in the grid on every edit is not acceptable
  // for a keyboard-only user.
  const cellRefs = useRef(new Map<string, HTMLSpanElement>());
  const prevEditingRef = useRef<{ row: number; column: number } | null>(null);
  const [confirmingApply, setConfirmingApply] = useState(false);

  const dirtyRows = Object.keys(pending).length;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .dbFetchPage(projectHash, connectionId, schema, table, page, sort, filter)
      .then(setData)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [projectHash, connectionId, schema, table, page, sort, filter]);

  useEffect(load, [load]);
  useEffect(() => {
    if (editing) {
      editRef.current?.focus();
      prevEditingRef.current = editing;
    } else if (prevEditingRef.current) {
      const key = `${prevEditingRef.current.row}-${prevEditingRef.current.column}`;
      cellRefs.current.get(key)?.focus();
      prevEditingRef.current = null;
    }
  }, [editing]);

  const columns = useMemo(() => data?.columns ?? [], [data]);
  const editable = data?.editable ?? false;

  const valueAt = (row: number, column: number): api.DbCell => {
    const name = columns[column]?.name;
    const staged = pending[row];
    if (staged && name !== undefined && name in staged) return staged[name];
    return data?.rows[row][column] ?? null;
  };

  const isStaged = (row: number, column: number) => {
    const name = columns[column]?.name;
    return !!name && !!pending[row] && name in pending[row];
  };

  const stage = (row: number, column: number, value: api.DbCell) => {
    const name = columns[column]?.name;
    if (!name || !data) return;
    setPending((current) => {
      const row_ = { ...(current[row] ?? {}) };
      if (value === data.rows[row][column]) delete row_[name];
      else row_[name] = value;
      const next = { ...current };
      if (Object.keys(row_).length === 0) delete next[row];
      else next[row] = row_;
      return next;
    });
    setEditing(null);
  };

  const edits: api.DbRowEdit[] = useMemo(() => {
    if (!data) return [];
    return Object.entries(pending).map(([row, changes]) => ({
      original: Object.fromEntries(
        data.columns.map((column, index) => [column.name, data.rows[+row][index]])
      ),
      changes,
    }));
  }, [pending, data]);

  const apply = () => {
    setApplying(true);
    setError(null);
    api
      .dbApplyEdits(projectHash, connectionId, schema, table, edits)
      .then(() => {
        setPending({});
        setPreview(null);
        load();
      })
      // A conflict names the row that changed underneath the edit; nothing was
      // written, so the pending changes stay staged for the user to re-check.
      .catch((e) => setError(String(e)))
      .finally(() => setApplying(false));
  };

  const showPreview = () => {
    setError(null);
    api
      .dbPreviewEdits(projectHash, connectionId, schema, table, edits)
      .then(setPreview)
      .catch((e) => setError(String(e)));
  };

  const toggleSort = (column: string) => {
    setPage(0);
    setSort((current) =>
      current?.column !== column
        ? { column, descending: false }
        : current.descending
          ? null
          : { column, descending: true }
    );
  };

  const header = (column: string) => {
    const active = sort?.column === column;
    const type = columns.find((c) => c.name === column);
    return (
      <Group gap={4} wrap="nowrap">
        <Tooltip
          label={
            dirtyRows > 0
              ? "Apply or discard pending changes first"
              : `Sort by ${column}`
          }
          openDelay={400}
        >
          <button
            type="button"
            className="ds-db-col"
            onClick={() => toggleSort(column)}
            disabled={dirtyRows > 0}
            aria-label={`Sort by ${column}`}
          >
            {column}
            {active &&
              (sort.descending ? (
                <IconArrowNarrowDown size={12} />
              ) : (
                <IconArrowNarrowUp size={12} />
              ))}
          </button>
        </Tooltip>
        {type?.primaryKey && (
          <Badge size="xs" variant="light" radius="sm" title="Primary key">
            PK
          </Badge>
        )}
      </Group>
    );
  };

  const cell = (row: number, column: number, _value: api.DbCell) => {
    const value = valueAt(row, column);
    const staged = isStaged(row, column);
    if (editing?.row === row && editing.column === column) {
      return (
        <Group gap={2} wrap="nowrap">
          <TextInput
            ref={editRef}
            size="xs"
            value={draft}
            variant="unstyled"
            aria-label={`${columns[column]?.name} value`}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") stage(row, column, draft);
              if (event.key === "Escape") setEditing(null);
            }}
            onBlur={() => setEditing(null)}
          />
          <Tooltip label="Set to NULL">
            <ActionIcon
              size="xs"
              variant="subtle"
              color="gray"
              aria-label="Set to NULL"
              // Mousedown, not click: a real mouse click would blur the input
              // (closing the editor) before the click event ever landed.
              // Keyboard activation (Tab, then Enter/Space) fires only a click,
              // never a mousedown, so onClick covers that path — both call the
              // same idempotent stage(), so a real click firing both is safe.
              onMouseDown={(event) => {
                event.preventDefault();
                stage(row, column, null);
              }}
              onClick={() => stage(row, column, null)}
            >
              ∅
            </ActionIcon>
          </Tooltip>
          {staged && (
            // The right-click menu's "Revert this cell" is mouse-only and
            // disappears once you're in the editor — a keyboard-only user
            // needs a reachable way to undo a staged edit too.
            <Tooltip label="Revert to original value">
              <ActionIcon
                size="xs"
                variant="subtle"
                color="gray"
                aria-label="Revert to original value"
                onMouseDown={(event) => {
                  event.preventDefault();
                  stage(row, column, data?.rows[row][column] ?? null);
                }}
                onClick={() =>
                  stage(row, column, data?.rows[row][column] ?? null)
                }
              >
                <IconArrowBackUp size={12} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      );
    }

    const body = (
      <span
        className="ds-db-cell"
        data-staged={staged || undefined}
        data-testid="db-cell"
        role={editable ? "button" : undefined}
        tabIndex={editable ? 0 : undefined}
        ref={(el) => {
          const key = `${row}-${column}`;
          if (el) cellRefs.current.set(key, el);
          else cellRefs.current.delete(key);
        }}
        title={
          editable
            ? "Double-click to edit"
            : "Read-only: this table has no primary key"
        }
        onDoubleClick={() => {
          if (!editable) return;
          setDraft(value ?? "");
          setEditing({ row, column });
        }}
        onKeyDown={(event) => {
          if (!editable) return;
          if (event.key === "Enter") {
            event.preventDefault();
            setDraft(value ?? "");
            setEditing({ row, column });
          }
        }}
        onContextMenu={(event) => {
          if (!editable) return;
          event.preventDefault();
          setMenuAt({ row, column });
        }}
      >
        {renderValue(value)}
      </span>
    );

    if (menuAt?.row !== row || menuAt.column !== column) return body;
    return (
      <Menu opened onClose={() => setMenuAt(null)} position="bottom-start" withinPortal>
        <Menu.Target>{body}</Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            onClick={() => {
              stage(row, column, null);
              setMenuAt(null);
            }}
          >
            Set to NULL
          </Menu.Item>
          {staged && (
            <Menu.Item
              onClick={() => {
                stage(row, column, data?.rows[row][column] ?? null);
                setMenuAt(null);
              }}
            >
              Revert this cell
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
    );
  };

  return (
    <div className="ds-db-tab" data-testid="db-table-tab">
      <Group
        gap="xs"
        wrap="nowrap"
        p="xs"
        className="ds-db-toolbar"
        justify="space-between"
      >
        <Group gap="xs" wrap="nowrap">
          <Text size="xs" c="dimmed" ff="monospace">
            {connectionName} · {schema ? `${schema}.${table}` : table}
          </Text>
          {!loading && !editable && (
            <Badge
              size="xs"
              variant="light"
              color="gray"
              leftSection={<IconLock size={11} />}
              title="No primary key among the fetched columns, so no row can be targeted safely"
            >
              Read-only
            </Badge>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Select
            size="xs"
            w={110}
            aria-label="Filter column"
            disabled={dirtyRows > 0 || columns.length === 0}
            data={columns.map((c) => c.name)}
            value={filter?.column ?? columns[0]?.name ?? null}
            allowDeselect={false}
            onChange={(column) => {
              if (!column) return;
              setPage(0);
              setFilter((current) => (current ? { ...current, column } : null));
            }}
          />
          <TextInput
            size="xs"
            w={160}
            placeholder={`Filter ${filter?.column ?? columns[0]?.name ?? ""}…`}
            aria-label="Filter rows"
            disabled={dirtyRows > 0 || columns.length === 0}
            leftSection={<IconFilter size={13} />}
            value={filter?.value ?? ""}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setPage(0);
              setFilter(
                value
                  ? { column: filter?.column ?? columns[0]?.name ?? "", value }
                  : null
              );
            }}
          />
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label="Previous page"
            disabled={page === 0 || dirtyRows > 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <IconChevronLeft size={14} />
          </ActionIcon>
          <Text size="xs" c="dimmed">
            {data
              ? `${page * data.pageSize + 1}–${page * data.pageSize + data.rows.length}`
              : "—"}
          </Text>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label="Next page"
            disabled={!data?.hasMore || dirtyRows > 0}
            onClick={() => setPage((p) => p + 1)}
          >
            <IconChevronRight size={14} />
          </ActionIcon>
        </Group>
      </Group>

      {error && (
        <Alert
          variant="light"
          color="red"
          icon={<IconAlertTriangle size={14} />}
          m="xs"
          data-testid="db-grid-error"
          withCloseButton
          onClose={() => setError(null)}
        >
          <Text size="xs" style={{ wordBreak: "break-word" }}>
            {error}
          </Text>
        </Alert>
      )}

      {loading ? (
        <Loader size="xs" m="md" />
      ) : (
        <DataGrid
          columns={columns.map((column) => column.name)}
          rows={data?.rows ?? []}
          renderCell={cell}
          header={header}
          empty="No rows"
        />
      )}

      {dirtyRows > 0 && (
        <Group
          gap="xs"
          p="xs"
          className="ds-db-commit"
          justify="space-between"
          data-testid="db-commit-bar"
        >
          <Text size="xs">
            {dirtyRows} row{dirtyRows === 1 ? "" : "s"} with pending changes
          </Text>
          <Group gap="xs">
            <Button size="xs" variant="subtle" onClick={() => setPending({})}>
              Discard
            </Button>
            <Button size="xs" variant="default" onClick={showPreview}>
              Preview SQL
            </Button>
            <Button
              size="xs"
              loading={applying}
              onClick={() => setConfirmingApply(true)}
            >
              Apply
            </Button>
          </Group>
        </Group>
      )}

      <Modal
        opened={preview !== null}
        onClose={() => setPreview(null)}
        title="These statements will run as one transaction"
        size="lg"
      >
        <Code block data-testid="db-preview-sql">
          {(preview ?? []).join("\n")}
        </Code>
        <Group gap="xs" justify="flex-end" mt="md">
          <Button size="xs" variant="subtle" onClick={() => setPreview(null)}>
            Close
          </Button>
          <Button
            size="xs"
            loading={applying}
            data-testid="db-preview-apply"
            onClick={() => setConfirmingApply(true)}
          >
            Apply
          </Button>
        </Group>
      </Modal>

      <Modal
        opened={confirmingApply}
        onClose={() => setConfirmingApply(false)}
        title="Apply pending changes?"
        data-testid="db-confirm-apply"
      >
        <Text size="sm">
          This writes {dirtyRows} row{dirtyRows === 1 ? "" : "s"} to{" "}
          <strong>{connectionName}</strong> as one transaction. It cannot be
          undone from here.
        </Text>
        <Group gap="xs" justify="flex-end" mt="md">
          <Button
            size="xs"
            variant="subtle"
            data-testid="db-confirm-apply-cancel"
            onClick={() => setConfirmingApply(false)}
          >
            Cancel
          </Button>
          <Button
            size="xs"
            color="red"
            loading={applying}
            data-testid="db-confirm-apply-submit"
            onClick={() => {
              setConfirmingApply(false);
              apply();
            }}
          >
            Apply
          </Button>
        </Group>
      </Modal>
    </div>
  );
}
