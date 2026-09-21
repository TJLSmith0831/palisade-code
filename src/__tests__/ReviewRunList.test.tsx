import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ReviewRunList, STATUS_COLOR } from "../ReviewRunList";
import type { ReviewRunListProps } from "../ReviewRunList";
import type { FleetRow } from "../api";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

const row = (over: Partial<FleetRow> = {}): FleetRow => ({
  kind: "thread",
  threadId: "t1",
  title: "Fix the merge gate",
  projectId: "p1",
  projectName: "palisade",
  agentId: "a1",
  agentName: "Agent One",
  mode: "go",
  status: "idle",
  branch: "pal/t1",
  diff: { added: 12, removed: 3, files: 2 },
  filesTouched: ["src/App.tsx"],
  overlap: [],
  verify: { state: "not_run" },
  merge: "clean",
  updatedAt: new Date().toISOString(),
  ...over,
});

const props = (over: Partial<ReviewRunListProps> = {}): ReviewRunListProps => ({
  runs: [row()],
  onSelect: vi.fn(),
  onGoToFleet: vi.fn(),
  ...over,
});

describe("ReviewRunList", () => {
  it("renders a row per run with agent, branch, diff stat and status", () => {
    render(<ReviewRunList {...props()} />);
    expect(screen.getByText("Fix the merge gate")).toBeInTheDocument();
    expect(screen.getByText(/Agent One/)).toBeInTheDocument();
    expect(screen.getByText(/pal\/t1/)).toBeInTheDocument();
    expect(screen.getByTestId("review-run-diff")).toHaveTextContent("+12");
    expect(screen.getByTestId("review-run-diff")).toHaveTextContent("−3");
    expect(screen.getByTestId("review-run-diff")).toHaveTextContent("2 files");
    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it("renders one row per run for multiple runs", () => {
    render(
      <ReviewRunList
        {...props({ runs: [row({ threadId: "t1" }), row({ threadId: "t2", title: "Second run" })] })}
      />,
    );
    expect(screen.getAllByTestId("review-run-row")).toHaveLength(2);
  });

  it("fires onSelect with the clicked run's id", () => {
    const onSelect = vi.fn();
    render(<ReviewRunList {...props({ runs: [row({ threadId: "t1" }), row({ threadId: "t2" })], onSelect })} />);
    fireEvent.click(screen.getAllByTestId("review-run-row")[1]);
    expect(onSelect).toHaveBeenCalledWith("t2");
  });

  it("renders a real empty state with no bare dead-end string, and wires onGoToFleet", () => {
    const onGoToFleet = vi.fn();
    render(<ReviewRunList {...props({ runs: [], onGoToFleet })} />);
    expect(screen.getByTestId("review-run-list-empty")).toBeInTheDocument();
    expect(screen.queryByText("Pick a run on the Fleet board to review it.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Go to Fleet board/i }));
    expect(onGoToFleet).toHaveBeenCalledTimes(1);
  });

  it("maps every status to a color registered in the app's theme (src/main.tsx)", () => {
    const registeredThemeColors = ["success", "danger", "warn", "neutral"];
    for (const color of Object.values(STATUS_COLOR)) {
      expect(registeredThemeColors).toContain(color);
    }
  });
});
