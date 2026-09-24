import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it } from "vitest";
import { BuildLaunch, armBuildLaunch } from "../BuildLaunch";

const row = () =>
  render(
    <MantineProvider>
      <BuildLaunch target="Add search clear button" />
    </MantineProvider>
  );

describe("BuildLaunch", () => {
  it("does not play on a row that mounts without a fresh send", () => {
    row();
    expect(screen.getByTestId("build-launch")).not.toHaveAttribute("data-play");
  });

  it("plays once for a row mounted right after a send, and not on a later remount", () => {
    armBuildLaunch();
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
});
