import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import ChainRunHistory from "../ChainRunHistory";
import type { ChainRunRecord } from "../api";

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listChainRuns: vi.fn(),
  },
}));
vi.mock("../api", () => apiMock);

function record(overrides: Partial<ChainRunRecord>): ChainRunRecord {
  return {
    id: "run-1",
    projectHash: "proj-1",
    threadId: "thread-1",
    chainName: "review",
    chainSnapshot: {
      name: "review",
      entry: "scout",
      timeoutSeconds: 1800,
      retry: { maxAttempts: 2 },
      nodes: {
        scout: { role: "scout", agent: "codex", guideline: "inspect" },
        judge: { role: "judge", agent: "codex", guideline: "judge" },
      },
      edges: [{ from: "scout", to: "judge" }],
    },
    seed: "seed text",
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:05:00.000Z",
    outcome: { kind: "completed", output: "done" },
    nodes: {
      scout: {
        transitions: [
          { state: { kind: "executing" }, at: "2026-09-01T00:00:00.000Z" },
          { state: { kind: "done" }, at: "2026-09-01T00:01:00.000Z" },
        ],
        sessionId: "sess-scout",
        iterations: 1,
        output: "scout output",
        cost: { amount: 0.12, currency: "USD" },
      },
      judge: {
        transitions: [
          { state: { kind: "executing" }, at: "2026-09-01T00:01:00.000Z" },
          { state: { kind: "done" }, at: "2026-09-01T00:05:00.000Z" },
        ],
        sessionId: "sess-judge",
        iterations: 1,
        output: "judge output",
        cost: null,
      },
    },
    ...overrides,
  };
}

function renderHistory(props: Partial<React.ComponentProps<typeof ChainRunHistory>> = {}) {
  return render(
    <MantineProvider>
      <ChainRunHistory projectHash="proj-1" chainName="review" {...props} />
    </MantineProvider>
  );
}

beforeEach(() => {
  apiMock.listChainRuns.mockReset();
});

describe("ChainRunHistory — list and sort", () => {
  it("renders the run list sorted newest first by startedAt", async () => {
    apiMock.listChainRuns.mockResolvedValue([
      record({ id: "oldest", startedAt: "2026-09-01T00:00:00.000Z" }),
      record({ id: "newest", startedAt: "2026-09-03T00:00:00.000Z" }),
      record({ id: "middle", startedAt: "2026-09-02T00:00:00.000Z" }),
    ]);

    renderHistory();

    const rows = await screen.findAllByTestId(/^chain-run-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "chain-run-row-newest",
      "chain-run-row-middle",
      "chain-run-row-oldest",
    ]);
  });
});

describe("ChainRunHistory — honest outcome labels (D18)", () => {
  it.each([
    [{ kind: "completed", output: "x" } as const, /completed|finished/i],
    [{ kind: "cancelled", at: ["scout"] } as const, /cancelled/i],
    [{ kind: "capReached", at: "judge", maxIterations: 5 } as const, /cap.*reach|5/i],
    [{ kind: "interrupted" } as const, /interrupted/i],
    [{ kind: "gateFailed", at: "judge", command: "npm test" } as const, /gate|npm test/i],
    [{ kind: "timedOut", at: "judge", afterSeconds: 90 } as const, /timed out|90/i],
    [{ kind: "retriesExhausted", at: "judge", attempts: 3, message: "boom" } as const, /retries|3 attempt/i],
  ])("names a reason for outcome %o", async (outcome, expected) => {
    apiMock.listChainRuns.mockResolvedValue([record({ id: "r1", outcome })]);

    renderHistory();

    const row = await screen.findByTestId("chain-run-row-r1");
    expect(row.textContent).toMatch(expected);
  });

  it("never renders a cap-reached or cancelled run as if it finished cleanly", async () => {
    apiMock.listChainRuns.mockResolvedValue([
      record({ id: "capped", outcome: { kind: "capReached", at: "judge", maxIterations: 5 } }),
    ]);

    renderHistory();

    const row = await screen.findByTestId("chain-run-row-capped");
    expect(row.textContent).not.toMatch(/^Completed$/i);
    expect(row.querySelector('[data-outcome-tone="success"]')).toBeNull();
  });
});

describe("ChainRunHistory — per-node timings", () => {
  it("renders per-node timings derived from transitions", async () => {
    apiMock.listChainRuns.mockResolvedValue([
      record({
        id: "timed",
        nodes: {
          scout: {
            transitions: [
              { state: { kind: "executing" }, at: "2026-09-01T00:00:00.000Z" },
              { state: { kind: "done" }, at: "2026-09-01T00:00:03.000Z" },
            ],
            sessionId: "sess-scout",
            iterations: 1,
            output: "o",
            cost: null,
          },
          judge: {
            transitions: [
              { state: { kind: "executing" }, at: "2026-09-01T00:00:03.000Z" },
              { state: { kind: "done" }, at: "2026-09-01T00:00:13.000Z" },
            ],
            sessionId: "sess-judge",
            iterations: 1,
            output: "o",
            cost: null,
          },
        },
      }),
    ]);

    renderHistory();

    const row = await screen.findByTestId("chain-run-row-timed");
    expect(row.textContent).toMatch(/3(\.0)?s/);
    expect(row.textContent).toMatch(/10(\.0)?s/);
  });
});

