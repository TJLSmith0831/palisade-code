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

// Every run ever recorded used to render, each as a Code block with an output
// tail, and the app carries no windowing library to fall back on. A cap plus
// one click is enough, and costs no dependency.
describe("VerifyPane — long histories", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockClear();
  });

  const withRuns = (n: number) => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "verify_commands") return Promise.resolve([["test", "cargo test"]]);
      if (cmd === "list_verifications") {
        return Promise.resolve(
          Array.from({ length: n }, (_, i) => run({ id: `v${i}`, name: `run ${i}` }))
        );
      }
      return Promise.resolve(undefined);
    });
  };

  it("caps what it renders and says how many it is holding back", async () => {
    withRuns(53);
    renderPane();
    await waitFor(() => expect(screen.getAllByTestId("verification-run").length).toBe(20));
    expect(screen.getByTestId("verify-show-older").textContent).toContain("33 older runs");
  });

  it("shows the rest on request", async () => {
    withRuns(53);
    renderPane();
    await screen.findByTestId("verify-show-older");
    fireEvent.click(screen.getByTestId("verify-show-older"));
    await waitFor(() => expect(screen.getAllByTestId("verification-run").length).toBe(53));
    expect(screen.queryByTestId("verify-show-older")).toBeNull();
  });

  it("offers nothing to expand when the history already fits", async () => {
    withRuns(4);
    renderPane();
    await waitFor(() => expect(screen.getAllByTestId("verification-run").length).toBe(4));
    expect(screen.queryByTestId("verify-show-older")).toBeNull();
  });
});

// The one surface whose entire purpose is stating what evidence exists showed
// buttons and blank space when there was none.
describe("VerifyPane — nothing verified yet", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockClear();
  });

  it("says so, and names the command that would change it", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "verify_commands") return Promise.resolve([["test", "cargo test"]]);
      if (cmd === "list_verifications") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    renderPane();

    const empty = await screen.findByTestId("verify-empty");
    expect(empty.textContent).toContain("Nothing verified yet");
    // It restates the pane's own refusal rather than inventing a verdict.
    expect(empty.textContent).toMatch(/never because an agent reported/i);
    expect(empty.textContent).toContain("test");
    // And still no aggregate.
    expect(empty.textContent).not.toMatch(/\d+\s*\/\s*\d+/);
  });

  it("stays out of the way once there is a run to show", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "verify_commands") return Promise.resolve([["test", "cargo test"]]);
      if (cmd === "list_verifications") return Promise.resolve([run()]);
      return Promise.resolve(undefined);
    });
    renderPane();
    await screen.findByTestId("verification-run");
    expect(screen.queryByTestId("verify-empty")).toBeNull();
  });

  it("does not claim nothing is verified when no command is configured", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "verify_commands") return Promise.resolve([]);
      if (cmd === "list_verifications") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    renderPane();
    await screen.findByText(/No verify commands configured/i);
    expect(screen.queryByTestId("verify-empty")).toBeNull();
  });
});
