import { act, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { beforeEach, expect, test, vi } from "vitest";
import NotebookTab from "../NotebookTab";
import * as api from "../api";
vi.mock("../api", () => ({
  readFileContent: vi.fn(),
  writeFileContent: vi.fn(),
  closeNotebookKernel: vi.fn().mockResolvedValue(undefined),
  interruptNotebookKernel: vi.fn(),
  restartNotebookKernel: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
const notebook = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [],
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.readFileContent).mockResolvedValue(notebook);
});
const mount = () =>
  render(
    <MantineProvider>
      <NotebookTab projectHash="p" path="n.ipynb" onDirtyChange={vi.fn()} onUnopenable={vi.fn()} />
    </MantineProvider>
  );
test("Restart kernel spins while restarting, then confirms", async () => {
  let settle: () => void = () => {};
  vi.mocked(api.restartNotebookKernel).mockReturnValue(new Promise<void>((resolve) => (settle = resolve)));
  mount();
  fireEvent.click(await screen.findByText("Restart kernel"));
  expect(
    screen.getByText("Restart kernel").closest("button"),
    "the button shows the restart is in progress"
  ).toHaveAttribute("data-loading", "true");
  await act(async () => settle());
  expect(await screen.findByRole("status"), "a finished restart is confirmed").toHaveTextContent("Kernel restarted");
});
test("Interrupt spins while sending and reports a failure", async () => {
  let fail: (err: Error) => void = () => {};
  vi.mocked(api.interruptNotebookKernel).mockReturnValue(new Promise<void>((_, reject) => (fail = reject)));
  mount();
  fireEvent.click(await screen.findByText("Interrupt"));
  expect(
    screen.getByText("Interrupt").closest("button"),
    "the button shows the interrupt is in progress"
  ).toHaveAttribute("data-loading", "true");
  await act(async () => fail(new Error("no kernel")));
  expect(await screen.findByText(/no kernel/), "a failed interrupt is reported, not swallowed").toBeInTheDocument();
  expect(screen.getByText("Interrupt").closest("button")).not.toHaveAttribute("data-loading");
});