describe("ChainRunHistory — cost labeling (D-d)", () => {
  it("labels partial cost by role and never presents it as a run total; unknown cost never reads as 0.00", async () => {
    apiMock.listChainRuns.mockResolvedValue([record({ id: "costy" })]);

    renderHistory();

    const row = await screen.findByTestId("chain-run-row-costy");
    // scout reported cost -> named and shown
    expect(row.textContent).toMatch(/scout/i);
    expect(row.textContent).toMatch(/0\.12/);
    // judge has cost: null -> must read as unknown, never as 0.00
    expect(row.textContent).not.toMatch(/judge[^a-zA-Z]{0,20}0\.00/i);
    // the label must not imply the shown figure is the complete run cost
    expect(row.textContent).not.toMatch(/total run cost/i);
  });
});

describe("ChainRunHistory — re-run", () => {
  it("Re-run calls onRerun with the record's id and no fromRole", async () => {
    apiMock.listChainRuns.mockResolvedValue([record({ id: "run-x" })]);
    const onRerun = vi.fn();

    renderHistory({ onRerun });

    const row = await screen.findByTestId("chain-run-row-run-x");
    fireEvent.click(within(row).getByRole("button", { name: /actions/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^re-run$/i }));

    expect(onRerun).toHaveBeenCalledWith("run-x", undefined);
  });

  it("Re-run from here on node judge calls onRerun with the record id and role 'judge'", async () => {
    apiMock.listChainRuns.mockResolvedValue([record({ id: "run-x" })]);
    const onRerun = vi.fn();

    renderHistory({ onRerun });

    const row = await screen.findByTestId("chain-run-row-run-x");
    fireEvent.click(within(row).getByRole("button", { name: /actions/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /re-run from judge/i }));

    expect(onRerun).toHaveBeenCalledWith("run-x", "judge");
  });

  it("composes re-run-from-node options from the record's chainSnapshot, never a currently-listed chain", async () => {
    // The snapshot below carries a role ("archivist") that would not exist
    // in any "current" definition of this chain — proving the menu is
    // built only from the record, since this component is never given the
    // live chain list at all.
    apiMock.listChainRuns.mockResolvedValue([
      record({
        id: "run-snap",
        chainSnapshot: {
          name: "review",
          entry: "archivist",
          timeoutSeconds: 1800,
          retry: { maxAttempts: 2 },
          nodes: {
            archivist: { role: "archivist", agent: "codex", guideline: "archive" },
          },
          edges: [],
        },
        nodes: {
          archivist: {
            transitions: [{ state: { kind: "done" }, at: "2026-09-01T00:00:00.000Z" }],
            sessionId: "sess-a",
            iterations: 1,
            output: "o",
            cost: null,
          },
        },
      }),
    ]);
    const onRerun = vi.fn();

    renderHistory({ onRerun });

    const row = await screen.findByTestId("chain-run-row-run-snap");
    fireEvent.click(within(row).getByRole("button", { name: /actions/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /re-run from archivist/i }));

    expect(onRerun).toHaveBeenCalledWith("run-snap", "archivist");
  });

  it("opens a run on the canvas in Review mode via onOpenRun", async () => {
    apiMock.listChainRuns.mockResolvedValue([record({ id: "run-open" })]);
    const onOpenRun = vi.fn();

    renderHistory({ onOpenRun });

    const row = await screen.findByTestId("chain-run-row-run-open");
    fireEvent.click(within(row).getByRole("button", { name: /open/i }));

    expect(onOpenRun).toHaveBeenCalledWith("run-open");
  });
});

describe("ChainRunHistory — empty and error states", () => {
  it("renders an honest empty state rather than spinning forever", async () => {
    apiMock.listChainRuns.mockResolvedValue([]);

    renderHistory();

    await screen.findByTestId("chain-run-history-empty");
    expect(screen.queryByTestId("chain-run-history-loading")).toBeNull();
  });

  it("surfaces a listChainRuns rejection as an error instead of swallowing it", async () => {
    apiMock.listChainRuns.mockRejectedValue(new Error("disk on fire"));

    renderHistory();

    await waitFor(() => {
      expect(screen.getByTestId("chain-run-history-error").textContent).toMatch(/disk on fire/);
    });
  });
});

/**
 * The side panel is ~150px wide. Reusing the single-line `.ds-chain-row`
 * squeezed the run's date to zero width and let an agent's failure text run
 * 221px down the panel, overlapping itself.
 */
describe("run row layout in a narrow panel", () => {
  it("clamps a long outcome and keeps the full text reachable", async () => {
    const long =
      "Retries exhausted at reviewer after 2 attempts: Claude Agent needs to be signed in — OAuth session expired and could not be refreshed, and this message keeps going well past any sane panel width.";
    apiMock.listChainRuns.mockResolvedValue([
      record({ id: "r1", outcome: { kind: "retriesExhausted", at: "reviewer", attempts: 2, message: long } }),
    ]);

    renderHistory();

    const outcome = await screen.findByText(/Retries exhausted at reviewer/);
    expect(outcome).toHaveAttribute("title", expect.stringContaining("Retries exhausted at reviewer"));
    // Mantine sets its clamp through a CSS variable, not an inline
    // -webkit-line-clamp, so assert on what it actually emits.
    expect(outcome.getAttribute("style") ?? "").toContain("--text-line-clamp");
  });

  it("keeps the run's timestamp on one line", async () => {
    apiMock.listChainRuns.mockResolvedValue([record({ id: "r1" })]);
    renderHistory();
    const stamp = await screen.findByText(/\d{1,2}\/\d{1,2}\/\d{4}/);
    expect(stamp.style.whiteSpace).toBe("nowrap");
  });
});
