import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import ChainsPanel from "../ChainsPanel";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listChains: vi.fn(),
    deleteChain: vi.fn().mockResolvedValue(undefined),
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

  it("calls onRun with the chain name and a seed argument", async () => {
    apiMock.listChains.mockResolvedValue([chain]);
    const onRun = vi.fn();

    render(
      <MantineProvider>
        <ChainsPanel projectHash="proj-1" onOpen={vi.fn()} onRun={onRun} />
      </MantineProvider>
    );

    fireEvent.click(await screen.findByLabelText("Actions for review"));
    fireEvent.click(await screen.findByText("Run on this thread"));

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(onRun.mock.calls[0][0]).toBe("review");
    expect(typeof onRun.mock.calls[0][1]).toBe("string");
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

    expect(await screen.findByText(/No chains yet/)).toBeInTheDocument();
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
