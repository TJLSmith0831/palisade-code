import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import FirstRunChecklist, { firstRunReason } from "../FirstRunChecklist";
import type { Preflight } from "../api";

const flight = (over: Partial<Preflight> = {}): Preflight => ({
  agents: [],
  selected: null,
  openspec: true,
  ready: false,
  warnings: ["No ACP agents found on PATH — chat-only mode, /go unavailable."],
  checkedAt: "2026-09-22T00:00:00Z",
  ...over,
});

const renderIt = (f: Preflight, onRecheck = vi.fn(), checking = false) => {
  render(
    <MantineProvider>
      <FirstRunChecklist flight={f} onRecheck={onRecheck} checking={checking} />
    </MantineProvider>
  );
  return onRecheck;
};

describe("firstRunReason", () => {
  it("tells an unreachable registry apart from an empty PATH", () => {
    expect(firstRunReason(flight())).toBe("none-on-path");
    expect(
      firstRunReason(
        flight({
          warnings: [
            "The ACP registry could not be reached and no cached copy exists — chat-only mode, /go unavailable until it is.",
          ],
        })
      )
    ).toBe("registry-unreachable");
  });
});

describe("FirstRunChecklist", () => {
  it("walks a new user through install, sign-in and first prompt", () => {
    renderIt(flight());
    const list = screen.getByTestId("first-run-checklist");
    expect(list).toHaveTextContent(/install/i);
    expect(list).toHaveTextContent(/sign in/i);
    expect(list).toHaveTextContent(/first prompt/i);
    // Points at the registry, not at any one agent by name.
    expect(screen.getByRole("link", { name: /registry/i })).toHaveAttribute(
      "href",
      expect.stringContaining("agentclientprotocol.com")
    );
  });

  it("says the registry was unreachable when that is the reason", () => {
    renderIt(
      flight({
        warnings: [
          "The ACP registry could not be reached and no cached copy exists — chat-only mode, /go unavailable until it is.",
        ],
      })
    );
    expect(screen.getByTestId("first-run-reason")).toHaveTextContent(/registry/i);
    expect(screen.getByTestId("first-run-reason")).toHaveTextContent(/network/i);
  });

  it("re-runs preflight from its own button", () => {
    const onRecheck = renderIt(flight());
    fireEvent.click(screen.getByRole("button", { name: /check again/i }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("still surfaces the other preflight warnings", () => {
    renderIt(flight({ openspec: false, warnings: [
      "No ACP agents found on PATH — chat-only mode, /go unavailable.",
      "`openspec` not on PATH — change-linked /go will not work.",
    ] }));
    expect(screen.getByText(/openspec/)).toBeInTheDocument();
  });
});
