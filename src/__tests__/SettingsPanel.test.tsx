import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";

import SettingsPanel, {
  ACCENT_HUE_KEY,
  loadAppearance,
  COMPLETION_ENABLED_KEY,
  COMPLETION_KEYBINDING_KEY,
  COMPLETION_SETTINGS_CHANGED_EVENT,
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
    "--app-shell-light-override",
    "--app-shell-dark-override",
    "--shell-accent-light-override",
    "--shell-accent-dark-override",
    "--code-comment-light-override",
    "--code-comment-dark-override",
    "--code-text-light-override",
    "--code-text-dark-override",
  ].forEach((k) => document.documentElement.style.removeProperty(k));
});

describe("SettingsPanel", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

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

  it("changing the editor font persists it and notifies listeners", async () => {
    const onFontChanged = vi.fn();
    window.addEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
    render(
      <SettingsPanel
        projectHash="proj1"
        onOpenProjectSettings={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("editor-font-select"));
    fireEvent.click(
      await screen.findByRole("option", { name: "Menlo", hidden: true })
    );

    expect(localStorage.getItem(EDITOR_FONT_KEY)).toBe(
      "Menlo, ui-monospace, monospace"
    );
    expect(onFontChanged).toHaveBeenCalled();
    window.removeEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
  });

  it("toggling AI completion persists it, syncs to backend, and notifies listeners", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    window.addEventListener(COMPLETION_SETTINGS_CHANGED_EVENT, onChanged);
    render(
      <SettingsPanel
        projectHash="proj1"
        onOpenProjectSettings={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const input = screen.getByRole("switch", { name: /Enable inline AI/ });
    await user.click(input);

    expect(localStorage.getItem(COMPLETION_ENABLED_KEY)).toBe("false");
    expect(invokeMock).toHaveBeenCalledWith("set_completion_enabled", {
      enabled: false,
    });
    expect(onChanged).toHaveBeenCalled();
    window.removeEventListener(COMPLETION_SETTINGS_CHANGED_EVENT, onChanged);
  });

  it("changing the accept keybinding persists it and notifies listeners", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    window.addEventListener(COMPLETION_SETTINGS_CHANGED_EVENT, onChanged);
    render(
      <SettingsPanel
        projectHash="proj1"
        onOpenProjectSettings={vi.fn()}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId("completion-keybinding-select"));
    fireEvent.click(await screen.findByRole("option", { name: "Tab", hidden: true }));

    expect(localStorage.getItem(COMPLETION_KEYBINDING_KEY)).toBe("Tab");
    expect(invokeMock).toHaveBeenCalledWith("set_completion_keybinding", {
      keybinding: "Tab",
    });
    expect(onChanged).toHaveBeenCalled();
    window.removeEventListener(COMPLETION_SETTINGS_CHANGED_EVENT, onChanged);
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

  it("loads .palisade/project-settings.json on mount and highlights the matching app-shell swatch", async () => {
    // Nord is the third shell preset (index 2: Default=0, One Dark=1,
    // Nord=2). Stored as the project's appShellColor.
    invokeMock.mockImplementation(
      (cmd: string, args: Record<string, unknown>) => {
        if (
          cmd === "read_file_content" &&
          args?.relativePath === ".palisade/project-settings.json"
        ) {
          return Promise.resolve(
            JSON.stringify({
              formatOnSave: {},
              executorOverride: null,
              appearance: {
                appShellColor: {
                  light: "#eceff4",
                  dark: "#2e3440",
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
      const lightSwatches = screen.getAllByTestId(
        "app-shell-swatches-light-swatch"
      );
      // Nord (index 2) should be marked active.
      expect(lightSwatches[2]).toHaveAttribute("aria-pressed", "true");
    });
  });

  it("tolerates a missing/malformed .palisade/project-settings.json without crashing and leaves no swatch active", async () => {
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
        screen.getAllByTestId("app-shell-swatches-light-swatch").length
      ).toBeGreaterThan(0);
    });
    // No swatch should be active when nothing is stored.
    screen.getAllByTestId("app-shell-swatches-light-swatch").forEach((s) => {
      expect(s).toHaveAttribute("aria-pressed", "false");
    });
  });

  it("clicking an app-shell swatch sets only the outer-shell overrides and persists the appearance via save_appearance", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args: Record<string, unknown>) => {
        if (
          cmd === "read_file_content" &&
          args?.relativePath === ".palisade/project-settings.json"
        ) {
          return Promise.resolve(
            JSON.stringify({
              formatOnSave: { "\\.rs$": "cargo fmt" },
              executorOverride: "codex",
            })
          );
        }
        if (cmd === "save_appearance") return Promise.resolve();
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
        screen.getAllByTestId("app-shell-swatches-light-swatch").length
      ).toBeGreaterThan(0)
    );

    // Click the third light app-shell swatch (Nord, index 2).
    fireEvent.click(
      screen.getAllByTestId("app-shell-swatches-light-swatch")[2]
    );

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue(
          "--app-shell-light-override"
        )
      ).toBe("#eceff4");
      expect(
        document.documentElement.style.getPropertyValue(
          "--shell-accent-light-override"
        )
      ).toBe("");
    });

    // The backend owns merging this into the rest of the settings file now
    // (settings.rs's save_appearance) — the frontend only has to send the
    // new appearance object.
    await waitFor(() => {
      const saveCall = invokeMock.mock.calls.find(
        (c) => c[0] === "save_appearance"
      );
      expect(saveCall).toBeDefined();
      const appearance = saveCall![1].appearance as {
        appShellColor: { light: string };
      };
      expect(appearance.appShellColor.light).toBe("#eceff4");
    });
  });

  it("clicking a shell-accent swatch sets only the raised-surface overrides and persists shellAccentColor via save_appearance", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args: Record<string, unknown>) => {
        if (
          cmd === "read_file_content" &&
          args?.relativePath === ".palisade/project-settings.json"
        ) {
          return Promise.resolve(
            JSON.stringify({
              formatOnSave: { "\\.rs$": "cargo fmt" },
              executorOverride: "codex",
            })
          );
        }
        if (cmd === "save_appearance") return Promise.resolve();
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
        screen.getAllByTestId("shell-accent-swatches-light-swatch").length
      ).toBeGreaterThan(0)
    );

    fireEvent.click(
      screen.getAllByTestId("shell-accent-swatches-light-swatch")[2]
    );

    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue(
          "--shell-accent-light-override"
        )
      ).toBe("#eceff4");
      expect(
        document.documentElement.style.getPropertyValue(
          "--app-shell-light-override"
        )
      ).toBe("");
    });

    await waitFor(() => {
      const saveCall = invokeMock.mock.calls.find(
        (c) => c[0] === "save_appearance"
      );
      expect(saveCall).toBeDefined();
      const appearance = saveCall![1].appearance as {
        shellAccentColor: { light: string };
      };
      expect(appearance.shellAccentColor.light).toBe("#eceff4");
    });
  });

  it("clicking 'Reset to default' clears all appearance overrides and persists an empty appearance", async () => {
    invokeMock.mockImplementation(
      (cmd: string, args: Record<string, unknown>) => {
        if (
          cmd === "read_file_content" &&
          args?.relativePath === ".palisade/project-settings.json"
        ) {
          return Promise.resolve(
            JSON.stringify({
              appearance: {
                appShellColor: { light: "#eceff4", dark: "#2e3440" },
                shellAccentColor: { light: "#d8dee9", dark: "#3b4252" },
                commentColor: { light: "#a3a3a3", dark: "#7f8c8d" },
                codeTextColor: { light: "#222222", dark: "#e8b8d0" },
              },
            })
          );
        }
        if (cmd === "save_appearance") return Promise.resolve();
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

    // Wait for the stored appearance to be applied.
    await waitFor(() => {
      expect(
        document.documentElement.style.getPropertyValue(
          "--app-shell-light-override"
        )
      ).toBe("#eceff4");
    });

    fireEvent.click(screen.getByTestId("reset-appearance-button"));

    // All appearance override properties should be removed from <html>.
    await waitFor(() => {
      [
        "--app-shell-light-override",
        "--app-shell-dark-override",
        "--shell-accent-light-override",
        "--shell-accent-dark-override",
        "--code-comment-light-override",
        "--code-comment-dark-override",
        "--code-text-light-override",
        "--code-text-dark-override",
      ].forEach((k) => {
        expect(document.documentElement.style.getPropertyValue(k)).toBe("");
      });
    });

    // No swatch should remain active after reset.
    screen.getAllByTestId("app-shell-swatches-light-swatch").forEach((s) => {
      expect(s).toHaveAttribute("aria-pressed", "false");
    });

    // The persisted appearance should be empty.
    await waitFor(() => {
      const saveCall = invokeMock.mock.calls
        .slice()
        .reverse()
        .find((c) => c[0] === "save_appearance");
      expect(saveCall).toBeDefined();
      expect(saveCall![1].appearance).toEqual({});
    });
  });
});


