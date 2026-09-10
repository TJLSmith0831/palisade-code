import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import ChainCanvas, { turnCeiling, type RunView } from "../ChainCanvas";

const appCssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../App.css");

// jsdom has no FontFaceSet, so Mantine's Textarea autosize (used by the node
// editor's Guideline field) throws on mount trying to call
// document.fonts.addEventListener. Every other test in this file that opens
// the node editor happens not to depend on the result, so the crash goes
// unnoticed; the Model Select test below does. Scoped here rather than in
// the shared setup.ts, which this wave doesn't own.
(document as unknown as { fonts: unknown }).fonts ??= {
  addEventListener() {},
  removeEventListener() {},
};

/** Mocks the canvas surface's measured size — jsdom has no layout engine, so
 *  every element's getBoundingClientRect is all-zero unless stubbed. Tracked
 *  and restored per test so it doesn't leak into unrelated ones below it. */
let rectSpy: ReturnType<typeof vi.spyOn> | undefined;
afterEach(() => {
  rectSpy?.mockRestore();
  rectSpy = undefined;
});
function mockSurfaceRect(rect: Partial<DOMRect>) {
  rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, toJSON() {}, ...rect,
  } as DOMRect);
  return rectSpy;
}

/** Reads back the plane's pan/zoom from its inline transform style. */
function planeTransform(): { x: number; y: number; zoom: number } {
  const plane = document.querySelector(".ds-chain-plane") as HTMLElement;
  const match = plane.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/);
  if (!match) throw new Error(`unexpected transform: ${plane.style.transform}`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

vi.mock("../ChainsPanel", () => ({ announceChainsChanged: vi.fn() }));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listChains: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue({ models: [] }),
    saveChain: vi.fn().mockResolvedValue(undefined),
    cancelChainRun: vi.fn().mockResolvedValue(undefined),
    resolveChainGate: vi.fn().mockResolvedValue(undefined),
    listChainRuns: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../api", () => apiMock);

// CHA-02: the audit's live-app click reported zero DOM/IPC effect from the
// toolbar's "+ Node" button. The toolbar's Zoom-in control also uses a
// plus icon with no distinguishing testid — a plausible reason an automated
// click landed on the wrong element. This drives the real click through
// Testing Library's accessible-name query (unambiguous: "Node" vs "Zoom in")
// to check whether the underlying addNode() logic itself is broken.
describe("ChainCanvas — add node (CHA-02)", () => {
  it("adds a new node to the canvas when the toolbar's Node button is clicked", async () => {
    render(
      <MantineProvider>
        <ChainCanvas
          projectHash="proj-1"
          chainName={null}
          agents={[{ id: "claude", name: "Claude Agent" }]}
          verifyCommands={[]}
        />
      </MantineProvider>
    );

    expect(screen.queryAllByTestId(/^chain-node-/)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Node" }));

    const nodes = screen.queryAllByTestId(/^chain-node-/);
    expect(nodes).toHaveLength(1);
  });

  it("adds a second, independently-named node on a second click", async () => {
    render(
      <MantineProvider>
        <ChainCanvas
          projectHash="proj-1"
          chainName={null}
          agents={[{ id: "claude", name: "Claude Agent" }]}
          verifyCommands={[]}
        />
      </MantineProvider>
    );

    const addNode = screen.getByRole("button", { name: "Node" });
    fireEvent.click(addNode);
    fireEvent.click(addNode);

    expect(screen.queryAllByTestId(/^chain-node-/)).toHaveLength(2);
  });
});

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
  layout: {},
};

describe("ChainCanvas — test run mode", () => {
  it("opens a seed composer from Test run and starts only after a seed is confirmed", async () => {
    const onRun = vi.fn();
    apiMock.listChains.mockResolvedValueOnce([chain]);
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName="review" agents={[]} verifyCommands={[]} onRun={onRun} />
      </MantineProvider>
    );

    await screen.findByRole("button", { name: "Test run" });
    fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    expect(onRun).not.toHaveBeenCalled();
    expect(await screen.findByLabelText("Seed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start test" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Seed"), { target: { value: "find risks" } });
    fireEvent.click(screen.getByRole("button", { name: "Start test" }));
    expect(onRun).toHaveBeenCalledWith("review", "find risks");
  });

  it("shows a blocked node and stops an active run", async () => {
    apiMock.listChains.mockResolvedValueOnce([chain]);
    const run: RunView = {
      runId: "run-1",
      states: { judge: { kind: "blocked", met: 1, required: 2 } },
      awaiting: null,
      outcome: null,
    };
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName="review" agents={[]} verifyCommands={[]} run={run} />
      </MantineProvider>
    );
    expect(await screen.findByText("waiting on 1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(apiMock.cancelChainRun).toHaveBeenCalledWith("run-1");
  });

  it("keeps a node session for transcript click-through and restores gate controls after an error", async () => {
    apiMock.listChains.mockResolvedValueOnce([chain]);
    apiMock.resolveChainGate.mockRejectedValueOnce(new Error("gate offline"));
    const onTranscript = vi.fn();
    const run: RunView = {
      runId: "run-2",
      states: { scout: "done" },
      nodes: { scout: { state: "done", sessionId: "session-7", iterations: 1 } },
      awaiting: { from: "scout", to: "judge", output: "actual upstream evidence" },
      outcome: null,
    };
    render(<MantineProvider><ChainCanvas projectHash="proj-1" chainName="review" agents={[]} verifyCommands={[]} run={run} onTranscript={onTranscript} /></MantineProvider>);
    await screen.findByTestId("chain-node-scout");
    fireEvent.click(screen.getByTestId("chain-node-scout"));
    expect(onTranscript).toHaveBeenCalledWith("session-7");
    expect(screen.getByText("actual upstream evidence")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/gate offline/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });
});

describe("turnCeiling", () => {
  it("counts linear, fan-out, and gated-loop graph turns", () => {
    expect(turnCeiling(chain)).toBe(2);
    expect(turnCeiling({ ...chain, nodes: { ...chain.nodes, audit: { role: "audit", agent: "codex", guideline: "audit" } }, edges: [{ from: "scout", to: "judge" }, { from: "scout", to: "audit" }] })).toBe(3);
    expect(turnCeiling({ ...chain, edges: [...chain.edges, { from: "judge", to: "scout", gate: { type: "approval" }, maxIterations: 2 }] })).toBe(4);
  });
});

// Wave H: two Wave E requirements that shipped without a test (PLAN §5, Wave H).

describe("ChainCanvas — Test run guard (Wave E gap)", () => {
  it("shows Test run once a chain opened with chainName === null is saved", async () => {
    const onRun = vi.fn();
    render(
      <MantineProvider>
        <ChainCanvas
          projectHash="proj-1"
          chainName={null}
          agents={[{ id: "claude", name: "Claude Agent" }]}
          verifyCommands={[]}
          onRun={onRun}
        />
      </MantineProvider>
    );

    expect(screen.queryByRole("button", { name: "Test run" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Node" }));
    fireEvent.change(screen.getByTestId("chain-name"), { target: { value: "brand-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("button", { name: "Test run" });
  });
});

describe("ChainCanvas — one-gate-two-surfaces invariant (Wave E gap)", () => {
  it("fires onGateResolved with the decision after a successful resolveChainGate", async () => {
    apiMock.listChains.mockResolvedValueOnce([chain]);
    apiMock.resolveChainGate.mockResolvedValueOnce(undefined);
    const onGateResolved = vi.fn();
    const run: RunView = {
      runId: "run-3",
      states: { scout: "done" },
      awaiting: { from: "scout", to: "judge", output: "evidence" },
      outcome: null,
    };
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName="review" agents={[]} verifyCommands={[]} run={run} onGateResolved={onGateResolved} />
      </MantineProvider>
    );
    await screen.findByTestId("chain-approval");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onGateResolved).toHaveBeenCalledWith("approve"));
  });

  it("does not fire onGateResolved when resolveChainGate rejects", async () => {
    apiMock.listChains.mockResolvedValueOnce([chain]);
    apiMock.resolveChainGate.mockRejectedValueOnce(new Error("gate offline"));
    const onGateResolved = vi.fn();
    const run: RunView = {
      runId: "run-4",
      states: { scout: "done" },
      awaiting: { from: "scout", to: "judge", output: "evidence" },
      outcome: null,
    };
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName="review" agents={[]} verifyCommands={[]} run={run} onGateResolved={onGateResolved} />
      </MantineProvider>
    );
    await screen.findByTestId("chain-approval");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(screen.getByText(/gate offline/)).toBeInTheDocument());
    expect(onGateResolved).not.toHaveBeenCalled();
  });
});

// Wave H's own scope: critique P2s and minors on ChainCanvas.tsx.

describe("ChainCanvas — keyboard-operable nodes", () => {
  it("gives each node an accessible name and opens its editor on Enter", async () => {
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName={null} agents={[{ id: "claude", name: "Claude Agent" }]} verifyCommands={[]} />
      </MantineProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Node" }));
    fireEvent.keyDown(document.body, { key: "Escape" }); // close the auto-opened editor first
    // Distinct from the connect-port button, whose accessible name is
    // "Connect from step" — an unanchored match on "step" would hit both.
    const node = screen.getByRole("button", { name: "Node step, Claude Agent" });
    fireEvent.keyDown(node, { key: "Enter" });
    expect(await screen.findByTestId("node-role")).toBeInTheDocument();
  });

  it("opens its editor on Space", async () => {
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName={null} agents={[{ id: "claude", name: "Claude Agent" }]} verifyCommands={[]} />
      </MantineProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Node" }));
    fireEvent.keyDown(document.body, { key: "Escape" }); // close the auto-opened editor
    const node = screen.getByTestId("chain-node-step");
    fireEvent.keyDown(node, { key: " " });
    expect(await screen.findByTestId("node-role")).toBeInTheDocument();
  });

  it("removes the node on Delete", async () => {
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName={null} agents={[{ id: "claude", name: "Claude Agent" }]} verifyCommands={[]} />
      </MantineProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Node" }));
    const node = screen.getByTestId("chain-node-step");
    fireEvent.keyDown(node, { key: "Delete" });
    expect(screen.queryAllByTestId(/^chain-node-/)).toHaveLength(0);
  });
});

describe("ChainCanvas — focus ring", () => {
  it("gives the canvas surface and its nodes a visible focus-visible ring using the accent token", () => {
    const appCss = readFileSync(appCssPath, "utf8");
    expect(appCss).toMatch(/\.ds-chain-surface:focus-visible\s*{[^}]*box-shadow:[^}]*var\(--accent\)/);
    expect(appCss).toMatch(/\.ds-chain-node:focus-visible\s*{[^}]*box-shadow:[^}]*var\(--accent\)/);
  });
});

describe("ChainCanvas — removeNode layout cleanup", () => {
  it("clears the removed node's layout entry instead of leaking it", async () => {
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName={null} agents={[{ id: "claude", name: "Claude Agent" }]} verifyCommands={[]} />
      </MantineProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Node" })); // adds "step"
    fireEvent.click(screen.getByRole("button", { name: "Node" })); // adds "step-2"
    // Keyboard delete (H2) removes "step" without needing to route through
    // its editor modal — and without disturbing "step-2"'s.
    fireEvent.keyDown(screen.getByTestId("chain-node-step"), { key: "Delete" });
    fireEvent.change(screen.getByTestId("chain-name"), { target: { value: "cleanup" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiMock.saveChain).toHaveBeenCalled());
    const saved = apiMock.saveChain.mock.calls.at(-1)![1];
    expect(saved.layout).not.toHaveProperty("step");
    expect(saved.layout).toHaveProperty("step-2");
  });
});

describe("ChainCanvas — addNode closure race", () => {
  it("produces two distinctly-named nodes even when both adds fire before a render commits", () => {
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName={null} agents={[{ id: "claude", name: "Claude Agent" }]} verifyCommands={[]} />
      </MantineProvider>
    );
    const addBtn = screen.getByRole("button", { name: "Node" });
    act(() => {
      fireEvent.click(addBtn);
      fireEvent.click(addBtn);
    });
    expect(screen.queryAllByTestId(/^chain-node-/)).toHaveLength(2);
  });
});

describe("ChainCanvas — Fit to view", () => {
  it("scales and pans so every node lands inside the visible surface", async () => {
    mockSurfaceRect({ width: 800, height: 600 });
    const farChain = {
      ...chain,
      nodes: {
        a: { role: "a", agent: "codex", guideline: "" },
        b: { role: "b", agent: "codex", guideline: "" },
      },
      entry: "a",
      edges: [],
      layout: { a: { x: 0, y: 0 }, b: { x: 1200, y: 300 } },
    };
    apiMock.listChains.mockResolvedValueOnce([farChain]);
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName="review" agents={[]} verifyCommands={[]} />
      </MantineProvider>
    );
    await screen.findByTestId("chain-node-a");
    fireEvent.click(screen.getByRole("button", { name: "Fit to view" }));
    const { x, y, zoom } = planeTransform();
    const NODE_W = 190;
    const NODE_H = 78;
    for (const pos of [{ x: 0, y: 0 }, { x: 1200, y: 300 }]) {
      const left = pos.x * zoom + x;
      const top = pos.y * zoom + y;
      expect(left).toBeGreaterThanOrEqual(-1);
      expect(left + NODE_W * zoom).toBeLessThanOrEqual(801);
      expect(top).toBeGreaterThanOrEqual(-1);
      expect(top + NODE_H * zoom).toBeLessThanOrEqual(601);
    }
  });
});

describe("ChainCanvas — cursor-anchored wheel zoom", () => {
  it("keeps the point under the cursor fixed while zooming, instead of anchoring to the plane origin", () => {
    mockSurfaceRect({ left: 100, top: 50, width: 800, height: 600 });
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName={null} agents={[]} verifyCommands={[]} />
      </MantineProvider>
    );
    const surface = screen.getByLabelText("Chain graph");
    fireEvent.wheel(surface, { ctrlKey: true, deltaY: -100, clientX: 300, clientY: 250 });
    const { x, y, zoom } = planeTransform();
    // Cursor at (200, 200) relative to the surface; zoom goes 1 -> 1.2.
    // Origin-anchored zoom would leave x/y at 0.
    expect(zoom).toBeCloseTo(1.2, 5);
    expect(x).toBeCloseTo(-40, 5);
    expect(y).toBeCloseTo(-40, 5);
  });
});

describe("ChainCanvas — double-click does not double-fire", () => {
  it("does not re-fit the view when double-clicking a node", () => {
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName={null} agents={[{ id: "claude", name: "Claude Agent" }]} verifyCommands={[]} />
      </MantineProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Node" }));
    const before = planeTransform();
    fireEvent.doubleClick(screen.getByTestId("chain-node-step"));
    const after = planeTransform();
    expect(after).toEqual(before);
  });
});

describe("ChainCanvas — Model Select loading state", () => {
  it("does not claim 'No models offered' while listModels is still pending", async () => {
    apiMock.listChains.mockResolvedValueOnce([chain]);
    let resolveModels: (v: { models: Array<{ id: string; name: string }> }) => void = () => {};
    apiMock.listModels.mockImplementationOnce(
      () => new Promise((resolve) => { resolveModels = resolve; })
    );
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName="review" agents={[{ id: "codex", name: "Codex" }]} verifyCommands={[]} />
      </MantineProvider>
    );
    fireEvent.click(await screen.findByTestId("chain-node-scout"));
    const modelSelect = await screen.findByTestId("node-model");
    expect(modelSelect).not.toHaveAttribute("placeholder", "No models offered");
    resolveModels({ models: [] });
    await waitFor(() => expect(modelSelect).toHaveAttribute("placeholder", "No models offered"));
  });
});

describe("ChainCanvas — dirty indicator", () => {
  it("shows an unsaved-changes indicator after editing a loaded chain, and clears it after Save", async () => {
    apiMock.listChains.mockResolvedValueOnce([chain]);
    render(
      <MantineProvider>
        <ChainCanvas projectHash="proj-1" chainName="review" agents={[{ id: "codex", name: "Codex" }]} verifyCommands={[]} />
      </MantineProvider>
    );
    await screen.findByTestId("chain-node-scout");
    expect(screen.queryByTestId("chain-dirty")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("chain-name"), { target: { value: "review-2" } });
    expect(await screen.findByTestId("chain-dirty")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByTestId("chain-dirty")).not.toBeInTheDocument());
  });
});
