import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { SpecProgress } from "../SpecProgress";
import type { SpecStage } from "../stage";

const show = (
  stage: SpecStage,
  options: { busy?: boolean; canApply?: boolean } = {}
) => {
  const onApply = vi.fn();
  render(
    <MantineProvider>
      <SpecProgress
        stage={stage}
        busy={options.busy ?? false}
        canApply={options.canApply ?? true}
        onApply={onApply}
      />
    </MantineProvider>
  );
  return onApply;
};

describe("SpecProgress", () => {
  it.each([
    ["exploring", "Exploring"],
    ["proposing", "Proposing"],
    ["ready_to_apply", "Ready to apply"],
    ["implementing", "Implementing"],
  ] as const)("marks %s as the current step", (stage, label) => {
    show(stage);
    expect(
      screen.getByTestId("spec-progress").querySelector('[aria-current="step"]')
    ).toHaveTextContent(label);
    expect(screen.getByRole("status")).toHaveTextContent(
      `Spec progress: ${label}`
    );
  });

  it("offers Apply once when ready", () => {
    const onApply = show("ready_to_apply");
    fireEvent.click(screen.getByRole("button", { name: "Apply proposal" }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("keeps Apply visible but disabled while the agent is busy", () => {
    show("ready_to_apply", { busy: true });
    expect(
      screen.getByRole("button", { name: "Apply proposal" })
    ).toBeDisabled();
  });

  it("hides Apply before readiness and after implementation starts", () => {
    show("proposing");
    expect(screen.queryByRole("button", { name: "Apply proposal" })).toBeNull();
  });

  it("does not show a Spec flow for direct chat", () => {
    show("chat");
    expect(screen.queryByTestId("spec-progress")).toBeNull();
  });
});
