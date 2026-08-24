import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import McpPane from "../McpPane";
import * as api from "../api";

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

vi.mock("../api", () => ({
  listMcpServers: vi.fn(),
  saveMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  setMcpServerEnabled: vi.fn(),
  searchMcpRegistry: vi.fn(),
}));

const mocked = api as unknown as {
  listMcpServers: ReturnType<typeof vi.fn>;
  saveMcpServer: ReturnType<typeof vi.fn>;
  removeMcpServer: ReturnType<typeof vi.fn>;
  setMcpServerEnabled: ReturnType<typeof vi.fn>;
  searchMcpRegistry: ReturnType<typeof vi.fn>;
};

const page = (
  servers: api.McpRegistryEntry[],
  nextCursor: string | null = null
): api.McpRegistryPage => ({ servers, nextCursor });

const server = (over: Partial<api.McpServer> = {}): api.McpServer => ({
  name: "graphify",
  transport: "stdio",
  command: "graphify-mcp",
  args: ["--graph", "g.json"],
  env: {},
  url: "",
  headers: {},
  enabled: true,
  ...over,
});

beforeEach(() => {
  mocked.listMcpServers.mockReset().mockResolvedValue([server()]);
  mocked.saveMcpServer.mockReset().mockResolvedValue(undefined);
  mocked.removeMcpServer.mockReset().mockResolvedValue(undefined);
  mocked.setMcpServerEnabled.mockReset().mockResolvedValue(undefined);
  mocked.searchMcpRegistry.mockReset().mockResolvedValue(page([]));
});

const props = { projectHash: "p1", onError: vi.fn() };

describe("McpPane installed servers", () => {
  it("lists the project's configured servers with their command", async () => {
    render(<McpPane {...props} />);
    expect(await screen.findByText("graphify")).toBeInTheDocument();
    expect(
      screen.getByText("graphify-mcp --graph g.json")
    ).toBeInTheDocument();
  });

  it("says so plainly when nothing is configured", async () => {
    mocked.listMcpServers.mockResolvedValue([]);
    render(<McpPane {...props} />);
    expect(
      await screen.findByText(/No MCP servers configured/i)
    ).toBeInTheDocument();
  });

  it("toggles a server and re-reads the file rather than guessing", async () => {
    render(<McpPane {...props} />);
    fireEvent.click(await screen.findByLabelText("Enable graphify"));
    await waitFor(() =>
      expect(mocked.setMcpServerEnabled).toHaveBeenCalledWith(
        "p1",
        "graphify",
        false
      )
    );
    // The list is the file's state, not local state — a failed write must not
    // leave the UI showing a toggle that never happened.
    await waitFor(() => expect(mocked.listMcpServers).toHaveBeenCalledTimes(2));
  });

  it("removes a server", async () => {
    render(<McpPane {...props} />);
    fireEvent.click(await screen.findByLabelText("Remove graphify"));
    await waitFor(() =>
      expect(mocked.removeMcpServer).toHaveBeenCalledWith("p1", "graphify")
    );
  });

  it("saves a hand-added stdio server, splitting args and env", async () => {
    mocked.listMcpServers.mockResolvedValue([]);
    render(<McpPane {...props} />);
    fireEvent.click(await screen.findByTestId("mcp-add"));

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "fs" },
    });
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "npx" },
    });
    fireEvent.change(screen.getByLabelText("Arguments"), {
      target: { value: "-y  mcp-filesystem" },
    });
    fireEvent.change(screen.getByLabelText("Environment"), {
      target: { value: "API_KEY=secret\nEMPTY=" },
    });
    fireEvent.click(screen.getByTestId("mcp-save"));

    await waitFor(() =>
      expect(mocked.saveMcpServer).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          name: "fs",
          transport: "stdio",
          command: "npx",
          // Runs of whitespace collapse; a stray blank is not an argument.
          args: ["-y", "mcp-filesystem"],
          env: { API_KEY: "secret", EMPTY: "" },
          enabled: true,
        })
      )
    );
  });

  it("will not save a server without a name", async () => {
    mocked.listMcpServers.mockResolvedValue([]);
    render(<McpPane {...props} />);
    fireEvent.click(await screen.findByTestId("mcp-add"));
    expect(screen.getByTestId("mcp-save")).toBeDisabled();
  });

  it("edits an existing server in place rather than adding a second", async () => {
    render(<McpPane {...props} />);
    fireEvent.click(await screen.findByTestId("mcp-server-graphify"));
    fireEvent.click(screen.getByTestId("mcp-save"));
    await waitFor(() =>
      expect(mocked.saveMcpServer).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ name: "graphify" })
      )
    );
  });

  it("asks for a URL instead of a command for a remote server", async () => {
    mocked.listMcpServers.mockResolvedValue([]);
    render(<McpPane {...props} />);
    fireEvent.click(await screen.findByTestId("mcp-add"));
    fireEvent.click(screen.getByRole("radio", { name: "http" }));
    expect(screen.getByLabelText("URL")).toBeInTheDocument();
    expect(screen.queryByLabelText("Command")).not.toBeInTheDocument();
  });
});

