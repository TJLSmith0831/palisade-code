import type { ReactElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import ConnectionsPanel, { resetsIn, usageColor } from "../ConnectionsPanel";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    preflight: vi.fn(),
    agentUsage: vi.fn(),
    agentLogins: vi.fn(),
    listSkills: vi.fn(),
  },
}));
vi.mock("../api", () => apiMock);

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

const flight = {
  agents: [
    { id: "claude", name: "Claude Code", version: "2.0.1", path: "/usr/bin/claude", cmd: "claude" },
  ],
  selected: "claude",
  openspec: true,
  ready: true,
  warnings: ["No ACP agents found on PATH — chat-only mode, /go unavailable."],
  registryReachable: true,
  checkedAt: "2026-09-18T00:00:00Z",
};

const login = {
  methodId: "oauth",
  label: "Anthropic account",
  kind: "protocol" as const,
  shellLine: "",
};

const onLogin = vi.fn();

const mount = (initialTab: "agents" | "mcp" | "skills" = "agents") =>
  render(
    <ConnectionsPanel
      initialTab={initialTab}
      projectHash="p1"
      onLogin={onLogin}
      mcp={<div data-testid="mcp-stub">mcp pane</div>}
    />
  );

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.preflight.mockResolvedValue(flight);
  apiMock.agentLogins.mockResolvedValue([login]);
  apiMock.listSkills.mockResolvedValue([]);
  apiMock.agentUsage.mockResolvedValue([
    {
      agentId: "claude",
      state: "ok",
      plan: "Max 20x",
      windows: [
        { label: "5h", usedPercent: 78, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
        { label: "Week", usedPercent: 31 },
      ],
      balanceUsd: 12.4,
      fetchedAt: "2026-09-18T00:00:00Z",
      source: "keychain",
    },
  ]);
});

