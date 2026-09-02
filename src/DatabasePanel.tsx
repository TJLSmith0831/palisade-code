import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Loader,
  NavLink,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconEye,
  IconPencil,
  IconPlus,
  IconTable,
  IconTerminal2,
  IconTrash,
} from "@tabler/icons-react";
import * as api from "./api";

// Saved database connections and their schema trees.
//
// A connection string can carry a password, so nothing about it is stored in
// the project — the backend keeps them under `~/.palisade-code` and this panel
// only ever holds an id (D5/D8). Errors land inline here rather than in a
// toast, matching how a malformed project-settings file surfaces (D18).

/** Tables and views only — indexes, triggers and functions are out for v1 (D16). */
type Loaded = { tables: api.DbTable[] } | { error: string } | "loading";

export default function DatabasePanel({
  projectHash,
  onOpenTable,
  onOpenQuery,
}: {
  projectHash: string;
  onOpenTable: (
    connection: api.DbConnection,
    schema: string | null,
    table: string
  ) => void;
  onOpenQuery: (connection: api.DbConnection) => void;
}) {
  const [connections, setConnections] = useState<api.DbConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  // Discrete fields, not a connection string: the password is stored on its own
  // so listing connections needs no credential-store access (D21/D23).
  const [backend, setBackend] = useState<api.DbBackend>("postgres");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState<number>(5432);
  const [user, setUser] = useState("");
  const [database, setDatabase] = useState("");
  const [password, setPassword] = useState("");
  const [path, setPath] = useState("");
  const [paste, setPaste] = useState("");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, Loaded>>({});
  const [renaming, setRenaming] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .dbListConnections(projectHash)
      .then(setConnections)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [projectHash]);

  useEffect(reload, [reload]);

  const details = (): api.DbDetails =>
    backend === "sqlite"
      ? { backend: "sqlite", path }
      : { backend: "postgres", host, port, user, database };

  // Pasting a connection string fills the fields rather than being stored as
  // one — the user still sees and can correct what will be saved (D24).
  const applyPaste = (value: string) => {
    setPaste(value);
    if (!value.trim()) return;
    api
      .dbParseUrl(value)
      .then(({ details, password }) => {
        setBackend(details.backend);
        if (details.backend === "sqlite") {
          setPath(details.path);
        } else {
          setHost(details.host);
          setPort(details.port);
          setUser(details.user);
          setDatabase(details.database);
        }
        if (password) setPassword(password);
        setPaste("");
        setError(null);
      })
      .catch((e) => setError(String(e)));
  };

  const complete = name && (backend === "sqlite" ? path : host && database);

  const save = () => {
    setSaving(true);
    setError(null);
    api
      .dbAddConnection(projectHash, name, details(), password || undefined)
      .then(() => {
        setName("");
        setPassword("");
        setUser("");
        setDatabase("");
        setPath("");
        setAdding(false);
        reload();
      })
      // A connection string that doesn't connect is reported, never saved —
      // the panel would otherwise fill with entries that only fail on click.
      .catch((e) => setError(String(e)))
      .finally(() => setSaving(false));
  };

  const remove = (connection: api.DbConnection) => {
    setError(null);
    api
      .dbRemoveConnection(projectHash, connection.id)
      .then(() => {
        setExpanded((current) => {
          const next = { ...current };
          delete next[connection.id];
          return next;
        });
        reload();
      })
      .catch((e) => setError(String(e)));
  };

  const commitRename = (connection: api.DbConnection, next: string) => {
    setRenaming(null);
    if (!next.trim() || next === connection.name) return;
    api
      .dbRenameConnection(projectHash, connection.id, next)
      .then(reload)
      .catch((e) => setError(String(e)));
  };

  const toggle = (connection: api.DbConnection) => {
    if (expanded[connection.id]) {
      setExpanded((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      return;
    }
    setExpanded((current) => ({ ...current, [connection.id]: "loading" }));
    api
      .dbListTables(projectHash, connection.id)
      .then((tables) =>
        setExpanded((current) => ({ ...current, [connection.id]: { tables } }))
      )
      .catch((e) =>
        setExpanded((current) => ({
          ...current,
          [connection.id]: { error: String(e) },
        }))
      );
  };

  const form = (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      data-testid="db-connection-form"
    >
      <Stack gap="xs" p="xs">
        <TextInput
          size="xs"
          label="Name"
          placeholder="dev"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          data-autofocus
        />
        <SegmentedControl
          size="xs"
          fullWidth
          value={backend}
          onChange={(value) => setBackend(value as api.DbBackend)}
          data={[
            { label: "Postgres", value: "postgres" },
            { label: "SQLite", value: "sqlite" },
          ]}
        />
        {backend === "sqlite" ? (
          <TextInput
            size="xs"
            label="Database file"
            placeholder="/path/to/app.db"
            description="No credentials — SQLite connections never use the keychain."
            value={path}
            onChange={(e) => setPath(e.currentTarget.value)}
          />
        ) : (
          <>
            <Group gap="xs" grow align="flex-start">
              <TextInput
                size="xs"
                label="Host"
                placeholder="localhost"
                value={host}
                onChange={(e) => setHost(e.currentTarget.value)}
              />
              <NumberInput
                size="xs"
                label="Port"
                value={port}
                min={1}
                max={65535}
                onChange={(value) => setPort(Number(value) || 5432)}
              />
            </Group>
            <TextInput
              size="xs"
              label="User"
              value={user}
              onChange={(e) => setUser(e.currentTarget.value)}
            />
            <PasswordInput
              size="xs"
              label="Password"
              description="Stored in the OS keychain, separate from the details above."
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            <TextInput
              size="xs"
              label="Database"
              placeholder="app"
              value={database}
              onChange={(e) => setDatabase(e.currentTarget.value)}
            />
          </>
        )}
        <TextInput
          size="xs"
          label="Or paste a connection string"
          placeholder="postgres://user:password@localhost:5432/app"
          description="Fills the fields above; the string itself is never stored."
          value={paste}
          onChange={(e) => applyPaste(e.currentTarget.value)}
        />
        <Group gap="xs" justify="flex-end">
          <Button
            size="xs"
            variant="subtle"
            onClick={() => {
              setAdding(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button size="xs" type="submit" loading={saving} disabled={!complete}>
            Connect
          </Button>
        </Group>
      </Stack>
    </form>
  );

  return (
    <>
      <div className="ds-panel-head">
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <span>Database</span>
          {!adding && connections.length > 0 && (
            <Tooltip label="Add connection" position="left">
              <ActionIcon
                size="sm"
                variant="subtle"
                color="neutral"
                aria-label="Add connection"
                onClick={() => setAdding(true)}
              >
                <IconPlus size={14} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </div>

      <div className="ds-panel-body" data-testid="db-panel">
        {error && (
          <Alert
            variant="light"
            color="danger"
            icon={<IconAlertTriangle size={14} />}
            title="Connection failed"
            m="xs"
            data-testid="db-error"
            withCloseButton
            onClose={() => setError(null)}
          >
            <Text size="xs" style={{ wordBreak: "break-word" }}>
              {error}
            </Text>
          </Alert>
        )}

        {loading && <Loader size="xs" m="xs" />}

        {!loading && connections.length === 0 && !adding && (
          <Stack gap="xs" p="md" align="flex-start" data-testid="db-empty">
            <Text size="sm" fw={500}>
              No database connections yet
            </Text>
            <Text size="xs" c="dimmed">
              Add a Postgres or SQLite connection string to browse its tables,
              run queries, and edit rows without leaving Palisade.
            </Text>
            <Button
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={() => setAdding(true)}
            >
              Add connection
            </Button>
          </Stack>
        )}

        {adding && form}

        {connections.map((connection) => {
          const state = expanded[connection.id];
          return (
            <NavLink
              key={connection.id}
              label={
                renaming === connection.id ? (
                  <TextInput
                    size="xs"
                    variant="unstyled"
                    defaultValue={connection.name}
                    autoFocus
                    aria-label="Connection name"
                    onClick={(event) => event.stopPropagation()}
                    onBlur={(event) =>
                      commitRename(connection, event.currentTarget.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter")
                        commitRename(connection, event.currentTarget.value);
                      if (event.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  connection.name
                )
              }
              description={connection.backend}
              opened={!!state}
              onClick={() => toggle(connection)}
              data-testid={`db-connection-${connection.id}`}
              // Our rightSection is a row of action buttons, not the default
              // expand/collapse chevron — without this, Mantine rotates the
              // whole button group 90deg on expand along with it.
              disableRightSectionRotation
              rightSection={
                <Group gap={2} wrap="nowrap">
                  <Tooltip label="Rename connection" position="left">
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="neutral"
                      aria-label={`Rename ${connection.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenaming(connection.id);
                      }}
                    >
                      <IconPencil size={14} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="SQL editor" position="left">
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="neutral"
                      aria-label={`SQL editor for ${connection.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenQuery(connection);
                      }}
                    >
                      <IconTerminal2 size={14} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Remove connection" position="left">
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="neutral"
                      aria-label={`Remove ${connection.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        remove(connection);
                      }}
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              }
            >
              {state === "loading" && <Loader size="xs" m="xs" />}
              {state && state !== "loading" && "error" in state && (
                <Text size="xs" c="dimmed" p="xs" data-testid="db-tables-error">
                  {state.error}
                </Text>
              )}
              {state && state !== "loading" && "tables" in state && (
                <>
                  {state.tables.length === 0 && (
                    <Text size="xs" c="dimmed" p="xs">
                      No tables or views.
                    </Text>
                  )}
                  {state.tables.map((table) => (
                    <NavLink
                      key={`${table.schema ?? ""}.${table.name}`}
                      label={table.name}
                      description={table.schema ?? undefined}
                      leftSection={
                        table.kind === "view" ? (
                          <IconEye size={14} />
                        ) : (
                          <IconTable size={14} />
                        )
                      }
                      data-testid="db-table"
                      onClick={() =>
                        onOpenTable(connection, table.schema, table.name)
                      }
                    />
                  ))}
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </>
  );
}
