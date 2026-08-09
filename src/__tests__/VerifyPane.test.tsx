import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

const { listenMock } = vi.hoisted(() => ({
  listenMock: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import VerifyPane from "../VerifyPane";

const run = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "v1",
  projectHash: "proj-1",
  threadId: null,
  sessionId: null,
  name: "test",
  command: "cargo test",
  exitCode: 0,
  outputTail: "173 passed",
  gitHead: "abcdef1234567890",
  at: "2026-08-09T00:00:00Z",
  ...over,
});

const renderPane = () =>
  render(
    <MantineProvider>
      <VerifyPane projectHash="proj-1" />
    </MantineProvider>
  );

describe("VerifyPane", () => {
  // Block body: `mockReset()` returns the mock, and a `beforeEach` returning a
  // function has it called as a cleanup hook.
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockClear();
  });

  it("shows each run's exit code and commit, and never an aggregate verdict", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "verify_commands") return Promise.resolve([["test", "cargo test"]]);
      if (cmd === "list_verifications") {
        return Promise.resolve([
          run(),
          run({ id: "v2", name: "typecheck", exitCode: 1, outputTail: "type error" }),
        ]);
      }
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });

    renderPane();

    await waitFor(() =>
      expect(screen.getAllByTestId("verification-run")).toHaveLength(2)
    );
    expect(screen.getByText("exit 0")).toBeDefined();
    expect(screen.getByText("exit 1")).toBeDefined();
    // The commit is shown, because "it passed" is meaningless without one.
    expect(screen.getAllByText("abcdef1")).not.toHaveLength(0);
    // A failure's output is never swallowed.
    expect(screen.getByText(/type error/)).toBeDefined();

    // Nothing anywhere claims the project is verified, complete or satisfied.
    const body = document.body.textContent ?? "";
    for (const word of ["complete", "satisfied", "implemented", "all passing"]) {
      expect(body.toLowerCase()).not.toContain(word);
    }
  });

  it("runs a configured command and records the result that comes back", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "verify_commands") return Promise.resolve([["test", "cargo test"]]);
      if (cmd === "list_verifications") return Promise.resolve([]);
      if (cmd === "run_verify") return Promise.resolve();
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });

    renderPane();
    await waitFor(() => expect(screen.getByTestId("verify-run-test")).toBeDefined());
    fireEvent.click(screen.getByTestId("verify-run-test"));

    await waitFor(() => {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === "run_verify");
      expect(call?.[1]).toMatchObject({ projectHash: "proj-1", name: "test" });
    });

    // The result arrives on the event, not as the call's return value.
    const handler = listenMock.mock.calls.find(
      ([event]) => event === "verification-finished"
    )?.[1] as unknown as (e: { payload: unknown }) => void;
    handler({ payload: run({ exitCode: 2, outputTail: "boom" }) });

    await waitFor(() => expect(screen.getByText("exit 2")).toBeDefined());
    expect(screen.getByText(/boom/)).toBeDefined();
  });

  it("says so plainly when a project has configured no verify commands", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "verify_commands") return Promise.resolve([]);
      if (cmd === "list_verifications") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected ${cmd}`));
    });

    renderPane();
    await waitFor(() =>
      expect(screen.getByText(/No verify commands configured/)).toBeDefined()
    );
    expect(screen.queryAllByTestId("verification-run")).toHaveLength(0);
  });
});
