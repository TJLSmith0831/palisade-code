import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import ChainsPanel from "../ChainsPanel";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listChains: vi.fn(),
    deleteChain: vi.fn().mockResolvedValue(undefined),
    saveChain: vi.fn().mockResolvedValue(undefined),
    listModels: vi.fn().mockResolvedValue({ models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }] }),
  },
}));
vi.mock("../api", () => apiMock);

// Isolate ChainsPanel from ChainRunHistory's own behaviour (covered in its
// own test file) so this file only proves the wiring between them.
vi.mock("../ChainRunHistory", () => ({
  default: (props: { projectHash: string; chainName: string }) => (
    <div data-testid="chain-run-history-stub">
      history for {props.chainName} in {props.projectHash}
    </div>
  ),
}));

const chain = {
  name: "review",
  entry: "scout",
  timeoutSeconds: 1800,
  retry: { maxAttempts: 2 },
  nodes: {
    scout: { role: "scout", agent: "codex", guideline: "inspect" },
    judge: { role: "judge", agent: "codex", guideline: "judge" },
  },
  edges: [{ from: "scout", to: "judge" }],
};

beforeEach(() => {
  apiMock.listChains.mockReset();
  apiMock.deleteChain.mockClear();
  apiMock.saveChain.mockClear();
  apiMock.listModels.mockReset();
  apiMock.listModels.mockResolvedValue({ models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }] });
});

