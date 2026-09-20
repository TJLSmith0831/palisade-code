import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import ChainRunCard, { type ChainRunCardView } from "../ChainRunCard";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    resolveChainGate: vi.fn().mockResolvedValue(undefined),
    cancelChainRun: vi.fn().mockResolvedValue(undefined),
    rerunChainRun: vi.fn().mockResolvedValue("new-run-id"),
    listChainRuns: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../api", () => apiMock);

function renderCard(run: ChainRunCardView, props: Partial<React.ComponentProps<typeof ChainRunCard>> = {}) {
  return render(
    <MantineProvider>
      <ChainRunCard run={run} projectHash="proj-1" {...props} />
    </MantineProvider>
  );
}

const baseRun: ChainRunCardView = {
  runId: "run-1",
  chain: "review",
  threadId: "thread-1",
  startedAt: new Date(Date.now() - 5000).toISOString(),
  states: { scout: "done", judge: "executing" },
  nodes: {
    scout: { state: "done", sessionId: "session-scout", iterations: 1 },
    judge: { state: "executing", sessionId: "session-judge", iterations: 1 },
  },
  awaiting: null,
  outcome: null,
};

describe("ChainRunCard — one message that mutates", () => {
  it("never renders more than one card across a sequence of updates", () => {
    const { rerender } = renderCard(baseRun);
    expect(screen.queryAllByTestId("chain-run-card")).toHaveLength(1);

    rerender(
      <MantineProvider>
        <ChainRunCard
          run={{ ...baseRun, states: { ...baseRun.states, judge: "done" } }}
          projectHash="proj-1"
        />
      </MantineProvider>
    );
    expect(screen.queryAllByTestId("chain-run-card")).toHaveLength(1);

    rerender(
      <MantineProvider>
        <ChainRunCard
          run={{ ...baseRun, outcome: { kind: "completed", output: "done" } }}
          projectHash="proj-1"
        />
      </MantineProvider>
    );
    expect(screen.queryAllByTestId("chain-run-card")).toHaveLength(1);
  });
});

