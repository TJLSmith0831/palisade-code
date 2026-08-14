import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import RunPanel from "../RunPanel";
import * as api from "../api";

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

vi.mock("../api", () => ({
  runCommands: vi.fn(),
  saveRunCommands: vi.fn(),
  detectRunCommands: vi.fn(),
}));

const mocked = api as unknown as {
  runCommands: ReturnType<typeof vi.fn>;
  saveRunCommands: ReturnType<typeof vi.fn>;
  detectRunCommands: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mocked.runCommands.mockReset().mockResolvedValue([["dev", "pnpm start"]]);
  mocked.saveRunCommands.mockReset().mockResolvedValue(undefined);
  mocked.detectRunCommands.mockReset().mockResolvedValue([]);
});

const props = {
  projectHash: "p1",
  onRun: vi.fn(),
  onError: vi.fn(),
};

describe("RunPanel", () => {
  it("lists the configured commands", async () => {
    render(<RunPanel {...props} />);
    expect(await screen.findByText("dev")).toBeDefined();
    expect(screen.getByText("pnpm start")).toBeDefined();
  });

  it("runs a command through the caller instead of executing it itself", async () => {
    const onRun = vi.fn();
    render(<RunPanel {...props} onRun={onRun} />);
    fireEvent.click(await screen.findByTestId("run-play-dev"));
    expect(onRun).toHaveBeenCalledWith("dev", "pnpm start");
  });

  it("adds a command and persists the whole map", async () => {
    render(<RunPanel {...props} />);
    await screen.findByText("dev");
    fireEvent.click(screen.getByTestId("run-add"));
    fireEvent.change(screen.getByTestId("run-draft-name"), {
      target: { value: "build" },
    });
    fireEvent.change(screen.getByTestId("run-draft-command"), {
      target: { value: "cargo build" },
    });
    fireEvent.click(screen.getByTestId("run-draft-save"));

    await waitFor(() =>
      expect(mocked.saveRunCommands).toHaveBeenCalledWith("p1", [
        ["build", "cargo build"],
        ["dev", "pnpm start"],
      ])
    );
  });

  it("will not save a draft that is missing a name or a command", async () => {
    render(<RunPanel {...props} />);
    await screen.findByText("dev");
    fireEvent.click(screen.getByTestId("run-add"));
    fireEvent.change(screen.getByTestId("run-draft-name"), {
      target: { value: "build" },
    });
    expect(screen.getByTestId("run-draft-save")).toBeDisabled();
  });

  it("deletes a command by saving the map without it", async () => {
    mocked.runCommands.mockResolvedValue([
      ["dev", "pnpm start"],
      ["test", "cargo test"],
    ]);
    render(<RunPanel {...props} />);
    fireEvent.click(await screen.findByTestId("run-delete-dev"));
    await waitFor(() =>
      expect(mocked.saveRunCommands).toHaveBeenCalledWith("p1", [
        ["test", "cargo test"],
      ])
    );
  });

  it("edits an existing command in place", async () => {
    render(<RunPanel {...props} />);
    fireEvent.click(await screen.findByTestId("run-edit-dev"));
    fireEvent.change(screen.getByTestId("run-draft-command"), {
      target: { value: "pnpm dev" },
    });
    fireEvent.click(screen.getByTestId("run-draft-save"));
    await waitFor(() =>
      expect(mocked.saveRunCommands).toHaveBeenCalledWith("p1", [
        ["dev", "pnpm dev"],
      ])
    );
  });

  it("proposes detected commands when nothing is configured, and writes nothing until accepted", async () => {
    mocked.runCommands.mockResolvedValue([]);
    mocked.detectRunCommands.mockResolvedValue([["dev", "pnpm run dev"]]);
    render(<RunPanel {...props} />);

    const suggestion = await screen.findByTestId("run-suggestion-dev");
    expect(suggestion.textContent).toContain("pnpm run dev");
    // Proposing is not deciding.
    expect(mocked.saveRunCommands).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("run-accept-dev"));
    await waitFor(() =>
      expect(mocked.saveRunCommands).toHaveBeenCalledWith("p1", [
        ["dev", "pnpm run dev"],
      ])
    );
  });

  it("says so when a project has nothing configured and nothing detected", async () => {
    mocked.runCommands.mockResolvedValue([]);
    render(<RunPanel {...props} />);
    expect(await screen.findByTestId("run-empty")).toBeDefined();
  });
});