describe("ConnectionsPanel", () => {
  it("renders the three tabs and the MCP pane it was handed", async () => {
    mount("mcp");
    expect(screen.getByRole("tab", { name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "MCP servers" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Skills" })).toBeTruthy();
    expect(screen.getByTestId("mcp-stub")).toBeTruthy();
  });

  it("renders one Progress per usage window, with plan and balance", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("usage-ok")).toBeTruthy());
    expect(screen.getAllByTestId("usage-window")).toHaveLength(2);
    expect(screen.getByTestId("usage-plan").textContent).toBe("Max 20x");
    expect(screen.getByTestId("usage-balance").textContent).toBe("$12.40 remaining");
    expect(screen.getByText(/5h · 78% · resets in 2h/)).toBeTruthy();
  });

  it("says to sign in when the agent reports no session", async () => {
    apiMock.agentUsage.mockResolvedValue([
      { agentId: "claude", state: "not_signed_in", reason: "no credential" },
    ]);
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("usage-signed-out").textContent).toBe("Sign in to see usage")
    );
  });

  it("is honest when usage is unavailable", async () => {
    apiMock.agentUsage.mockResolvedValue([
      { agentId: "claude", state: "unavailable", reason: "agent exposes no usage surface" },
    ]);
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("usage-unavailable").textContent).toBe(
        "Usage not available for this agent"
      )
    );
  });

  it("routes Sign in through the app's existing login flow", async () => {
    apiMock.agentUsage.mockResolvedValue([
      { agentId: "claude", state: "not_signed_in", reason: "no credential" },
    ]);
    mount();
    const button = await screen.findByTestId("connections-sign-in");
    expect(button.textContent).toBe("Sign in");
    fireEvent.click(button);
    expect(onLogin).toHaveBeenCalledWith(login);
  });

  it("names each sign-in method when an agent offers a choice", async () => {
    apiMock.agentUsage.mockResolvedValue([
      { agentId: "claude", state: "not_signed_in", reason: "no credential" },
    ]);
    apiMock.agentLogins.mockResolvedValue([
      { ...login, methodId: "subscription", label: "Claude Subscription" },
      { ...login, methodId: "console", label: "Anthropic Console" },
    ]);
    mount();
    await waitFor(() =>
      expect(screen.getAllByTestId("connections-sign-in").map((button) => button.textContent)).toEqual([
        "Sign in with Claude Subscription",
        "Sign in with Anthropic Console",
      ])
    );
  });

  // A reported usage window is proof of a session; prompting to sign in over
  // it would be the panel arguing with its own data.
  it("drops the sign-in button once usage proves a session", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("usage-ok")).toBeTruthy());
    expect(screen.queryByTestId("connections-sign-in")).toBeNull();
  });

  // "Installed" was true of every row it ever rendered, so it said nothing.
  it("does not badge an agent as Installed", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("connections-agent")).toBeTruthy());
    expect(screen.queryByText("Installed")).toBeNull();
    expect(screen.queryByText("No sign-in offered")).toBeNull();
  });

  it("colours the usage bar by how much of the window is spent", async () => {
    expect(usageColor(12)).toBe("success");
    expect(usageColor(59.9)).toBe("success");
    expect(usageColor(60)).toBe("warn");
    expect(usageColor(85)).toBe("warn");
    expect(usageColor(85.1)).toBe("danger");
    expect(usageColor(100)).toBe("danger");

    apiMock.agentUsage.mockResolvedValue([
      {
        agentId: "claude",
        state: "ok",
        windows: [
          { label: "5h", usedPercent: 12 },
          { label: "Day", usedPercent: 70 },
          { label: "Week", usedPercent: 96 },
        ],
        fetchedAt: "2026-09-18T00:00:00Z",
        source: "keychain",
      },
    ]);
    mount();
    await waitFor(() => expect(screen.getAllByTestId("usage-window")).toHaveLength(3));
    expect(
      screen.getAllByTestId("usage-window").map((bar) => bar.getAttribute("data-color"))
    ).toEqual(["success", "warn", "danger"]);
  });

  it("shows agent-related preflight warnings at the top of the Agents tab", async () => {
    mount();
    await waitFor(() =>
      expect(screen.getByTestId("connections-agent-warnings").textContent).toContain(
        "No ACP agents found on PATH"
      )
    );
  });

  it("lists skills with owner, description and path", async () => {
    apiMock.listSkills.mockResolvedValue([
      { name: "grill-apply", path: "/home/me/.claude/skills/grill-apply", description: "Implements a change", owner: "claude" },
      { name: "ship", path: "/home/me/.agents/skills/ship", owner: "agents" },
    ]);
    mount("skills");
    await waitFor(() => expect(screen.getAllByTestId("connections-skill")).toHaveLength(2));
    expect(screen.getByText("Implements a change")).toBeTruthy();
    expect(screen.getByText("~/.agents")).toBeTruthy();
    expect(screen.getByLabelText("Copy path for /home/me/.agents/skills/ship")).toBeTruthy();
    // Cards, not a three-column table: at 215px the table gave every cell
    // one character per line.
    expect(document.querySelector("table")).toBeNull();
  });

  it("shows where skills live when none are installed", async () => {
    mount("skills");
    await waitFor(() =>
      expect(screen.getByTestId("connections-skills-empty").textContent).toContain(
        "Skills live in ~/.claude/skills or ~/.agents/skills"
      )
    );
  });

  it("shows a loading skeleton before the first fetch resolves, not the empty-usage string", async () => {
    apiMock.preflight.mockReturnValue(new Promise(() => {}));
    apiMock.agentUsage.mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByTestId("connections-agents-loading")).toBeTruthy();
    expect(screen.queryByText("Usage not available for this agent")).toBeNull();
  });

  it("puts the agent card into an in-flight state when sign-in is clicked", async () => {
    apiMock.agentUsage.mockResolvedValue([
      { agentId: "claude", state: "not_signed_in", reason: "no credential" },
    ]);
    mount();
    const button = await screen.findByTestId("connections-sign-in");
    fireEvent.click(button);
    expect(onLogin).toHaveBeenCalledWith(login);
    expect(await screen.findByTestId("connections-sign-in-status")).toBeTruthy();
  });

  it("manual refresh re-runs the fetch on demand", async () => {
    mount();
    await waitFor(() => expect(apiMock.preflight).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("connections-refresh"));
    await waitFor(() => expect(apiMock.preflight).toHaveBeenCalledTimes(2));
    expect(apiMock.agentUsage.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("clears the poll interval and sign-in timeout on unmount", async () => {
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    apiMock.agentUsage.mockResolvedValue([
      { agentId: "claude", state: "not_signed_in", reason: "no credential" },
    ]);
    const { unmount } = mount();
    const button = await screen.findByTestId("connections-sign-in");
    fireEvent.click(button);
    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it("resetsIn picks the coarsest readable unit and drops past resets", () => {
    const now = Date.now();
    expect(resetsIn(new Date(now + 30 * 60_000).toISOString(), now)).toBe("resets in 30m");
    expect(resetsIn(new Date(now + 5 * 3600_000).toISOString(), now)).toBe("resets in 5h");
    expect(resetsIn(new Date(now - 60_000).toISOString(), now)).toBe(null);
  });
});
