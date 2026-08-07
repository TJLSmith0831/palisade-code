import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import SettingsPanel, {
  ACCENT_HUE_KEY,
  EDITOR_FONT_CHANGED_EVENT,
  EDITOR_FONT_KEY,
  EDITOR_FONT_SIZE_KEY,
} from "../SettingsPanel";

afterEach(() => {
  localStorage.clear();
});

describe("SettingsPanel", () => {
  it("applies an accent color as a CSS custom property and persists it", () => {
    render(<SettingsPanel onOpenProjectSettings={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getAllByTestId("accent-swatch")[1]); // Ocean Blue (hue 250)

    expect(document.documentElement.style.getPropertyValue("--accent-hue")).toBe("250");
    expect(localStorage.getItem(ACCENT_HUE_KEY)).toBe("250");
  });

  it("changing the editor font persists it and notifies listeners", () => {
    const onFontChanged = vi.fn();
    window.addEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
    render(<SettingsPanel onOpenProjectSettings={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId("editor-font-select"), { target: { value: "Menlo, ui-monospace, monospace" } });

    expect(localStorage.getItem(EDITOR_FONT_KEY)).toBe("Menlo, ui-monospace, monospace");
    expect(onFontChanged).toHaveBeenCalled();
    window.removeEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
  });

  it("changing the editor font size persists it and notifies listeners", () => {
    const onFontChanged = vi.fn();
    window.addEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
    render(<SettingsPanel onOpenProjectSettings={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId("editor-font-size-input"), { target: { value: "16" } });

    expect(localStorage.getItem(EDITOR_FONT_SIZE_KEY)).toBe("16");
    expect(onFontChanged).toHaveBeenCalled();
    window.removeEventListener(EDITOR_FONT_CHANGED_EVENT, onFontChanged);
  });

  it("closes and opens project settings when the link is clicked", () => {
    const onOpenProjectSettings = vi.fn();
    const onClose = vi.fn();
    render(<SettingsPanel onOpenProjectSettings={onOpenProjectSettings} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("open-project-settings"));

    expect(onClose).toHaveBeenCalled();
    expect(onOpenProjectSettings).toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<SettingsPanel onOpenProjectSettings={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
