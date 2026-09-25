import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import SpecChangeTab from "../SpecChangeTab";

const proposalMd = "## Why\n\nThis is a proposal.";
const designMd = "## Context\n\nDesign decisions here.";
const tasksMd =
  "## 1. Spikes\n\n- [x] 1.1 First task\n- [ ] 1.2 Second task\n\n## 2. Implementation\n\n- [ ] 2.1 Do the thing\n";

const deltasPayload = {
  id: "vibe-spec-tabs",
  title: "vibe-spec-tabs",
  deltaCount: 2,
  deltas: [
    {
      spec: "vibe-spec-tabs",
      operation: "ADDED",
      description: "Add requirement: The system SHALL render a Specs section.",
      requirement: {
        text: "The system SHALL render a Specs section.",
        scenarios: [
          {
            rawText:
              "- WHEN the Vibe shell renders\n- THEN the sidebar has a Specs section",
          },
        ],
      },
    },
  ],
};

const twoDeltasPayload = {
  id: "vibe-spec-tabs",
  title: "vibe-spec-tabs",
  deltaCount: 2,
  deltas: [
    deltasPayload.deltas[0],
    {
      spec: "another-spec",
      operation: "MODIFIED",
      description: "Modify requirement: another requirement.",
      requirement: {
        text: "The system SHALL modify another thing.",
        scenarios: [
          {
            rawText: "- WHEN something\n- THEN it works",
          },
        ],
      },
    },
  ],
};

const verifyRun = {
  id: "v1",
  projectHash: "proj-1",
  threadId: null,
  sessionId: null,
  name: "test",
  command: "pnpm test",
  exitCode: 0,
  outputTail: "all passed",
  gitHead: "abc1234",
  at: "2026-08-09T00:00:00Z",
};

function setupMocks(overrides: { showSpecChange?: unknown } = {}) {
  const showValue = overrides.hasOwnProperty("showSpecChange")
    ? overrides.showSpecChange
    : deltasPayload;
  invokeMock.mockImplementation(
    (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "read_file_content") {
        const path = args.relativePath as string;
        if (path.endsWith("proposal.md")) return Promise.resolve(proposalMd);
        if (path.endsWith("design.md")) return Promise.resolve(designMd);
        if (path.endsWith("tasks.md")) return Promise.resolve(tasksMd);
        if (path.endsWith("/spec.md")) {
          const spec = path.split("/").slice(-2, -1)[0] ?? "unknown";
          return Promise.resolve(
            `## Source spec for ${spec}\n\nFull spec content.`
          );
        }
        return Promise.reject(new Error("file not found"));
      }
      if (cmd === "show_spec_change") {
        return Promise.resolve(showValue);
      }
      if (cmd === "verify_commands") {
        return Promise.resolve([
          ["test", "pnpm test"],
          ["typecheck", "tsc --noEmit"],
        ]);
      }
      if (cmd === "list_verifications") {
        return Promise.resolve([verifyRun]);
      }
      if (cmd === "run_verify") return Promise.resolve();
      return Promise.resolve([]);
    }
  );
}

const renderTab = (
  props: Partial<React.ComponentProps<typeof SpecChangeTab>> = {}
) =>
  render(
    <MantineProvider>
      <SpecChangeTab
        projectHash="proj-1"
        specName="vibe-spec-tabs"
        {...props}
      />
    </MantineProvider>
  );