describe("ChainRunCard — collapsed resting state", () => {
  it("renders chain name, elapsed, one row per node, and Stop", () => {
    renderCard(baseRun);
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText(/Running · \d+s/)).toBeInTheDocument();
    expect(screen.getByTestId("chain-run-card-node-scout")).toBeInTheDocument();
    expect(screen.getByTestId("chain-run-card-node-judge")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("renders a blocked node as 'waiting on M of N', never 'queued'", () => {
    renderCard({
      ...baseRun,
      states: { judge: { kind: "blocked", met: 1, required: 2 } },
      nodes: { judge: { state: { kind: "blocked", met: 1, required: 2 } } },
    });
    const row = screen.getByTestId("chain-run-card-node-judge");
    expect(row).toHaveTextContent("waiting on 1 of 2");
    expect(row).not.toHaveTextContent("queued");
  });
});

describe("ChainRunCard — gate", () => {
  const gateRun: ChainRunCardView = {
    ...baseRun,
    awaiting: { from: "judge", to: "publish", output: "the actual judged text, not a link" },
  };

  it("shows '<role> is waiting for you' with the upstream output rendered inline", () => {
    renderCard(gateRun);
    expect(screen.getByText("judge is waiting for you")).toBeInTheDocument();
    // P1 from the critique: a link alone is not evidence. The real text must
    // be present in the DOM, not merely reachable via a click-through.
    expect(screen.getByTestId("chain-run-card-gate-output")).toHaveTextContent(
      "the actual judged text, not a link"
    );
  });

  it("reveals an inline note field on Send back and submits on Enter", async () => {
    renderCard(gateRun);
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    const note = screen.getByTestId("chain-run-card-sendback-note");
    expect(note).toBeInTheDocument();
    fireEvent.change(note, { target: { value: "please tighten this up" } });
    fireEvent.keyDown(note, { key: "Enter" });
    await waitFor(() =>
      expect(apiMock.resolveChainGate).toHaveBeenCalledWith("run-1", "sendBack", "please tighten this up")
    );
  });

  it("sets awaiting.resolved via the onGateResolved callback the card is given, disabling the canvas's bar", async () => {
    const onGateResolved = vi.fn();
    renderCard(gateRun, { onGateResolved });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByTestId("chain-run-card-node-scout");
    expect(apiMock.resolveChainGate).toHaveBeenCalledWith("run-1", "approve", undefined);
    expect(onGateResolved).toHaveBeenCalledWith("approve");
  });

  it("collapses a resolved gate to a resolved line, returns to Running, and keeps the decision in the card's history after the gate itself clears", () => {
    const { rerender } = renderCard(gateRun);

    rerender(
      <MantineProvider>
        <ChainRunCard
          run={{ ...gateRun, awaiting: { ...gateRun.awaiting!, resolved: "approve" } }}
          projectHash="proj-1"
        />
      </MantineProvider>
    );
    expect(screen.getByTestId("chain-run-card-gate-resolved")).toHaveTextContent("Approved");

    // The next node event clears `awaiting` entirely (App.tsx's reducer) —
    // the card should read as a normal Running card again, but the decision
    // it already showed must not disappear.
    rerender(
      <MantineProvider>
        <ChainRunCard
          run={{ ...baseRun, awaiting: null, states: { ...baseRun.states, judge: "executing" } }}
          projectHash="proj-1"
        />
      </MantineProvider>
    );
    expect(screen.queryByTestId("chain-run-card-gate")).not.toBeInTheDocument();
    expect(screen.getByTestId("chain-run-card-history")).toHaveTextContent("Approved");
  });

  it("does not dismiss the gate on Escape", () => {
    renderCard(gateRun);
    expect(screen.getByTestId("chain-run-card-gate")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByTestId("chain-run-card-gate")).toBeInTheDocument();
  });
});

describe("ChainRunCard — past runs (D8)", () => {
  it("is collapsed by default and expands to show run history on request", async () => {
    apiMock.listChainRuns.mockResolvedValue([
      {
        id: "past-run-1",
        projectHash: "proj-1",
        threadId: "thread-1",
        chainName: "review",
        chainSnapshot: { name: "review", nodes: {}, edges: [], entry: "scout", timeoutSeconds: 1800, retry: { maxAttempts: 2 } },
        seed: "seed",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        outcome: { kind: "completed", output: "done" },
        nodes: {},
      },
    ]);
    renderCard(baseRun);

    expect(screen.queryByTestId("chain-run-card-history-section")).not.toBeInTheDocument();
    expect(apiMock.listChainRuns).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("chain-run-card-history-toggle"));

    expect(await screen.findByTestId("chain-run-row-past-run-1")).toBeInTheDocument();
    expect(apiMock.listChainRuns).toHaveBeenCalledWith("proj-1", "review", true);
  });

  it("re-runs a past record through the same rerunChainRun path re-run-from-node uses", async () => {
    apiMock.listChainRuns.mockResolvedValue([
      {
        id: "past-run-1",
        projectHash: "proj-1",
        threadId: "thread-1",
        chainName: "review",
        chainSnapshot: {
          name: "review",
          nodes: { scout: { role: "scout", guideline: "", agent: "claude" } },
          edges: [],
          entry: "scout",
          timeoutSeconds: 1800,
          retry: { maxAttempts: 2 },
        },
        seed: "seed",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        outcome: { kind: "completed", output: "done" },
        nodes: {},
      },
    ]);
    renderCard(baseRun);
    fireEvent.click(screen.getByTestId("chain-run-card-history-toggle"));
    await screen.findByTestId("chain-run-row-past-run-1");

    fireEvent.click(screen.getByRole("button", { name: /Actions for run from/ }));
    fireEvent.click(await screen.findByText("Re-run from scout"));

    await waitFor(() =>
      expect(apiMock.rerunChainRun).toHaveBeenCalledWith("proj-1", "past-run-1", "scout", "thread-1")
    );
  });
});

describe("ChainRunCard — stop and re-run", () => {
  it("calls api.cancelChainRun on Stop", async () => {
    renderCard(baseRun);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(apiMock.cancelChainRun).toHaveBeenCalledWith("run-1"));
  });

  it("offers Re-run and Re-run from here on a finished card, calling api.rerunChainRun", async () => {
    const finished: ChainRunCardView = {
      ...baseRun,
      outcome: { kind: "gateFailed", at: "judge", command: "lint" },
    };
    renderCard(finished);
    fireEvent.click(screen.getByRole("button", { name: "Re-run" }));
    await waitFor(() =>
      expect(apiMock.rerunChainRun).toHaveBeenCalledWith("proj-1", "run-1", undefined, "thread-1")
    );

    fireEvent.click(screen.getByRole("button", { name: "Re-run from here" }));
    await waitFor(() =>
      expect(apiMock.rerunChainRun).toHaveBeenCalledWith("proj-1", "run-1", "judge", "thread-1")
    );
  });

  it("has no Stop button once the run has an outcome", () => {
    renderCard({ ...baseRun, outcome: { kind: "completed", output: "done" } });
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });
});
