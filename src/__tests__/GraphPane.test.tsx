import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@uiw/react-md-editor", () => {
  const MDEditor = ({ value }: { value: string }) => <div data-testid="md-editor">{value}</div>;
  MDEditor.Markdown = ({ source }: { source: string }) => <div>{source}</div>;
  return { default: MDEditor };
});

vi.mock("../GraphView", () => ({
  default: () => <div data-testid="graph-view" />,
}));

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import GraphPane from "../GraphPane";

describe("GraphPane", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("automatically compiles a codebase map when a project has no prior run", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_graphify") return Promise.reject(new Error("no graph.json on disk"));
      if (cmd === "run_graphify") {
        return Promise.resolve({
          outDir: "/tmp/proj/graphify-out",
          report: "# Report",
          graph: { nodes: [{ id: "a" }], links: [] },
          summary: "compiled",
        });
      }
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    render(<GraphPane projectHash="proj-1" />);

    await waitFor(() => expect(screen.getByTestId("graph-view")).toBeDefined());

    expect(screen.queryByTestId("graph-error")).toBeNull();
    const runCall = invokeMock.mock.calls.find(([cmd]) => cmd === "run_graphify");
    expect(runCall?.[1]).toMatchObject({ projectHash: "proj-1" });
  });

  it("shows the existing run without re-compiling when one is already on disk", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "load_graphify") {
        return Promise.resolve({
          outDir: "/tmp/proj/graphify-out",
          report: "# Report",
          graph: { nodes: [{ id: "a" }], links: [] },
          summary: "prior run",
        });
      }
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    render(<GraphPane projectHash="proj-1" />);

    await waitFor(() => expect(screen.getByTestId("graph-view")).toBeDefined());
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "run_graphify")).toBe(false);
  });
});
