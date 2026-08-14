import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import EditorStatusBar from "../EditorStatusBar";
import type { LspStatus } from "../api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

beforeEach(() => localStorage.clear());

const status = (over: Partial<LspStatus>): LspStatus => ({
  language: "rust",
  state: "running",
  server: "rust-analyzer",
  restarts: 0,
  detail: null,
  ...over,
});

describe("EditorStatusBar", () => {
  it("names the language and shows the server as running", () => {
    render(<EditorStatusBar language="Rust" lsp={status({})} />);
    expect(screen.getByTestId("lsp-indicator").textContent).toContain("Rust");
    expect(screen.getByTestId("lsp-note").textContent).toContain("running");
  });

  it("says a server is missing, and which one to install", async () => {
    render(
      <EditorStatusBar
        language="Rust"
        lsp={status({ state: "notInstalled", detail: "`rust-analyzer` is not on PATH" })}
      />
    );
    fireEvent.click(screen.getByTestId("lsp-indicator"));
    expect((await screen.findByTestId("lsp-state")).textContent).toContain(
      "not installed"
    );
    expect(screen.getByText(/Install rust-analyzer/)).toBeDefined();
  });

  it("reports a disabled language with its crash count and how to get it back", async () => {
    render(
      <EditorStatusBar
        language="Rust"
        lsp={status({
          state: "disabled",
          restarts: 3,
          detail: "the rust server crashed 3 times — disabled for this session",
        })}
      />
    );
    fireEvent.click(screen.getByTestId("lsp-indicator"));
    expect((await screen.findByTestId("lsp-detail")).textContent).toContain(
      "disabled for this session"
    );
    // D14 disables for the *session*, so the way back is a restart — an
    // in-app "try again" would be a button that does nothing.
    expect(screen.getByText(/Restart Floo/)).toBeDefined();
  });

  it("still names the file's language when there is no server at all", () => {
    render(<EditorStatusBar language="Plain text" lsp={null} />);
    expect(screen.getByTestId("lsp-note").textContent).toContain(
      "No language server"
    );
  });

  it("shows FIM as on, and says what it does", () => {
    render(<EditorStatusBar language="Rust" lsp={status({})} />);
    const fim = screen.getByTestId("fim-toggle");
    expect(fim).toHaveAttribute("aria-pressed", "true");
    expect(fim.getAttribute("aria-label")).toMatch(/completion/i);
  });

  it("toggles FIM off and back on from the status bar", () => {
    render(<EditorStatusBar language="Rust" lsp={status({})} />);
    fireEvent.click(screen.getByTestId("fim-toggle"));
    expect(screen.getByTestId("fim-toggle")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    // The one persistence path, shared with Settings.
    expect(localStorage.getItem("floo:completionEnabled")).toBe("false");

    fireEvent.click(screen.getByTestId("fim-toggle"));
    expect(localStorage.getItem("floo:completionEnabled")).toBe("true");
  });

  it("follows a change made in Settings without a remount", () => {
    render(<EditorStatusBar language="Rust" lsp={status({})} />);
    localStorage.setItem("floo:completionEnabled", "false");
    act(() =>
      window.dispatchEvent(new Event("floo:completion-settings-changed"))
    );
    expect(screen.getByTestId("fim-toggle")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("pairs the dot with a written state, never colour alone", () => {
    render(<EditorStatusBar language="Rust" lsp={status({ state: "crashed", restarts: 1 })} />);
    const dot = document.querySelector(".ds-status-dot");
    expect(dot?.className).toContain("warn");
    expect(dot).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("lsp-note").textContent).toContain("restarting");
  });
});
