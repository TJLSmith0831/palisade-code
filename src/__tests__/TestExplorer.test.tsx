import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import TestExplorer from "../TestExplorer";
import type { TestCase, TestReport, VerificationRun } from "../api";

const render = (ui: React.ReactNode) => rtlRender(ui, { wrapper: MantineProvider });

const testCase = (over: Partial<TestCase> = {}): TestCase => ({
  name: "tests::passes",
  status: "passed",
  file: "src/lib.rs",
  line: null,
  message: null,
  ...over,
});

const report = (over: Partial<TestReport> = {}): TestReport => ({
  framework: "cargo",
  cases: [],
  parsed: true,
  unexplainedFailure: false,
  ...over,
});

const run = (over: Partial<VerificationRun> = {}): VerificationRun => ({
  id: "v1",
  projectHash: "p",
  threadId: null,
  sessionId: null,
  name: "test",
  command: "cargo test",
  exitCode: 0,
  outputTail: "running 1 test",
  gitHead: "abcdef1234567890",
  at: "2026-08-26T10:00:00Z",
  tests: report(),
  ...over,
});

const mixed = report({
  cases: [
    testCase({ name: "tests::passes", status: "passed" }),
    testCase({ name: "tests::fails", status: "failed", line: 9, message: "left != right" }),
    testCase({ name: "tests::ignored", status: "skipped" }),
    testCase({ name: "tests::boom", status: "errored", line: 14, message: "index out of bounds" }),
  ],
});

const withRuns = (runs: VerificationRun[]) =>
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "verify_commands") return Promise.resolve([["test", "cargo test"]]);
    if (cmd === "list_verifications") return Promise.resolve(runs);
    if (cmd === "run_verify") return Promise.resolve();
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockClear();
});

