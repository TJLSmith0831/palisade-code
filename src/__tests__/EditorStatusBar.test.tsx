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
import {
  COMPLETION_ABSTAINED_EVENT,
  COMPLETION_ENABLED_KEY,
} from "../completion/GhostTextPlugin";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) =>
    cmd === "lsp_install_command"
      ? Promise.resolve("rustup component add rust-analyzer")
      : Promise.resolve()
  );
});

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
    invokeMock.mockImplementation(() => Promise.resolve(null));
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

  it("installs the missing server on click rather than printing homework", async () => {
    render(
      <EditorStatusBar
        language="Rust"
        lsp={status({ state: "notInstalled", detail: "`rust-analyzer` is not on PATH" })}
      />
    );
    fireEvent.click(screen.getByTestId("lsp-indicator"));

    const button = await screen.findByTestId("lsp-install");
    expect(button.textContent).toContain("rustup component add rust-analyzer");
    fireEvent.click(button);

    await screen.findByText(/installing/i);
    expect(invokeMock).toHaveBeenCalledWith("lsp_install", {
      language: "rust",
    });
  });

  it("shows the installer's own words when it fails", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "lsp_install_command")
        return Promise.resolve("rustup component add rust-analyzer");
      return Promise.reject(new Error("error: no such component"));
    });
    render(
      <EditorStatusBar language="Rust" lsp={status({ state: "notInstalled" })} />
    );
    fireEvent.click(screen.getByTestId("lsp-indicator"));
    fireEvent.click(await screen.findByTestId("lsp-install"));

    expect(
      (await screen.findByTestId("lsp-install-error")).textContent
    ).toContain("no such component");
  });

  it("falls back to naming the server when Palisade has no installer for it", async () => {
    invokeMock.mockImplementation(() => Promise.resolve(null));
    render(
      <EditorStatusBar
        language="Rust"
        lsp={status({ state: "notInstalled", server: "rust-analyzer" })}
      />
    );
    fireEvent.click(screen.getByTestId("lsp-indicator"));
    expect(await screen.findByText(/Install rust-analyzer/)).toBeDefined();
    expect(screen.queryByTestId("lsp-install")).toBeNull();
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
    expect(screen.getByText(/Restart Palisade/)).toBeDefined();
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
    expect(localStorage.getItem("palisade:completionEnabled")).toBe("false");

    fireEvent.click(screen.getByTestId("fim-toggle"));
    expect(localStorage.getItem("palisade:completionEnabled")).toBe("true");
  });

  it("follows a change made in Settings without a remount", () => {
    render(<EditorStatusBar language="Rust" lsp={status({})} />);
    localStorage.setItem("palisade:completionEnabled", "false");
    act(() =>
      window.dispatchEvent(new Event("palisade:completion-settings-changed"))
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

  // D61: the model's silence used to be indistinguishable from idle, in
  // flight, or errored — all four rendered nothing at all. This is the one
  // that gets a voice, and it lives here rather than at the cursor so it is
  // glanceable instead of interrupting the line being written.
  describe("abstention", () => {
    const abstain = () =>
      act(() => {
        window.dispatchEvent(new Event(COMPLETION_ABSTAINED_EVENT));
      });

    it("says nothing until the model abstains", () => {
      render(<EditorStatusBar language="Rust" lsp={status({})} />);
      expect(screen.queryByTestId("fim-abstained")).toBeNull();
    });

    it("reports the abstention in words, not just a colour", () => {
      render(<EditorStatusBar language="Rust" lsp={status({})} />);
      abstain();
      expect(screen.getByTestId("fim-abstained").textContent).toBe(
        "nothing confident here"
      );
    });

    it("does not blame the model or the user", () => {
      // The draft copy was a paragraph with "cannot" and "please" in it.
      // Read in peripheral vision mid-keystroke, that is an error message.
      render(<EditorStatusBar language="Rust" lsp={status({})} />);
      abstain();
      const text = screen.getByTestId("fim-abstained").textContent ?? "";
      for (const word of ["cannot", "failed", "unable", "please", "error"]) {
        expect(text.toLowerCase()).not.toContain(word);
      }
    });

    it("clears itself rather than sitting there", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<EditorStatusBar language="Rust" lsp={status({})} />);
      abstain();
      expect(screen.queryByTestId("fim-abstained")).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(screen.queryByTestId("fim-abstained")).toBeNull();
      vi.useRealTimers();
    });

    it("stays quiet when inline completion is switched off", () => {
      // Nothing is running, so there is nothing to abstain from — a stale
      // event must not resurrect the notice.
      localStorage.setItem(COMPLETION_ENABLED_KEY, "false");
      render(<EditorStatusBar language="Rust" lsp={status({})} />);
      abstain();
      expect(screen.queryByTestId("fim-abstained")).toBeNull();
    });
  });
});
