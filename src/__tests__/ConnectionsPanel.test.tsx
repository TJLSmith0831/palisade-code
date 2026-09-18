import type { ReactElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import ConnectionsPanel, { resetsIn } from "../ConnectionsPanel";

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
    mount();
    const button = await screen.findByTestId("connections-sign-in");
    fireEvent.click(button);
    expect(onLogin).toHaveBeenCalledWith(login);
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
  });

  it("shows where skills live when none are installed", async () => {
    mount("skills");
    await waitFor(() =>
      expect(screen.getByTestId("connections-skills-empty").textContent).toContain(
        "Skills live in ~/.claude/skills or ~/.agents/skills"
      )
    );
  });

  it("resetsIn picks the coarsest readable unit and drops past resets", () => {
    const now = Date.now();
    expect(resetsIn(new Date(now + 30 * 60_000).toISOString(), now)).toBe("resets in 30m");
    expect(resetsIn(new Date(now + 5 * 3600_000).toISOString(), now)).toBe("resets in 5h");
    expect(resetsIn(new Date(now - 60_000).toISOString(), now)).toBe(null);
  });
});
