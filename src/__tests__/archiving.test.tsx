import { describe, expect, it } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import type { ReactElement } from "react";
import { ArchiveIcon, ArchivingContext } from "../archiving";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

describe("ArchiveIcon", () => {
  it("shows the archive glyph at rest", () => {
    render(<ArchiveIcon threadId="t1" />);
    expect(screen.queryByLabelText("Archiving")).toBeNull();
  });

  it("shows a spinner only for the thread being archived", () => {
    render(
      <ArchivingContext.Provider value={new Set(["t1"])}>
        <ArchiveIcon threadId="t1" />
        <ArchiveIcon threadId="t2" />
      </ArchivingContext.Provider>,
    );
    expect(screen.getAllByLabelText("Archiving")).toHaveLength(1);
  });
});