describe("appearance defaults and reliable saves", () => {
  beforeEach(() => invokeMock.mockReset().mockImplementation((cmd: string) =>
    cmd === "read_file_content" ? Promise.resolve("{}") : Promise.resolve()));

  it("saves global defaults without writing project files, then restores built-in colors", async () => {
    render(<SettingsPanel projectHash="" onClose={vi.fn()} onOpenProjectSettings={vi.fn()} />);
    fireEvent.click(screen.getAllByTestId("app-shell-swatches-light-swatch")[2]);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("palisade:appearance") || "{}").appShellColor?.light).toBe("#eceff4"));
    expect(invokeMock).not.toHaveBeenCalledWith("write_file_content", expect.anything());
    fireEvent.click(screen.getByTestId("reset-appearance-button"));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--app-shell-light-override")).toBe(""));
    expect(JSON.parse(localStorage.getItem("palisade:appearance") || "{}")).toEqual({});
  });
});

it("project overrides inherit global colors per light/dark value and reset back to them", async () => {
  localStorage.setItem("palisade:appearance", JSON.stringify({appShellColor: {light: "#eceff4", dark: "#2e3440"}}));
  invokeMock.mockImplementation((cmd: string) => cmd === "read_file_content"
    ? Promise.resolve(JSON.stringify({appearance: {appShellColor: {dark: "#282c34"}}})) : Promise.resolve());
  expect(await loadAppearance("proj1")).toMatchObject({appShellColor: {light: "#eceff4", dark: "#282c34"}});
  render(<SettingsPanel projectHash="proj1" onClose={vi.fn()} onOpenProjectSettings={vi.fn()} />);
  await waitFor(() => expect(document.documentElement.style.getPropertyValue("--app-shell-dark-override")).toBe("#282c34"));
  fireEvent.click(screen.getByTestId("reset-appearance-button"));
  await waitFor(() => expect(document.documentElement.style.getPropertyValue("--app-shell-dark-override")).toBe("#2e3440"));
  fireEvent.click(screen.getByRole("radio", {name: "Global defaults"}));
  fireEvent.click(screen.getByTestId("reset-appearance-button"));
  await waitFor(() => expect(localStorage.getItem("palisade:appearance")).toBe("{}"));
});

