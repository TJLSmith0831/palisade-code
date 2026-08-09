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
