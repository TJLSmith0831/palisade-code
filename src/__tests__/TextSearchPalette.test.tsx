import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

import TextSearchPalette from "../TextSearchPalette";
import type { TextMatch } from "../api";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

const files = ["src/App.tsx", "src/api.ts", "README.md"];

describe("TextSearchPalette", () => {
  // Mantine's focus trap focuses [data-autofocus] from a setTimeout, so the
  // focus lands a tick after render rather than synchronously.
  it("opens focused with no results for an empty query", async () => {
    render(
      <TextSearchPalette files={files} onSearchText={vi.fn()} onSelect={vi.fn()} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId("text-search-input")).toHaveFocus());
    expect(screen.queryAllByTestId("text-search-file-result")).toHaveLength(0);
    expect(screen.queryAllByTestId("text-search-text-result")).toHaveLength(0);
  });

  it("ranks fuzzy filename matches as you type", async () => {
    render(
      <TextSearchPalette
        files={files}
        onSearchText={vi.fn().mockResolvedValue({ matches: [], truncated: false })}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("text-search-input"), { target: { value: "apptsx" } });
    await waitFor(() => expect(screen.getAllByTestId("text-search-file-result")[0]).toHaveTextContent("src/App.tsx"));
  });

  it("shows text-content matches from the search backend", async () => {
    const matches: TextMatch[] = [{ path: "src/api.ts", line: 12, text: "export const foo = 1;" }];
    render(
      <TextSearchPalette
        files={files}
        onSearchText={vi.fn().mockResolvedValue({ matches, truncated: false })}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("text-search-input"), { target: { value: "foo" } });
    await waitFor(() =>
      expect(screen.getByTestId("text-search-text-result")).toHaveTextContent("src/api.ts:12"),
    );
    expect(screen.getByTestId("text-search-text-result")).toHaveTextContent("export const foo = 1;");
  });

  it("opens the active result on Enter and closes", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TextSearchPalette
        files={files}
        onSearchText={vi.fn().mockResolvedValue({ matches: [], truncated: false })}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByTestId("text-search-input"), { target: { value: "apptsx" } });
    await waitFor(() => expect(screen.getAllByTestId("text-search-file-result")).toHaveLength(1));

    fireEvent.keyDown(screen.getByTestId("text-search-input"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("src/App.tsx");
    expect(onClose).toHaveBeenCalled();
  });

  it("moves the active result with ArrowDown across both sections", async () => {
    const matches: TextMatch[] = [{ path: "src/api.ts", line: 1, text: "readme mention" }];
    const onSelect = vi.fn();
    render(
      <TextSearchPalette
        files={files}
        onSearchText={vi.fn().mockResolvedValue({ matches, truncated: false })}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("text-search-input"), { target: { value: "readme" } });
    await waitFor(() => expect(screen.getAllByTestId("text-search-file-result")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("text-search-text-result")).toHaveLength(1));

    fireEvent.keyDown(screen.getByTestId("text-search-input"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByTestId("text-search-input"), { key: "Enter" });
    // A content match opens the file *at its line* — that number came back
    // with the result and used to be dropped on the floor.
    expect(onSelect).toHaveBeenCalledWith("src/api.ts", 1);
  });

  it("passes the case/word/regex toggles through to the backend", async () => {
    const onSearchText = vi.fn().mockResolvedValue({ matches: [], truncated: false });
    render(
      <TextSearchPalette
        files={files}
        onSearchText={onSearchText}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("text-search-input"), { target: { value: "count" } });
    await waitFor(() => expect(onSearchText).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("search-whole-word"));
    await waitFor(() =>
      expect(onSearchText).toHaveBeenLastCalledWith("count", {
        regex: false,
        caseSensitive: false,
        wholeWord: true,
      }),
    );

    fireEvent.click(screen.getByTestId("search-regex"));
    await waitFor(() =>
      expect(onSearchText).toHaveBeenLastCalledWith("count", {
        regex: true,
        caseSensitive: false,
        wholeWord: true,
      }),
    );
  });

  it("says so when the backend cut the result list short", async () => {
    const matches: TextMatch[] = [{ path: "src/api.ts", line: 1, text: "hit" }];
    render(
      <TextSearchPalette
        files={files}
        onSearchText={vi.fn().mockResolvedValue({ matches, truncated: true })}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("text-search-input"), { target: { value: "hit" } });

    await waitFor(() => expect(screen.getByTestId("text-search-truncated")).toBeDefined());
  });

  it("shows a half-typed regex as an error rather than 'no matches'", async () => {
    render(
      <TextSearchPalette
        files={[]}
        onSearchText={vi.fn().mockRejectedValue(new Error("invalid search pattern: unclosed group"))}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId("text-search-input"), { target: { value: "(foo" } });

    await waitFor(() => expect(screen.getByTestId("text-search-error")).toBeDefined());
    expect(screen.getByTestId("text-search-error").textContent).toContain("invalid search pattern");
    expect(screen.queryByTestId("text-search-empty")).toBeNull();
  });

  it("waits for a pause in typing instead of searching on every keystroke", async () => {
    const onSearchText = vi.fn().mockResolvedValue({ matches: [], truncated: false });
    render(
      <TextSearchPalette
        files={[]}
        onSearchText={onSearchText}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByTestId("text-search-input");
    fireEvent.change(input, { target: { value: "n" } });
    fireEvent.change(input, { target: { value: "ne" } });
    fireEvent.change(input, { target: { value: "nee" } });
    fireEvent.change(input, { target: { value: "need" } });

    await waitFor(() => expect(onSearchText).toHaveBeenCalled());
    // One walk of the project, for the query that was actually settled on.
    expect(onSearchText).toHaveBeenCalledTimes(1);
    expect(onSearchText).toHaveBeenCalledWith("need", expect.anything());
  });

  it("dismisses on Escape without selecting", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <TextSearchPalette files={files} onSearchText={vi.fn()} onSelect={onSelect} onClose={onClose} />,
    );
    fireEvent.keyDown(screen.getByTestId("text-search-input"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
