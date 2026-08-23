import { useCallback, useEffect, useState } from "react";
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Loader,
  SegmentedControl,
  Switch,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconDownload,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import * as api from "./api";

// MCP servers for the active project.
//
// The store is the project's own `.mcp.json` — portable, git-shareable, and
// what `claude` reads when run straight from a terminal. The backend also
// hands the enabled servers to each agent session over ACP `session/new`,
// which is how they reach agents that never read `.mcp.json` at all.
//
// Browse is backed by the official registry at registry.modelcontextprotocol.io.
// Entries Palisade cannot launch from config alone (a docker image, a binary
// download) are shown with a link to their repository rather than an Install
// button that would write a server that never starts.

const BLANK: api.McpServer = {
  name: "",
  transport: "stdio",
  command: "",
  args: [],
  env: {},
  url: "",
  headers: {},
  enabled: true,
};

/** What the row shows under the name: the launch command, or the URL. */
const commandOf = (server: api.McpServer) =>
  server.transport === "stdio"
    ? [server.command, ...server.args].join(" ")
    : server.url;

/** `KEY=value` lines ↔ an env map, which is how the form edits `env`. */
const envToText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

const textToEnv = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const eq = line.indexOf("=");
        return eq === -1
          ? [line, ""]
          : [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
      })
  );