describe("McpPane registry browsing", () => {
  const entry = (
    over: Partial<api.McpRegistryEntry> = {}
  ): api.McpRegistryEntry => ({
    name: "io.github.owner/filesystem",
    title: "Filesystem",
    description: "Read and write files",
    version: "1.0.0",
    repository: "https://github.com/owner/filesystem",
    installable: true,
    server: server({ name: "filesystem", command: "npx", args: ["-y", "fs"] }),
    ...over,
  });

  const openBrowse = async () => {
    render(<McpPane {...props} />);
    await screen.findByText("graphify");
    fireEvent.click(screen.getByRole("radio", { name: "Browse" }));
  };

  it("shows registry entries without making the user search first", async () => {
    mocked.searchMcpRegistry.mockResolvedValue(page([entry()]));
    await openBrowse();
    expect(await screen.findByText("Filesystem")).toBeInTheDocument();
    expect(mocked.searchMcpRegistry).toHaveBeenCalledWith("");
  });

  it("searches the registry on submit", async () => {
    mocked.searchMcpRegistry.mockResolvedValue(page([entry()]));
    await openBrowse();
    await screen.findByText("Filesystem");
    fireEvent.change(screen.getByTestId("mcp-search"), {
      target: { value: "github" },
    });
    fireEvent.submit(screen.getByTestId("mcp-search").closest("form")!);
    await waitFor(() =>
      expect(mocked.searchMcpRegistry).toHaveBeenCalledWith("github")
    );
  });

  it("installing opens the prefilled form instead of writing straight to disk", async () => {
    mocked.searchMcpRegistry.mockResolvedValue(page([entry()]));
    await openBrowse();
    fireEvent.click(await screen.findByLabelText("Install Filesystem"));

    // Registry servers routinely need an API key; saving one silently would
    // produce a server that fails to start with no indication why.
    expect(await screen.findByTestId("mcp-form")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("filesystem");
    expect(mocked.saveMcpServer).not.toHaveBeenCalled();
  });

  it("points an uninstallable entry at its repository", async () => {
    mocked.searchMcpRegistry.mockResolvedValue(
      page([entry({ installable: false, server: null })])
    );
    await openBrowse();
    const link = await screen.findByText("Manual setup");
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/owner/filesystem"
    );
    expect(
      screen.queryByLabelText("Install Filesystem")
    ).not.toBeInTheDocument();
  });

  it("surfaces a registry outage instead of looking empty", async () => {
    mocked.searchMcpRegistry.mockRejectedValue("offline");
    await openBrowse();
    expect(
      await screen.findByText(/Could not reach the MCP registry/i)
    ).toBeInTheDocument();
  });
});