describe("SpecChangeTab", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockClear();
    setupMocks();
  });

  it("reads artifacts and deltas from the owning thread's tree", async () => {
    renderTab({ threadId: "t-1" });
    await waitFor(() => {
      const calls = invokeMock.mock.calls;
      const read = calls.find(([c]) => c === "read_file_content");
      const show = calls.find(([c]) => c === "show_spec_change");
      expect(read?.[1]).toMatchObject({ threadId: "t-1" });
      expect(show?.[1]).toMatchObject({ threadId: "t-1" });
    });
  });

  it("re-reads artifacts when an agent writes into this change", async () => {
    renderTab();
    const reads = () => invokeMock.mock.calls.filter(([c]) => c === "read_file_content").length;
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    const before = reads();
    const handler = (listenMock.mock.calls as unknown as [string, (e: unknown) => void][])
      .find(([name]) => name === "fs-changed")![1];
    handler({ payload: { projectHash: "proj-1", paths: ["openspec/changes/other/tasks.md"] } });
    handler({ payload: { projectHash: "proj-1", paths: ["openspec/changes/vibe-spec-tabs/tasks.md"] } });
    await waitFor(() => expect(reads()).toBe(before * 2));
  });

  it("refreshes while the owning thread's tools finish, since a build writes outside the watched root", async () => {
    renderTab({ threadId: "t-1" });
    const reads = () => invokeMock.mock.calls.filter(([c]) => c === "read_file_content").length;
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    const before = reads();
    const handler = (listenMock.mock.calls as unknown as [string, (e: unknown) => void][])
      .find(([name]) => name === "executor-event")![1];
    handler({ payload: { threadId: "other", event: { kind: "toolResult" } } });
    handler({ payload: { threadId: "t-1", event: { kind: "text" } } });
    handler({ payload: { threadId: "t-1", event: { kind: "toolResult" } } });
    await waitFor(() => expect(reads()).toBe(before * 2), { timeout: 3000 });
  });

  it("refreshes when the owning thread's turn ends, which is when a spec revision is synced in", async () => {
    renderTab({ threadId: "t-1" });
    const reads = () => invokeMock.mock.calls.filter(([c]) => c === "read_file_content").length;
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    const before = reads();
    const handler = (listenMock.mock.calls as unknown as [string, (e: unknown) => void][])
      .find(([name]) => name === "executor-event")![1];
    handler({ payload: { threadId: "t-1", event: { kind: "done" } } });
    await waitFor(() => expect(reads()).toBe(before * 2), { timeout: 3000 });
  });

  it("renders inner tabs for Proposal, Design, Spec, Tasks, and Verify", () => {
    renderTab();
    const tabs = screen.getAllByTestId("spec-inner-tab");
    expect(
      tabs.map((t) => t.querySelector(".ds-spec-phase-label")?.textContent)
    ).toEqual([
      "Proposal",
      "Design",
      "Spec",
      "Tasks",
      "Verify",
    ]);
  });

  it("reports each phase truthfully: written, ticked count, and verify result", async () => {
    renderTab();
    const state = (label: string) =>
      screen
        .getAllByTestId("spec-inner-tab")
        .find((t) => t.querySelector(".ds-spec-phase-label")?.textContent === label)!;
    await waitFor(() => {
      expect(state("Proposal").dataset.state).toBe("written");
      expect(state("Design").dataset.state).toBe("written");
      expect(state("Tasks").dataset.state).toBe("reported");
      expect(state("Verify").dataset.state).toBe("passed");
    });
    // Counts are the agent's checkboxes; the verify detail names the commit.
    expect(state("Tasks").textContent).toContain("1/3 ticked");
    expect(state("Verify").textContent).toContain("passed · abc1234");
    // Nothing in the row may claim completion on a self-report.
    expect(state("Tasks").textContent).not.toMatch(/done|complete/i);
  });

  it("renders the proposal as a document, not framed source", async () => {
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("This is a proposal.")).toBeInTheDocument();
    });
    // `.ds-prose` carries the document styling; `## Why` is a real heading.
    expect(screen.getByRole("heading", { name: "Why" }).closest(".ds-prose")).not.toBeNull();
  });

  it("switches to the Design tab and shows design markdown", async () => {
    renderTab();
    await waitFor(() => {
      expect(screen.getByText("This is a proposal.")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Design"));
    await waitFor(() => {
      expect(screen.getByText("Design decisions here.")).toBeInTheDocument();
    });
  });

  it("shows parsed task checkboxes with the agent-reported disclaimer", async () => {
    renderTab();
    fireEvent.click(screen.getByText("Tasks"));
    await waitFor(() => {
      expect(screen.getAllByText(/1.1 First task/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/1.2 Second task/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/2.1 Do the thing/).length).toBeGreaterThan(0);
    });
    // The disclaimer must be present.
    expect(screen.getByText(/agent's self-report/)).toBeInTheDocument();
  });

  it("does not show a Run verify button when no pins are configured", async () => {
    renderTab();
    fireEvent.click(screen.getByText("Tasks"));
    await waitFor(() => {
      expect(screen.getAllByText(/1.1 First task/).length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByTestId("spec-tasks-run-verify")
    ).not.toBeInTheDocument();
  });

  it("shows a Run verify button when verifyPins includes a configured command", async () => {
    renderTab({ verifyPins: ["test"] });
    fireEvent.click(screen.getByText("Tasks"));
    await waitFor(() => {
      expect(screen.getAllByText(/1.1 First task/).length).toBeGreaterThan(0);
    });
    const btn = screen.getByTestId("spec-tasks-run-verify");
    expect(btn.textContent).toContain("test");
  });

  it("invokes runVerify when the Tasks Run verify button is clicked", async () => {
    renderTab({ verifyPins: ["test"] });
    fireEvent.click(screen.getByText("Tasks"));
    await waitFor(() => {
      expect(screen.getByTestId("spec-tasks-run-verify")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("spec-tasks-run-verify"));
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.find(
          (c) =>
            c[0] === "run_verify" &&
            (c[1] as Record<string, unknown>).name === "test"
        )
      ).toBeTruthy();
    });
  });

  it("shows verify commands and latest runs on the Verify tab", async () => {
    renderTab();
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() => {
      expect(screen.getByTestId("spec-verify-run-test")).toBeInTheDocument();
      expect(
        screen.getByTestId("spec-verify-run-typecheck")
      ).toBeInTheDocument();
    });
    // Latest run shows exit code
    expect(screen.getByText("exit 0")).toBeInTheDocument();
  });

  it("shows Pin button for unpinned commands and Unpin for pinned", async () => {
    renderTab({
      verifyPins: ["test"],
      onAddPin: vi.fn(),
      onRemovePin: vi.fn(),
    });
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() => {
      expect(screen.getByTestId("spec-verify-run-test")).toBeInTheDocument();
    });
    // "test" is pinned -> Unpin
    expect(screen.getByTestId("spec-verify-unpin-test")).toBeInTheDocument();
    // "typecheck" is not pinned -> Pin
    expect(screen.getByTestId("spec-verify-pin-typecheck")).toBeInTheDocument();
  });

  it("calls onAddPin when Pin is clicked", async () => {
    const onAddPin = vi.fn();
    renderTab({ onAddPin });
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() => {
      expect(screen.getByTestId("spec-verify-pin-test")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("spec-verify-pin-test"));
    expect(onAddPin).toHaveBeenCalledWith("test");
  });

  it("calls onRemovePin when Unpin is clicked", async () => {
    const onRemovePin = vi.fn();
    renderTab({ verifyPins: ["test"], onRemovePin });
    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() => {
      expect(screen.getByTestId("spec-verify-unpin-test")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("spec-verify-unpin-test"));
    expect(onRemovePin).toHaveBeenCalledWith("test");
  });

  it("shows structured spec requirements on the Spec tab", async () => {
    renderTab();
    fireEvent.click(screen.getByText("Spec"));
    await waitFor(() => {
      expect(
        screen.getByText("The system SHALL render a Specs section.")
      ).toBeInTheDocument();
    });
    // Scenario Markdown renders as a list, not literal `- WHEN` source.
    expect(screen.getByText("WHEN the Vibe shell renders").tagName).toBe("LI");
  });

  it("expands a delta and shows its source spec markdown on title click", async () => {
    renderTab();
    fireEvent.click(screen.getByText("Spec"));
    await waitFor(() => {
      expect(
        screen.getByText("The system SHALL render a Specs section.")
      ).toBeInTheDocument();
    });
    const titles = screen.getAllByTestId("spec-delta-title");
    fireEvent.click(titles[0]);
    await waitFor(() => {
      expect(
        screen.getByText(/Source spec for vibe-spec-tabs/)
      ).toBeInTheDocument();
    });
  });

  it("collapses an expanded delta when the same title is clicked again", async () => {
    renderTab();
    fireEvent.click(screen.getByText("Spec"));
    await waitFor(() => {
      expect(screen.getAllByTestId("spec-delta-title").length).toBeGreaterThan(
        0
      );
    });
    const titles = screen.getAllByTestId("spec-delta-title");
    fireEvent.click(titles[0]);
    await waitFor(() => {
      expect(
        screen.getByText(/Source spec for vibe-spec-tabs/)
      ).toBeInTheDocument();
    });
    fireEvent.click(titles[0]);
    await waitFor(() => {
      expect(
        screen.queryByText(/Source spec for vibe-spec-tabs/)
      ).not.toBeInTheDocument();
    });
  });

  it("only expands one delta at a time", async () => {
    setupMocks({ showSpecChange: twoDeltasPayload });
    renderTab();
    fireEvent.click(screen.getByText("Spec"));
    await waitFor(() => {
      expect(screen.getAllByTestId("spec-delta-title").length).toBe(2);
    });
    const titles = screen.getAllByTestId("spec-delta-title");
    fireEvent.click(titles[0]);
    await waitFor(() => {
      expect(
        screen.getByText(/Source spec for vibe-spec-tabs/)
      ).toBeInTheDocument();
    });
    fireEvent.click(titles[1]);
    await waitFor(() => {
      expect(
        screen.queryByText(/Source spec for vibe-spec-tabs/)
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/Source spec for another-spec/)
      ).toBeInTheDocument();
    });
  });

  it("locks the Spec tab until the change has spec deltas", async () => {
    setupMocks({ showSpecChange: null });
    renderTab();
    const tab = screen.getByRole("tab", { name: /Spec/ });
    await waitFor(() => expect(tab).toBeDisabled());
    expect(screen.getByRole("tab", { name: /Proposal/ })).not.toBeDisabled();
  });
});