export default function McpPane({
  projectHash,
  onError,
}: {
  projectHash: string;
  onError: (message: unknown) => void;
}) {
  const [tab, setTab] = useState<"installed" | "browse">("installed");
  const [servers, setServers] = useState<api.McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<api.McpServer | null>(null);
  const [envText, setEnvText] = useState("");

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<api.McpRegistryEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .listMcpServers(projectHash)
      .then(setServers)
      .catch(onError)
      .finally(() => setLoading(false));
  }, [projectHash, onError]);

  useEffect(reload, [reload]);

  const search = useCallback(
    (text: string) => {
      setSearching(true);
      setSearchError(null);
      api
        .searchMcpRegistry(text)
        .then(setResults)
        .catch((e) => setSearchError(String(e)))
        .finally(() => setSearching(false));
    },
    []
  );

  // Opening Browse shows the registry's newest entries rather than an empty
  // box with a prompt — there is something to look at before you know what
  // you want. Re-fetching on every visit is avoided by the results check.
  useEffect(() => {
    if (tab === "browse" && results.length === 0 && !searchError) search("");
  }, [tab, results.length, searchError, search]);

  const act = (work: Promise<void>) => work.then(reload).catch(onError);

  const openDraft = (server: api.McpServer) => {
    setDraft(server);
    setEnvText(envToText(server.env));
  };

  const saveDraft = () => {
    if (!draft) return;
    void act(
      api.saveMcpServer(projectHash, { ...draft, env: textToEnv(envText) })
    ).then(() => setDraft(null));
  };

  const install = (entry: api.McpRegistryEntry) => {
    if (!entry.server) return;
    // Straight into the editor rather than straight to disk: registry entries
    // routinely need an API key, and a server saved without one just fails to
    // start with no indication of why.
    setTab("installed");
    openDraft(entry.server);
  };

  return (
    <>
      <div className="ds-panel-head">MCP Servers</div>
      <div className="ds-panel-body ds-mcp-body">
        {/* Pinned: scrolling a long registry page must not take the tabs and
            the search box with it. */}
        <div className="ds-mcp-controls">
          <SegmentedControl
            fullWidth
            size="xs"
            value={tab}
            onChange={(value) => setTab(value as "installed" | "browse")}
            data={[
              { value: "installed", label: "Installed" },
              { value: "browse", label: "Browse" },
            ]}
            data-testid="mcp-tabs"
          />
          {tab === "browse" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                search(query);
              }}
            >
              <TextInput
                size="xs"
                placeholder="Search the MCP registry…"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                leftSection={<IconSearch size={13} />}
                aria-label="Search the MCP registry"
                data-testid="mcp-search"
              />
            </form>
          )}
        </div>

        {tab === "installed" && (
          <div className="ds-mcp-list" data-testid="mcp-installed">
            {loading && <Loader size="xs" />}
            {!loading && servers.length === 0 && !draft && (
              <p className="ds-mcp-empty">
                No MCP servers configured for this project. Browse the registry
                or add one by hand.
              </p>
            )}

            {servers.map((server) => (
              <div
                key={server.name}
                className="ds-mcp-row"
                data-off={!server.enabled || undefined}
              >
                <div className="ds-mcp-row-top">
                  <Tooltip
                    label={server.enabled ? "Enabled" : "Disabled"}
                    position="right"
                  >
                    <Switch
                      size="xs"
                      checked={server.enabled}
                      aria-label={`Enable ${server.name}`}
                      onChange={(event) =>
                        void act(
                          api.setMcpServerEnabled(
                            projectHash,
                            server.name,
                            event.currentTarget.checked
                          )
                        )
                      }
                    />
                  </Tooltip>
                  <button
                    className="ds-mcp-name"
                    onClick={() => openDraft(server)}
                    data-testid={`mcp-server-${server.name}`}
                    title={`Edit ${server.name}`}
                  >
                    {server.name}
                  </button>
                  {server.transport !== "stdio" && (
                    <Badge size="xs" variant="light" radius="sm">
                      {server.transport}
                    </Badge>
                  )}
                  <Tooltip label="Remove" position="left">
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="neutral"
                      aria-label={`Remove ${server.name}`}
                      onClick={() =>
                        void act(api.removeMcpServer(projectHash, server.name))
                      }
                    >
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </div>
                <div className="ds-mcp-cmd" title={commandOf(server)}>
                  {commandOf(server)}
                </div>
              </div>
            ))}

            {draft ? (
              <div className="ds-mcp-form" data-testid="mcp-form">
                <TextInput
                  size="xs"
                  label="Name"
                  value={draft.name}
                  onChange={(e) =>
                    setDraft({ ...draft, name: e.currentTarget.value })
                  }
                />
                <SegmentedControl
                  fullWidth
                  size="xs"
                  value={draft.transport}
                  onChange={(value) =>
                    setDraft({
                      ...draft,
                      transport: value as api.McpServer["transport"],
                    })
                  }
                  data={[
                    { value: "stdio", label: "stdio" },
                    { value: "http", label: "http" },
                    { value: "sse", label: "sse" },
                  ]}
                />
                {draft.transport === "stdio" ? (
                  <>
                    <TextInput
                      size="xs"
                      label="Command"
                      placeholder="npx"
                      value={draft.command}
                      onChange={(e) =>
                        setDraft({ ...draft, command: e.currentTarget.value })
                      }
                    />
                    <TextInput
                      size="xs"
                      label="Arguments"
                      placeholder="-y some-mcp-server"
                      value={draft.args.join(" ")}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          args: e.currentTarget.value.split(/\s+/).filter(Boolean),
                        })
                      }
                    />
                    <Textarea
                      size="xs"
                      label="Environment"
                      description="KEY=value, one per line"
                      rows={3}
                      value={envText}
                      onChange={(e) => setEnvText(e.currentTarget.value)}
                    />
                  </>
                ) : (
                  <TextInput
                    size="xs"
                    label="URL"
                    placeholder="https://example.com/mcp"
                    value={draft.url}
                    onChange={(e) =>
                      setDraft({ ...draft, url: e.currentTarget.value })
                    }
                  />
                )}
                <div className="ds-mcp-form-actions">
                  <Button
                    size="compact-xs"
                    onClick={saveDraft}
                    disabled={!draft.name.trim()}
                    data-testid="mcp-save"
                  >
                    Save
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => setDraft(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size="compact-xs"
                variant="light"
                leftSection={<IconPlus size={13} />}
                onClick={() => openDraft(BLANK)}
                data-testid="mcp-add"
              >
                Add server
              </Button>
            )}
          </div>
        )}

        {tab === "browse" && (
          <div className="ds-mcp-list" data-testid="mcp-browse">
            {searching && <Loader size="xs" />}
            {searchError && (
              <p className="ds-mcp-empty">
                Could not reach the MCP registry. {searchError}{" "}
                <Button
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<IconRefresh size={13} />}
                  onClick={() => search(query)}
                >
                  Retry
                </Button>
              </p>
            )}
            {!searching && !searchError && results.length === 0 && (
              <p className="ds-mcp-empty">No servers match that search.</p>
            )}

            {results.map((entry) => (
              <div key={entry.name} className="ds-mcp-row">
                <div className="ds-mcp-row-top">
                  <span className="ds-mcp-name as-text">{entry.title}</span>
                  {entry.installable ? (
                    <Button
                      size="compact-xs"
                      variant="light"
                      leftSection={<IconDownload size={12} />}
                      aria-label={`Install ${entry.title}`}
                      onClick={() => install(entry)}
                    >
                      Install
                    </Button>
                  ) : (
                    entry.repository && (
                      // Honest about the gap: this one needs a step Palisade
                      // isn't taking for you, so it points at the instructions
                      // rather than pretending one click is enough.
                      <Anchor
                        href={entry.repository}
                        target="_blank"
                        rel="noreferrer"
                        size="xs"
                        className="ds-mcp-manual"
                      >
                        Manual setup
                      </Anchor>
                    )
                  )}
                </div>
                <div className="ds-mcp-detail">{entry.description}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
