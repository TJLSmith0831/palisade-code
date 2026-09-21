import { describe, expect, it, vi } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import userEvent from "@testing-library/user-event";
import DevServerChips from "../DevServerChips";

const render = (ui: React.ReactNode) => rtlRender(ui, { wrapper: MantineProvider });

const server = (port: number, origin: "terminal" | "agent" = "terminal") => ({
  url: `http://localhost:${port}/`,
  origin,
});

describe("DevServerChips", () => {
  it("renders nothing when no server is running", () => {
    render(<DevServerChips servers={[]} onOpen={() => {}} />);
    expect(screen.queryByTestId("dev-server-chip")).toBeNull();
    expect(screen.queryByTestId("dev-server-more")).toBeNull();
  });

  it("shows one chip per running server, labelled with its host", () => {
    render(<DevServerChips servers={[server(5173), server(4000, "agent")]} onOpen={() => {}} />);
    const chips = screen.getAllByTestId("dev-server-chip");
    expect(chips.map((c) => c.textContent)).toEqual(["localhost:5173", "localhost:4000"]);
    expect(chips.map((c) => c.getAttribute("data-origin"))).toEqual(["terminal", "agent"]);
  });

  it("opens the server it is for in Preview when clicked", async () => {
    const onOpen = vi.fn();
    render(<DevServerChips servers={[server(5173), server(4000)]} onOpen={onOpen} />);
    await userEvent.click(screen.getAllByTestId("dev-server-chip")[1]);
    expect(onOpen).toHaveBeenCalledWith("http://localhost:4000/");
  });

  it("names its action for a screen reader, not just its port", () => {
    render(<DevServerChips servers={[server(5173)]} onOpen={() => {}} />);
    expect(screen.getByRole("button", { name: "Open localhost:5173 in Preview" })).toBeInTheDocument();
  });

  it("collapses a monorepo's worth of servers into a count", () => {
    render(<DevServerChips servers={[server(1), server(2), server(3), server(4), server(5)]} onOpen={() => {}} />);
    expect(screen.getAllByTestId("dev-server-chip")).toHaveLength(3);
    expect(screen.getByTestId("dev-server-more")).toHaveTextContent("+2 more");
  });
});
