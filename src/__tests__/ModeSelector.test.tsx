import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { ModeSelector } from "../ModeSelector";

describe("ModeSelector", () => {
  it("keeps both modes named and keyboard-selectable when labels collapse", () => {
    const onChange = vi.fn();
    render(
      <MantineProvider>
        <ModeSelector
          value="spec"
          onChange={onChange}
          testId="mode"
          ariaLabel="Run mode"
        />
      </MantineProvider>
    );
    expect(screen.getByRole("radio", { name: "Spec" })).toBeChecked();
    const go = screen.getByRole("radio", { name: "Go" });
    expect(
      screen.getByTestId("mode").querySelectorAll("svg[aria-hidden='true']")
    ).toHaveLength(2);
    fireEvent.click(go);
    expect(onChange).toHaveBeenCalledWith("go");
  });

  it("moves between modes with the arrow key", async () => {
    const onChange = vi.fn();
    render(
      <MantineProvider>
        <ModeSelector value="spec" onChange={onChange} testId="mode" ariaLabel="Task mode" />
      </MantineProvider>
    );
    screen.getByRole("radio", { name: "Spec" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenCalledWith("go");
  });
});
