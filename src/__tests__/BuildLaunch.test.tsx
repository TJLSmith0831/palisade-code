import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import { BuildLaunch, ExploreHandoff, ProposeHandoff, armBuildLaunch, armExploreHandoff, armProposeHandoff } from "../BuildLaunch";

const row = (target = "Add search clear button") =>
  render(
    <MantineProvider>
      <BuildLaunch target={target} />
    </MantineProvider>
  );

describe("BuildLaunch", () => {
  it("does not play on a row that mounts without a fresh send", () => {
    row();
    expect(screen.getByTestId("build-launch")).not.toHaveAttribute("data-play");
  });

  it("plays once for a row mounted right after a send, and not on a later remount", () => {
    armBuildLaunch("add-search-clear-button");
    const first = row();
    expect(screen.getByTestId("build-launch")).toHaveAttribute("data-play");
    first.unmount();
    // A remount inside the window would replay; it is bounded by time, so
    // move the clock past it.
    const realNow = Date.now;
    Date.now = () => realNow() + 10_000;
    try {
      row();
      expect(screen.getByTestId("build-launch")).not.toHaveAttribute("data-play");
    } finally {
      Date.now = realNow;
    }
  });

  it("does not play on another change's Build row mounted right after a send", () => {
    armBuildLaunch("add-search-clear-button");
    row("Dark mode toggle");
    expect(screen.getByTestId("build-launch")).not.toHaveAttribute("data-play");
  });

  it("plays the Propose row only after a Propose send, and a Build send never arms it", () => {
    armBuildLaunch("");
    const quiet = render(<MantineProvider><ProposeHandoff /></MantineProvider>);
    expect(screen.getByTestId("propose-handoff")).not.toHaveAttribute("data-play");
    quiet.unmount();
    armProposeHandoff();
    render(<MantineProvider><ProposeHandoff /></MantineProvider>);
    expect(screen.getByTestId("propose-handoff")).toHaveAttribute("data-play");
  });

  it("plays the Explore row only after an Explore send, not after a Propose send", () => {
    armProposeHandoff();
    const quiet = render(<MantineProvider><ExploreHandoff target="Feature" /></MantineProvider>);
    expect(screen.getByTestId("explore-handoff")).not.toHaveAttribute("data-play");
    quiet.unmount();
    armExploreHandoff();
    render(<MantineProvider><ExploreHandoff target="Feature" /></MantineProvider>);
    expect(screen.getByTestId("explore-handoff")).toHaveAttribute("data-play");
  });
});