it("reports a failed project save and restores the persisted appearance", async () => {
  invokeMock.mockReset().mockImplementation((cmd: string) => cmd === "read_file_content"
    ? Promise.resolve("{}") : Promise.reject(new Error("disk full")));
  render(<SettingsPanel projectHash="proj1" onClose={vi.fn()} onOpenProjectSettings={vi.fn()} />);
  await waitFor(() => expect(invokeMock).toHaveBeenCalled());
  fireEvent.click(screen.getAllByTestId("app-shell-swatches-light-swatch")[2]);
  expect(await screen.findByRole("alert")).toHaveTextContent(/could not save/i);
  expect(document.documentElement.style.getPropertyValue("--app-shell-light-override")).toBe("");
});

it("saving appearance no longer depends on the project settings file parsing cleanly", async () => {
  // The guarded read-merge-write moved to the backend (settings.rs's
  // save_appearance), which defaults to {} on malformed content instead of
  // failing the save — so a broken settings file only affects what's
  // *displayed* on load (loadProjectAppearance), not whether a new
  // appearance can be saved.
  invokeMock.mockReset().mockImplementation((cmd: string) =>
    cmd === "read_file_content"
      ? Promise.resolve('{"formatOnSave":')
      : Promise.resolve()
  );
  render(<SettingsPanel projectHash="proj1" onClose={vi.fn()} onOpenProjectSettings={vi.fn()} />);
  await waitFor(() => expect(invokeMock).toHaveBeenCalled());
  fireEvent.click(screen.getAllByTestId("app-shell-swatches-light-swatch")[2]);
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith(
      "save_appearance",
      expect.objectContaining({ projectHash: "proj1" })
    )
  );
  expect(screen.queryByRole("alert")).toBeNull();
});
