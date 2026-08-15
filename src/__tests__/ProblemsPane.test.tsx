import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import ProblemsPane from "../ProblemsPane";
import { clearDiagnostics, publishDiagnostics } from "../lspClients";

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

beforeEach(() => clearDiagnostics());

const diag = (over: Partial<Parameters<typeof publishDiagnostics>[1][0]> = {}) => ({
  path: "src/App.tsx",
  line: 42,
  severity: "error" as const,
  message: "Cannot find name 'foo'.",
  source: "ts",
  ...over,
});

describe("ProblemsPane", () => {
  it("says nothing was reported, not that the code is fine", () => {
    render(<ProblemsPane onOpen={vi.fn()} />);
    expect(screen.getByTestId("problems-empty").textContent).toContain(
      "reported by the language servers"
    );
  });

  it("shows a diagnostic with its file, line and source", () => {
    render(<ProblemsPane onOpen={vi.fn()} />);
    act(() => publishDiagnostics("file:///p/src/App.tsx", [diag()]));

    const row = screen.getByTestId("problem-row");
    expect(row.textContent).toContain("Cannot find name 'foo'.");
    expect(row.textContent).toContain("src/App.tsx:42");
    expect(row).toHaveAttribute("data-severity", "error");
  });

  it("opens the file at the line when a row is clicked", () => {
    const onOpen = vi.fn();
    render(<ProblemsPane onOpen={onOpen} />);
    act(() => publishDiagnostics("file:///p/src/App.tsx", [diag()]));
    fireEvent.click(screen.getByTestId("problem-row"));
    expect(onOpen).toHaveBeenCalledWith("src/App.tsx", 42);
  });

  it("drops a file's rows when the server reports it clean", () => {
    render(<ProblemsPane onOpen={vi.fn()} />);
    act(() => publishDiagnostics("file:///p/src/App.tsx", [diag()]));
    expect(screen.getAllByTestId("problem-row")).toHaveLength(1);

    act(() => publishDiagnostics("file:///p/src/App.tsx", []));
    expect(screen.queryByTestId("problem-row")).toBeNull();
    expect(screen.getByTestId("problems-empty")).toBeDefined();
  });

  it("ranks errors above warnings and hints", () => {
    render(<ProblemsPane onOpen={vi.fn()} />);
    act(() => {
      publishDiagnostics("file:///p/a.ts", [
        diag({ path: "a.ts", severity: "hint", message: "hint here" }),
      ]);
      publishDiagnostics("file:///p/b.ts", [
        diag({ path: "b.ts", severity: "error", message: "error here" }),
      ]);
    });
    const rows = screen.getAllByTestId("problem-row");
    expect(rows[0].textContent).toContain("error here");
    expect(rows[1].textContent).toContain("hint here");
  });
});
