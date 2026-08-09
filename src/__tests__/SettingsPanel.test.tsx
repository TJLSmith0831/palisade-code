import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import SettingsPanel, {
  ACCENT_HUE_KEY,
  EDITOR_FONT_CHANGED_EVENT,
  EDITOR_FONT_KEY,
  EDITOR_FONT_SIZE_KEY,
} from "../SettingsPanel";

// Hoisted so the mock is in place before the SettingsPanel import resolves
// its own `import * as api from "./api"` — same pattern FileEditorPane.test
// uses to route read_file_content / write_file_content to a controllable
// stub instead of the real Tauri invoke bridge.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const render = (ui: ReactElement) =>
  rtlRender(ui, { wrapper: MantineProvider });

afterEach(() => {
  localStorage.clear();
  // Clear any appearance override properties the panel may have set on <html>.
  [
    "--chrome-bg-light-override",
    "--chrome-bg-dark-override",
    "--code-comment-light-override",
    "--code-comment-dark-override",
    "--code-text-light-override",
    "--code-text-dark-override",
  ].forEach((k) => document.documentElement.style.removeProperty(k));
});

describe("SettingsPanel", () => {
  it("applies an accent color as a CSS custom property and persists it", () => {
    render(
      <SettingsPanel
        projectHash="proj1"
        onOpenProjectSettings={vi.fn()}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(screen.getAllByTestId("accent-swatch")[1]); // Ocean Blue (hue 250)

    expect(
      document.documentElement.style.getPropertyValue("--accent-hue")
    ).toBe("250");
    expect(localStorage.getItem(ACCENT_HUE_KEY)).toBe("250");
  });

  it("changing the editor font persists it and notifies listeners", () => {
    const onFontChanged = vi.fn();
    window.addEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
    render(
      <SettingsPanel
        projectHash="proj1"
        onOpenProjectSettings={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByTestId("editor-font-select"), {
      target: { value: "Menlo, ui-monospace, monospace" },
    });

    expect(localStorage.getItem(EDITOR_FONT_KEY)).toBe(
      "Menlo, ui-monospace, monospace"
    );
    expect(onFontChanged).toHaveBeenCalled();
    window.removeEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
  });

  it("changing the editor font size persists it and notifies listeners", () => {
    const onFontChanged = vi.fn();
    window.addEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
    render(
      <SettingsPanel
        projectHash="proj1"
        onOpenProjectSettings={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByTestId("editor-font-size-input"), {
      target: { value: "16" },
    });

    expect(localStorage.getItem(EDITOR_FONT_SIZE_KEY)).toBe("16");
    expect(onFontChanged).toHaveBeenCalled();
    window.removeEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
  });

  it("closes and opens project settings when the link is clicked", () => {
    const onOpenProjectSettings = vi.fn();
    const onClose = vi.fn();
    render(
      <SettingsPanel
        projectHash="proj1"
        onOpenProjectSettings={onOpenProjectSettings}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByTestId("open-project-settings"));

    expect(onClose).toHaveBeenCalled();
    expect(onOpenProjectSettings).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <SettingsPanel
        projectHash="proj1"
        onOpenProjectSettings={vi.fn()}
        onClose={onClose}
      />
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("SettingsPanel appearance pickers (project-scoped)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("loads .project-settings.json on mount and highlights the matching shell-color swatch", async () => {
    // Ocean Blue (hue 250) is the third shell preset (index 2: Default=0,
    // Dragon Green=1, Ocean Blue=2). Stored as the project's shellColor.
    invokeMock.mockImplementation(
      (cmd: string, args: Record<string, unknown>) => {
        if (
          cmd === "read_file_content" &&
          args?.relativePath === ".project-settings.json"
        ) {
          return Promise.resolve(
            JSON.stringify({
              formatOnSave: {},
              executorOverride: null,
              appearance: {
                shellColor: {
                  light: "oklch(97% 0.004 250)",
                  dark: "oklch(15% 0.004 250)",
                },
              },
            })
          );
        }
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      }
    );

    render(
      <SettingsPanel
        projectHash="proj1"
        onOpenProjectSettings={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      const lightSwatches = screen.getAllByTestId("shell-swatch-light");
      // Ocean Blue (index 2) should be marked active.
      expect(lightSwatches[2]).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("tolerates a missing/malformed .project-settings.json without crashing and leaves no swatch active", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "read_file_content")
        return Promise.reject(new Error("not found"));
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    render(
      <SettingsPanel
        projectHash="proj1"
        onOpenProjectSettings={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(
        screen.getAllByTestId("shell-swatch-light").length
      ).toBeGreaterThan(0);
    });
    // No swatch should be active when nothing is stored.
    screen.getAllByTestId("shell-swatch-light").forEach((s) => {
      expect(s).toHaveAttribute("aria-pressed", "false");
    });
  });

  it("clicking a shell-color swatch sets the CSS override and persists the merged appearance alongside existing settings", async () => {
    // The file already has formatOnSave + executorOverride; the appearance
    // key must be merged in without clobbering them.
    invokeMock.mockImplementation(
      (cmd: string, args: Record<string, unknown>) => {
        if (
          cmd === "read_file_content" &&
          args?.relativePath === ".project-settings.json"
        ) {
          return Promise.resolve(
            JSON.stringify({
              formatOnSave: { "\\.rs$": "cargo fmt" },
              executorOverride: "codex",
            })
          );
        }
        if (cmd === "write_file_content") return Promise.resolve();
        return Promise.reject(new Error(`unexpected command ${cmd}`));
      }
    );

    render(
      <SettingsPanel
        projectHash="proj1"
        onOpenProjectSettings={vi.fn()}
        onClose={vi.fn()}
      />
    );

    await waitFor(() =>
      expect(
        screen.getAllByTestId("shell-swatch-light").length
      ).toBeGreaterThan(0)
    );

    // Click the third light shell swatch (Ocean Blue, index 2).
    fireEvent.click(screen.getAllByTestId("shell-swatch-light")[2]);

    // The dark override property should be set immediately for preview.
    await waitFor(() =>
      expect(
        document.documentElement.style.getPropertyValue(
          "--chrome-bg-light-override"
        )
      ).toMatch(/oklch/)
    );

    // The persisted JSON should contain both the original keys and the new appearance.
    await waitFor(() => {
      const writeCall = invokeMock.mock.calls.find(
        (c) => c[0] === "write_file_content"
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall![1].content as string);
      expect(written.formatOnSave).toEqual({ "\\.rs$": "cargo fmt" });
      expect(written.executorOverride).toBe("codex");
      expect(written.appearance.shellColor.light).toMatch(/oklch/);
    });
  });
});
