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
