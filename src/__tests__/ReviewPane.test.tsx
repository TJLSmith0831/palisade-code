import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import ReviewPane from "../ReviewPane";
import type { ReviewFile } from "../ReviewPane";
import type { FleetMerge, FleetVerify } from "../api";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

const files: ReviewFile[] = [
  { path: "src/a.ts", added: 3, removed: 1, status: "modified" },
  { path: "src/b.ts", added: 9, removed: 0, status: "added" },
  { path: "src/c.ts", added: 0, removed: 4, status: "deleted" },
];

const pass: FleetVerify = {
  state: "pass",
  command: "pnpm test",
  commit: "cafe1234deadbeef",
  at: new Date(Date.now() - 5 * 60_000).toISOString(),
};

const onMerge = vi.fn();
const onRunVerify = vi.fn();
const onOpenPr = vi.fn();
const onOpenInEditor = vi.fn();

const mount = (over: Partial<Parameters<typeof ReviewPane>[0]> = {}) =>
  render(
    <ReviewPane
      threadId="t1"
      branch="palisade/abcd"
      baseBranch="main"
      files={files}
      loadingFiles={false}
      verify={pass}
      merge={"clean" as FleetMerge}
      renderDiff={(path, mode) => <div data-testid="diff">{`${path}:${mode}`}</div>}
      onRunVerify={onRunVerify}
      onMerge={onMerge}
      onOpenPr={onOpenPr}
      onOpenInEditor={onOpenInEditor}
      {...over}
    />,
  );

const mergeButton = () => screen.getByRole("button", { name: "Merge" });

describe("ReviewPane", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("shows k of n viewed and persists a toggle", () => {
    mount();
    expect(screen.getByTestId("review-viewed-count")).toHaveTextContent("0 of 3 viewed");
    fireEvent.click(screen.getByLabelText("Viewed src/b.ts"));
    expect(screen.getByTestId("review-viewed-count")).toHaveTextContent("1 of 3 viewed");
    expect(localStorage.getItem("palisade.review.t1")).toContain("src/b.ts");
  });

  it("restores viewed files from storage on mount", () => {
    localStorage.setItem("palisade.review.t1", JSON.stringify(["src/a.ts", "src/c.ts"]));
    mount();
    expect(screen.getByTestId("review-viewed-count")).toHaveTextContent("2 of 3 viewed");
  });

  it("writes the verify strip copy for each state", () => {
    const { unmount } = mount();
    expect(screen.getByTestId("review-verify-line")).toHaveTextContent(
      "Verified: pnpm test exited 0 at cafe123 · 5m ago",
    );
    expect(screen.queryByRole("button", { name: "Run verify" })).toBeNull();
    unmount();

    const fail = mount({
      verify: { state: "fail", command: "pnpm test", commit: "cafe1234deadbeef" },
    });
    expect(screen.getByTestId("review-verify-line")).toHaveTextContent(
      "Verify failed: pnpm test at cafe123",
    );
    fireEvent.click(screen.getByRole("button", { name: "Run verify" }));
    expect(onRunVerify).toHaveBeenCalled();
    fail.unmount();

    mount({ verify: { state: "not_run" } });
    expect(screen.getByTestId("review-verify-line")).toHaveTextContent("Not verified");
    expect(screen.getByRole("button", { name: "Run verify" })).toBeInTheDocument();
  });

  it("enables Merge only on a clean merge with a passing verify", () => {
    const clean = mount();
    expect(mergeButton()).toBeEnabled();
    fireEvent.click(mergeButton());
    expect(onMerge).toHaveBeenCalledWith({ override: false });
    clean.unmount();

    const conflicted = mount({ merge: "conflicts" });
    expect(mergeButton()).toBeDisabled();
    conflicted.unmount();

    mount({ verify: { state: "not_run" } });
    expect(mergeButton()).toBeDisabled();
  });

  it("names what is missing in the override modal and merges with override", async () => {
    mount({ merge: "conflicts", verify: { state: "not_run" } });
    fireEvent.click(screen.getByRole("button", { name: "Merge anyway…" }));
    expect(
      await screen.findByText("This branch conflicts with its base branch."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No verification has been run on this branch."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Merge anyway" }));
    expect(onMerge).toHaveBeenCalledWith({ override: true });
  });

  it("moves the selection with j/k and clamps at both ends", () => {
    mount();
    expect(screen.getByTestId("diff")).toHaveTextContent("src/a.ts:inline");
    fireEvent.keyDown(window, { key: "k" });
    expect(screen.getByTestId("diff")).toHaveTextContent("src/a.ts:inline");
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getByTestId("diff")).toHaveTextContent("src/c.ts:inline");
    fireEvent.keyDown(window, { key: "k" });
    expect(screen.getByTestId("diff")).toHaveTextContent("src/b.ts:inline");
  });

  it("toggles Viewed with v and opens the editor with o", () => {
    mount();
    fireEvent.keyDown(window, { key: "v" });
    expect(screen.getByTestId("review-viewed-count")).toHaveTextContent("1 of 3 viewed");
    fireEvent.keyDown(window, { key: "v" });
    expect(screen.getByTestId("review-viewed-count")).toHaveTextContent("0 of 3 viewed");
    fireEvent.keyDown(window, { key: "o" });
    expect(onOpenInEditor).toHaveBeenCalledWith("src/a.ts");
  });

  it("persists the diff mode choice", () => {
    const first = mount();
    fireEvent.click(screen.getByText("Side by side"));
    expect(screen.getByTestId("diff")).toHaveTextContent("src/a.ts:side-by-side");
    expect(localStorage.getItem("palisade.review.diffMode")).toBe("side-by-side");
    first.unmount();
    mount();
    expect(screen.getByTestId("diff")).toHaveTextContent("src/a.ts:side-by-side");
  });

  it("shows a loading state and Open PR", () => {
    mount({ files: [], loadingFiles: true });
    expect(screen.getByText("Loading files…")).toBeInTheDocument();
    expect(screen.queryByTestId("diff")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Open PR/ }));
    expect(onOpenPr).toHaveBeenCalled();
  });
});