describe("ChainsPanel", () => {
  it("lists chains and opens one on click", async () => {
    apiMock.listChains.mockResolvedValue([chain]);
    const onOpen = vi.fn();

    render(
      <MantineProvider>
        <ChainsPanel projectHash="proj-1" onOpen={onOpen} />
      </MantineProvider>
    );

    fireEvent.click(await screen.findByTestId("chain-row-review"));
    expect(onOpen).toHaveBeenCalledWith("review");
  });

  /// At 215px a name beside the count and the controls read "gated-l…", so
  /// the count moved to its own line and says what it counts.
  it("gives the name its own line and labels the node count", async () => {
    apiMock.listChains.mockResolvedValue([chain]);

    render(
      <MantineProvider>
        <ChainsPanel projectHash="proj-1" onOpen={vi.fn()} />
      </MantineProvider>
    );

    const name = await screen.findByTestId("chain-row-review");
    expect(name.textContent).toBe("review");
    expect(screen.getByText("2 nodes")).toBeTruthy();
  });

  it("calls onRun with the chain name and a seed argument", async () => {
    apiMock.listChains.mockResolvedValue([chain]);
    const onRun = vi.fn();

    render(
      <MantineProvider>
        <ChainsPanel projectHash="proj-1" onOpen={vi.fn()} onRun={onRun} />
      </MantineProvider>
    );

    fireEvent.click(await screen.findByLabelText("Actions for review"));
    fireEvent.click(await screen.findByText("Run"));

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0]).toBe("review");
    expect(typeof onRun.mock.calls[0][1]).toBe("string");
  });

  it("duplicates a playbook under a free name and opens the copy", async () => {
    apiMock.listChains.mockResolvedValue([chain, { ...chain, name: "review copy" }]);
    const onOpen = vi.fn();

    render(
      <MantineProvider>
        <ChainsPanel projectHash="proj-1" onOpen={onOpen} />
      </MantineProvider>
    );

    fireEvent.click(await screen.findByLabelText("Actions for review"));
    fireEvent.click(await screen.findByText("Duplicate"));

    await waitFor(() => expect(apiMock.saveChain).toHaveBeenCalledTimes(1));
    const [, saved] = apiMock.saveChain.mock.calls[0];
    expect(saved).toEqual({ ...chain, name: "review copy 2" });
    expect(onOpen).toHaveBeenCalledWith("review copy 2");
  });

  // Deleting is the one action in this panel with no undo.
  it("asks before deleting, and only deletes on the second click", async () => {
    apiMock.listChains.mockResolvedValue([chain]);

    render(
      <MantineProvider>
        <ChainsPanel projectHash="proj-1" onOpen={vi.fn()} />
      </MantineProvider>
    );

    fireEvent.click(await screen.findByLabelText("Actions for review"));
    fireEvent.click(await screen.findByText("Delete…"));
    expect(apiMock.deleteChain).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByTestId("chains-panel-confirm-delete"));
    await waitFor(() => expect(apiMock.deleteChain).toHaveBeenCalledWith("proj-1", "review"));
  });

  it("toggles run history for a chain and forwards projectHash/chainName", async () => {
    apiMock.listChains.mockResolvedValue([chain]);

    render(
      <MantineProvider>
        <ChainsPanel projectHash="proj-1" onOpen={vi.fn()} />
      </MantineProvider>
    );

    await screen.findByTestId("chain-row-review");
    expect(screen.queryByTestId("chain-run-history-stub")).toBeNull();

    fireEvent.click(screen.getByLabelText("Run history for review"));

    expect(await screen.findByTestId("chain-run-history-stub")).toHaveTextContent(
      "history for review in proj-1"
    );

    fireEvent.click(screen.getByLabelText("Run history for review"));
    await waitFor(() =>
      expect(screen.queryByTestId("chain-run-history-stub")).toBeNull()
    );
  });

  it("shows an empty state when there are no chains", async () => {
    apiMock.listChains.mockResolvedValue([]);

    render(
      <MantineProvider>
        <ChainsPanel projectHash="proj-1" onOpen={vi.fn()} />
      </MantineProvider>
    );

    expect(await screen.findByText(/No playbooks yet/)).toBeInTheDocument();
  });

  it("empty state offers a worked example that saves and opens it (D16)", async () => {
    apiMock.listChains.mockResolvedValue([]);
    const onOpen = vi.fn();

    render(
      <MantineProvider>
        <ChainsPanel projectHash="proj-1" onOpen={onOpen} agents={[{ id: "claude-code", name: "Claude Code" }]} />
      </MantineProvider>
    );

    fireEvent.click(await screen.findByTestId("chains-panel-open-example"));

    await waitFor(() =>
      expect(apiMock.saveChain).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          name: "Example - draft then review",
          edges: expect.arrayContaining([
            expect.objectContaining({ from: "reviewer", to: "drafter", gate: { type: "approval" } }),
          ]),
          nodes: expect.objectContaining({
            drafter: expect.objectContaining({ model: "claude-sonnet-5" }),
            reviewer: expect.objectContaining({ model: "claude-sonnet-5" }),
          }),
        })
      )
    );
    expect(onOpen).toHaveBeenCalledWith("Example - draft then review");
  });

  it("never dead-ends: shows an inline warning naming the agent by display name when none offers a model", async () => {
    apiMock.listChains.mockResolvedValue([]);
    apiMock.listModels.mockResolvedValue({ models: [] });
    const onOpen = vi.fn();

    render(
      <MantineProvider>
        <ChainsPanel
          projectHash="proj-1"
          onOpen={onOpen}
          agents={[{ id: "devin", name: "Devin" }]}
        />
      </MantineProvider>
    );

    fireEvent.click(await screen.findByTestId("chains-panel-open-example"));

    const warning = await screen.findByTestId("chains-panel-example-blocked");
    expect(warning.textContent).toContain("Devin");
    expect(warning.textContent).not.toContain("devin offers no models");
    // The empty-state explanation and the button both stay on screen — no
    // bare error replaces them.
    expect(screen.getByText(/No playbooks yet/)).toBeInTheDocument();
    expect(screen.getByTestId("chains-panel-open-example")).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("tries every installed agent before giving up, so one signed-out agent doesn't block the others", async () => {
    apiMock.listChains.mockResolvedValue([]);
    apiMock.listModels.mockImplementation((_project: string, agentId: string) =>
      agentId === "devin"
        ? Promise.resolve({ models: [] })
        : Promise.resolve({ models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }] })
    );
    const onOpen = vi.fn();

    render(
      <MantineProvider>
        <ChainsPanel
          projectHash="proj-1"
          onOpen={onOpen}
          agents={[
            { id: "devin", name: "Devin" },
            { id: "claude-code", name: "Claude Code" },
          ]}
        />
      </MantineProvider>
    );

    fireEvent.click(await screen.findByTestId("chains-panel-open-example"));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("Example - draft then review"));
    expect(screen.queryByTestId("chains-panel-example-blocked")).toBeNull();
  });

  it("does not re-save the example if it's already there", async () => {
    apiMock.listChains.mockResolvedValue([{ ...chain, name: "Example - draft then review" }]);
    const onOpen = vi.fn();

    render(
      <MantineProvider>
        <ChainsPanel projectHash="proj-1" onOpen={onOpen} />
      </MantineProvider>
    );

    // Not the empty state (a chain already exists) — reached via the row's
    // own open action instead of the empty-state button in this branch.
    fireEvent.click(await screen.findByTestId("chain-row-Example - draft then review"));
    expect(onOpen).toHaveBeenCalledWith("Example - draft then review");
    expect(apiMock.saveChain).not.toHaveBeenCalled();
  });

  it("surfaces a listChains rejection as an error", async () => {
    apiMock.listChains.mockRejectedValue(new Error("boom"));

    render(
      <MantineProvider>
        <ChainsPanel projectHash="proj-1" onOpen={vi.fn()} />
      </MantineProvider>
    );

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });
});