describe("TestExplorer", () => {
  it("lists every test from the latest run with its own verdict", async () => {
    withRuns([run({ exitCode: 101, tests: mixed })]);
    render(<TestExplorer projectHash="p" />);

    await waitFor(() => expect(screen.getAllByTestId(/^test-case-/)).toHaveLength(4));
    expect(screen.getByTestId("test-case-tests::passes")).toHaveAttribute(
      "data-status",
      "passed",
    );
    expect(screen.getByTestId("test-case-tests::fails")).toHaveAttribute("data-status", "failed");
    expect(screen.getByTestId("test-case-tests::ignored")).toHaveAttribute(
      "data-status",
      "skipped",
    );
    expect(screen.getByTestId("test-case-tests::boom")).toHaveAttribute("data-status", "errored");
  });

  it("counts pass/fail without ever claiming the project is verified", async () => {
    withRuns([run({ exitCode: 101, tests: mixed })]);
    render(<TestExplorer projectHash="p" />);
    await waitFor(() => expect(screen.getByTestId("test-summary")).toBeDefined());

    const summary = screen.getByTestId("test-summary").textContent ?? "";
    expect(summary).toContain("1 passed");
    expect(summary).toContain("2 failed");

    // Counting tests is not evidence a spec is done (D3).
    const body = (document.body.textContent ?? "").toLowerCase();
    for (const word of ["complete", "satisfied", "implemented", "all green"]) {
      expect(body).not.toContain(word);
    }
  });

  it("shows a failure's message so the reason is not hidden behind a click", async () => {
    withRuns([run({ exitCode: 101, tests: mixed })]);
    render(<TestExplorer projectHash="p" />);
    await waitFor(() => expect(screen.getByText(/left != right/)).toBeDefined());
    expect(screen.getByText(/index out of bounds/)).toBeDefined();
  });

  it("opens the failing line when a located failure is clicked", async () => {
    const onOpen = vi.fn();
    withRuns([run({ exitCode: 101, tests: mixed })]);
    render(<TestExplorer projectHash="p" onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByTestId("test-case-tests::fails")).toBeDefined());

    fireEvent.click(screen.getByTestId("test-case-tests::fails"));
    expect(onOpen).toHaveBeenCalledWith("src/lib.rs", 9);
  });

  it("falls back to the raw log when no runner was recognised", async () => {
    withRuns([
      run({
        exitCode: 139,
        outputTail: "Segmentation fault: 11",
        tests: report({ framework: "none", parsed: false, unexplainedFailure: true }),
      }),
    ]);
    render(<TestExplorer projectHash="p" />);

    // An empty explorer under a red exit code would read as "nothing failed".
    await waitFor(() => expect(screen.getByTestId("test-unparsed")).toBeDefined());
    expect(screen.getByText(/Segmentation fault/)).toBeDefined();
    expect(screen.queryAllByTestId(/^test-case-/)).toHaveLength(0);
  });

  it("flags a non-zero exit that no individual test explains", async () => {
    withRuns([
      run({
        exitCode: 101,
        tests: report({
          cases: [testCase({ status: "passed" })],
          unexplainedFailure: true,
        }),
      }),
    ]);
    render(<TestExplorer projectHash="p" />);
    await waitFor(() => expect(screen.getByTestId("test-unexplained")).toBeDefined());
    expect(screen.getByTestId("test-unexplained").textContent).toMatch(/exit(ed)? 101/i);
  });

  it("keeps the runner's order rather than sorting failures to the top", async () => {
    withRuns([run({ exitCode: 101, tests: mixed })]);
    render(<TestExplorer projectHash="p" />);
    await waitFor(() => expect(screen.getAllByTestId(/^test-case-/)).toHaveLength(4));
    expect(
      screen.getAllByTestId(/^test-case-/).map((el) => el.getAttribute("data-status")),
    ).toEqual(["passed", "failed", "skipped", "errored"]);
  });

  it("marks results stale once a file has been saved since the run", async () => {
    withRuns([run({ exitCode: 101, tests: mixed, at: "2026-08-26T10:00:00Z" })]);
    const { rerender } = render(<TestExplorer projectHash="p" lastEditAt={null} />);
    await waitFor(() => expect(screen.getAllByTestId(/^test-case-/)).toHaveLength(4));
    expect(screen.queryByTestId("test-stale")).toBeNull();

    rerender(<TestExplorer projectHash="p" lastEditAt={Date.parse("2026-08-26T10:05:00Z")} />);
    await waitFor(() => expect(screen.getByTestId("test-stale")).toBeDefined());
    // Stale results are still shown — hiding them loses the last thing known.
    expect(screen.getAllByTestId(/^test-case-/)).toHaveLength(4);
  });

  it("an edit before the run does not make its results stale", async () => {
    withRuns([run({ exitCode: 0, tests: mixed, at: "2026-08-26T10:00:00Z" })]);
    render(<TestExplorer projectHash="p" lastEditAt={Date.parse("2026-08-26T09:00:00Z")} />);
    await waitFor(() => expect(screen.getAllByTestId(/^test-case-/)).toHaveLength(4));
    expect(screen.queryByTestId("test-stale")).toBeNull();
  });

  it("picks the newest run of the selected command, not the newest of any", async () => {
    withRuns([
      run({ id: "v1", name: "test", at: "2026-08-26T10:00:00Z", tests: mixed }),
      run({
        id: "v2",
        name: "typecheck",
        at: "2026-08-26T11:00:00Z",
        tests: report({ cases: [testCase({ name: "tsc", status: "passed" })] }),
      }),
      run({
        id: "v3",
        name: "test",
        at: "2026-08-26T12:00:00Z",
        tests: report({ cases: [testCase({ name: "only-one", status: "passed" })] }),
      }),
    ]);
    render(<TestExplorer projectHash="p" />);
    await waitFor(() => expect(screen.getByTestId("test-case-only-one")).toBeDefined());
    expect(screen.queryByTestId("test-case-tsc")).toBeNull();
  });

  it("says there is nothing to show before anything has been run", async () => {
    withRuns([]);
    render(<TestExplorer projectHash="p" />);
    await waitFor(() => expect(screen.getByTestId("test-empty")).toBeDefined());
  });

  it("runs the command and takes the result off the event", async () => {
    withRuns([]);
    render(<TestExplorer projectHash="p" />);
    await waitFor(() => expect(screen.getByTestId("test-run-test")).toBeDefined());
    fireEvent.click(screen.getByTestId("test-run-test"));

    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === "run_verify");
      expect(call?.[1]).toMatchObject({ projectHash: "p", name: "test" });
    });

    const handler = listenMock.mock.calls.find(
      ([event]) => event === "verification-finished",
    )?.[1] as unknown as (e: { payload: unknown }) => void;
    handler({ payload: run({ id: "v9", exitCode: 101, tests: mixed }) });

    await waitFor(() => expect(screen.getAllByTestId(/^test-case-/)).toHaveLength(4));
  });

  it("reports a run that could not start rather than showing stale results", async () => {
    withRuns([]);
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "verify_commands") return Promise.resolve([["test", "cargo test"]]);
      if (cmd === "list_verifications") return Promise.resolve([]);
      if (cmd === "run_verify") return Promise.reject(new Error("no such command"));
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });
    render(<TestExplorer projectHash="p" />);
    await waitFor(() => expect(screen.getByTestId("test-run-test")).toBeDefined());
    fireEvent.click(screen.getByTestId("test-run-test"));
    await waitFor(() => expect(screen.getByText(/no such command/)).toBeDefined());
  });
});
