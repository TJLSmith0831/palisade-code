import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { ReactElement } from "react";

import TabBar from "../TabBar";
import type { OpenTab } from "../openTabs";

const render_ = (ui: ReactElement) => render(ui, { wrapper: MantineProvider });

const tab = (path: string, overrides: Partial<OpenTab> = {}): OpenTab => ({
  path,
  dirty: false,
  mdPreview: false,
  ...overrides,
});

describe("TabBar", () => {
  it("shows the Markdown preview toggle for an active .md file", () => {
    render_(
      <TabBar
        tabs={[tab("README.md")]}
        activePath="README.md"
        onSelect={() => {}}
        onClose={() => {}}
        diffOpen={false}
        onToggleDiff={() => {}}
        activeMdPreview={false}
        onToggleMdPreview={() => {}}
      />
    );
    expect(screen.getByTestId("toggle-md-preview")).toBeDefined();
  });

  it("shows the Markdown preview toggle for an active .markdown file", () => {
    render_(
      <TabBar
        tabs={[tab("notes.markdown")]}
        activePath="notes.markdown"
        onSelect={() => {}}
        onClose={() => {}}
        diffOpen={false}
        onToggleDiff={() => {}}
        activeMdPreview={false}
        onToggleMdPreview={() => {}}
      />
    );
    expect(screen.getByTestId("toggle-md-preview")).toBeDefined();
  });

  it("hides the Markdown preview toggle for a non-markdown active file", () => {
    render_(
      <TabBar
        tabs={[tab("src/foo.ts")]}
        activePath="src/foo.ts"
        onSelect={() => {}}
        onClose={() => {}}
        diffOpen={false}
        onToggleDiff={() => {}}
        activeMdPreview={false}
        onToggleMdPreview={() => {}}
      />
    );
    expect(screen.queryByTestId("toggle-md-preview")).toBeNull();
  });

  it("hides the Markdown preview toggle when no tab is active", () => {
    render_(
      <TabBar
        tabs={[tab("README.md")]}
        activePath={null}
        onSelect={() => {}}
        onClose={() => {}}
        diffOpen={false}
        onToggleDiff={() => {}}
        activeMdPreview={false}
        onToggleMdPreview={() => {}}
      />
    );
    expect(screen.queryByTestId("toggle-md-preview")).toBeNull();
  });

  it("calls onToggleMdPreview when the button is clicked", () => {
    const onToggleMdPreview = vi.fn();
    render_(
      <TabBar
        tabs={[tab("README.md")]}
        activePath="README.md"
        onSelect={() => {}}
        onClose={() => {}}
        diffOpen={false}
        onToggleDiff={() => {}}
        activeMdPreview={false}
        onToggleMdPreview={onToggleMdPreview}
      />
    );
    fireEvent.click(screen.getByTestId("toggle-md-preview"));
    expect(onToggleMdPreview).toHaveBeenCalledTimes(1);
  });

  it("renders pressed/filled when preview is active", () => {
    render_(
      <TabBar
        tabs={[tab("README.md", { mdPreview: true })]}
        activePath="README.md"
        onSelect={() => {}}
        onClose={() => {}}
        diffOpen={false}
        onToggleDiff={() => {}}
        activeMdPreview={true}
        onToggleMdPreview={() => {}}
      />
    );
    expect(screen.getByTestId("toggle-md-preview")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("renders unpressed when preview is off", () => {
    render_(
      <TabBar
        tabs={[tab("README.md")]}
        activePath="README.md"
        onSelect={() => {}}
        onClose={() => {}}
        diffOpen={false}
        onToggleDiff={() => {}}
        activeMdPreview={false}
        onToggleMdPreview={() => {}}
      />
    );
    expect(screen.getByTestId("toggle-md-preview")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("places the Markdown toggle to the left of the diff toggle", () => {
    const { container } = render_(
      <TabBar
        tabs={[tab("README.md")]}
        activePath="README.md"
        onSelect={() => {}}
        onClose={() => {}}
        diffOpen={false}
        onToggleDiff={() => {}}
        activeMdPreview={false}
        onToggleMdPreview={() => {}}
      />
    );
    const md = screen.getByTestId("toggle-md-preview");
    const diff = screen.getByTestId("toggle-diff");
    // Compare document position — md should come before diff in DOM order.
    // Node.DOCUMENT_POSITION_PRECEDING = 2
    expect(
      diff.compareDocumentPosition(md) & Node.DOCUMENT_POSITION_PRECEDING
    ).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    // Sanity: container holds both.
    expect(container.contains(md) && container.contains(diff)).toBe(true);
  });
});

// The close control had an aria-label but no role and no tabIndex, so it was
// named for a screen reader and unreachable by keyboard — the only way to
// close a file tab was with a mouse. The thread tab's close in App.tsx had
// always done this correctly; this is that same shape.
describe("TabBar — closing a tab without a mouse", () => {
  const renderTabs = (over: { onClose?: () => void; onSelect?: () => void } = {}) =>
    render_(
      <TabBar
        tabs={[tab("README.md")]}
        activePath="README.md"
        onSelect={over.onSelect ?? (() => {})}
        onClose={over.onClose ?? (() => {})}
        diffOpen={false}
        onToggleDiff={() => {}}
        activeMdPreview={false}
        onToggleMdPreview={() => {}}
      />
    );

  it("puts the close control in the tab order and activates it from the keyboard", () => {
    const onClose = vi.fn();
    renderTabs({ onClose });
    const close = screen.getAllByTestId("file-tab-close")[0];
    expect(close.getAttribute("role")).toBe("button");
    expect(close.getAttribute("tabIndex")).toBe("0");
    expect(close.getAttribute("aria-label")).toMatch(/^Close /);

    fireEvent.keyDown(close, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(close, { key: " " });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not also select the tab it is closing", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    renderTabs({ onClose, onSelect });
    fireEvent.keyDown(screen.getAllByTestId("file-tab-close")[0], { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("offers Go to file beside the + menu when wired", () => {
    const onGoToFile = vi.fn();
    render_(
      <TabBar
        tabs={[tab("README.md")]}
        activePath="README.md"
        onSelect={() => {}}
        onClose={() => {}}
        diffOpen={false}
        onToggleDiff={() => {}}
        activeMdPreview={false}
        onToggleMdPreview={() => {}}
        onGoToFile={onGoToFile}
      />
    );
    fireEvent.click(screen.getByTestId("go-to-file"));
    expect(onGoToFile).toHaveBeenCalledTimes(1);
  });
});
