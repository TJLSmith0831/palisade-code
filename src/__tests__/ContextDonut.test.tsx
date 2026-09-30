import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ContextDonut } from "../ContextDonut";
import * as api from "../api";
vi.mock("../api", () => ({
  sessionContexts: vi.fn(),
  compactSession: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
const session = (overrides = {}): api.SessionContext => ({
  sessionId: "s",
  threadId: "t",
  mode: "go",
  busy: false,
  canCompact: true,
  status: {
    used: 80000,
    size: 100000,
    updatedAt: null,
    pending: false,
    compaction: null,
    error: null,
  },
  ...overrides,
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.sessionContexts).mockResolvedValue([session()]);
});
const mount = () =>
  render(
    <MantineProvider>
      <ContextDonut threadId="t" mode="go" />
    </MantineProvider>
  );
describe("ContextDonut", () => {
  it("keeps compaction failures inside the popover", async () => {
    vi.mocked(api.compactSession).mockRejectedValueOnce(
      new Error("Agent refused compaction")
    );
    mount();
    fireEvent.click(await screen.findByLabelText("Context usage 80%"));
    fireEvent.click(await screen.findByText("Compact context"));
    expect((await screen.findByText("Error: Agent refused compaction")).closest("[data-context-popover]")).toBeTruthy();
    expect(
      screen.getByText("Compact context").closest("button")
    ).not.toBeDisabled();
  });

  it("explains unsupported compaction without hiding the action", async () => {
    vi.mocked(api.sessionContexts).mockResolvedValue([
      session({ canCompact: false }),
    ]);
    mount();
    fireEvent.focus(await screen.findByLabelText("Context usage 80%"));
    expect(
      await screen.findByText(
        "This agent does not advertise manual compaction."
      )
    ).toBeTruthy();
    expect(
      screen.getByText("Compact context").closest("button")
    ).toBeDisabled();
  });
  it("shows only the targeted session's usage and hover details", async () => {
    vi.mocked(api.sessionContexts).mockResolvedValue([
      session(),
      session({ sessionId: "other", mode: "spec" }),
    ]);
    mount();
    const donut = await screen.findByLabelText("Context usage 80%");
    expect(screen.queryByText("80% context used")).toBeNull();
    fireEvent.mouseEnter(donut);
    expect(await screen.findByText(/20,000 remaining/)).toBeTruthy();
    expect(
      screen.getByText("Auto-compaction threshold not reported")
    ).toBeTruthy();
  });
  it("keeps the manual action inside the popup and targets the live session", async () => {
    mount();
    fireEvent.click(await screen.findByLabelText("Context usage 80%"));
    fireEvent.click(await screen.findByText("Compact context"));
    await waitFor(() => expect(api.compactSession).toHaveBeenCalledWith("s"));
  });
  it("explains disabled compaction when busy", async () => {
    vi.mocked(api.sessionContexts).mockResolvedValue([session({ busy: true })]);
    mount();
    fireEvent.focus(await screen.findByLabelText("Context usage 80%"));
    expect(
      await screen.findByText("Wait for the current turn to finish.")
    ).toBeTruthy();
    expect(
      screen.getByText("Compact context").closest("button")?.disabled
    ).toBe(true);
  });
  it("shows unknown usage without inventing zero and closes on Escape", async () => {
    vi.mocked(api.sessionContexts).mockResolvedValue([]);
    mount();
    const donut = screen.getByLabelText("Context usage unavailable");
    fireEvent.focus(donut);
    expect(
      await screen.findByText("Start a conversation to compact context.")
    ).toBeTruthy();
    fireEvent.keyDown(donut, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByText("Compact context")).toBeNull()
    );
  });
});
