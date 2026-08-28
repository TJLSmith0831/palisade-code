import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import ChainCanvas from "../ChainCanvas";

vi.mock("../ChainsPanel", () => ({ announceChainsChanged: vi.fn() }));

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listChains: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue({ models: [] }),
    saveChain: vi.fn().mockResolvedValue(undefined),
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
