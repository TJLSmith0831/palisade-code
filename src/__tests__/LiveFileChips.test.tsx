import type { ReactElement } from "react";
import { describe, it, expect } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import LiveFileChips, { touchedFiles } from "../LiveFileChips";
import type { ExecutorEvent } from "../api";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

const edit = (path: string, before: string, after: string): ExecutorEvent => ({
  kind: "fileEdit",
  id: `${path}-${after.length}`,
  path,
  before,
  after,
});

describe("touchedFiles", () => {
  // A turn that rewrites one file four times touched one file. A chip per
  // write would overstate the size of the turn.
  it("folds repeated edits to the same file into one entry", () => {
    const files = touchedFiles([
      edit("src/a.ts", "one\n", "two\n"),
      edit("src/a.ts", "two\n", "three\n"),
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].before).toBe("one\n");
    expect(files[0].after).toBe("three\n");
  });

  it("keeps first-touched order across files", () => {
    const files = touchedFiles([
      edit("src/a.ts", "", "a\n"),
      edit("src/b.ts", "", "b\n"),
      edit("src/a.ts", "a\n", "aa\n"),
    ]);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("ignores events that are not file edits", () => {
    expect(touchedFiles([{ kind: "text", text: "hello" }])).toEqual([]);
  });
});

describe("LiveFileChips", () => {
  it("renders nothing until a file is touched", () => {
    render(<LiveFileChips live={[{ kind: "text", text: "thinking" }]} busy />);
    expect(screen.queryByTestId("live-file-chips")).toBeNull();
  });

  it("marks the file being written right now, and only while busy", () => {
    const live = [edit("src/a.ts", "", "a\n"), edit("src/b.ts", "", "b\n")];
    const { unmount } = render(<LiveFileChips live={live} busy />);
    const chips = screen.getAllByTestId("file-chip");
    expect(chips[1]).toHaveAttribute("data-active", "true");
    expect(chips[0]).not.toHaveAttribute("data-active");
    unmount();

    render(<LiveFileChips live={live} busy={false} />);
    for (const chip of screen.getAllByTestId("file-chip")) {
      expect(chip).not.toHaveAttribute("data-active");
    }
  });

  it("expands one file's diff in place and closes it again", () => {
    render(<LiveFileChips live={[edit("src/a.ts", "one\n", "two\n")]} busy={false} />);
    expect(screen.queryByTestId("file-chip-diff")).toBeNull();
    fireEvent.click(screen.getByTestId("file-chip"));
    expect(screen.getByTestId("file-chip-diff")).toHaveTextContent("src/a.ts");
    fireEvent.click(screen.getByTestId("file-chip"));
    expect(screen.queryByTestId("file-chip-diff")).toBeNull();
  });
});
