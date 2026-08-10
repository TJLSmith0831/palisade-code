import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import "../App.css";
import { EventList, filterForTab, type Item } from "../EventView";

const chatItem: Item = {
  kind: "plain",
  role: "assistant",
  mode: "spec",
  text: "hi",
};
const editItem: Item = {
  kind: "fileEdit",
  id: "1",
  path: "a.ts",
  before: "x",
  after: "y",
};

const renderWithMantine = (ui: React.ReactElement) =>
  render(ui, { wrapper: MantineProvider });

describe("filterForTab", () => {
  it("keeps everything for the chat tab", () => {
    expect(filterForTab([chatItem, editItem], "chat")).toEqual([
      chatItem,
      editItem,
    ]);
  });

  it("keeps only file edits for the diff tab", () => {
    expect(filterForTab([chatItem, editItem], "diff")).toEqual([editItem]);
  });
});

describe("EventList markdown rendering", () => {
  it("renders markdown emphasis as real elements, not literal asterisks", () => {
    const items: Item[] = [{ kind: "text", text: "**bold** and *italic*" }];
    renderWithMantine(
      <EventList items={items} showThinking={false} executor={null} />
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
  });

  it("renders file diffs at full width", () => {
    renderWithMantine(
      <EventList items={[editItem]} showThinking={false} executor={null} />
    );
    expect(getComputedStyle(screen.getByTestId("file-edit")).width).toBe(
      "100%"
    );
  });
});

describe("ToolBlock rendering", () => {
  const toolCallItem: Item = {
    kind: "toolCall",
    id: "t1",
    name: "Bash",
    command: "echo hello\necho world",
  };
  const toolResultItem: Item = {
    kind: "toolResult",
    id: "t1",
    output: "hello\nworld",
    isError: false,
  };
  const failedResultItem: Item = {
    kind: "toolResult",
    id: "t1",
    output: "command not found",
    isError: true,
  };

  it("renders the tool name as a badge and command preview in the header", () => {
    renderWithMantine(
      <EventList items={[toolCallItem]} showThinking={false} executor={null} />
    );
    const block = screen.getByTestId("tool-block");
    expect(block).toBeDefined();
    expect(screen.getByText("Bash")).toBeDefined();
    // Command preview shows the first line
    expect(screen.getByText("echo hello")).toBeDefined();
  });

  it("shows a running indicator when no output has arrived", () => {
    renderWithMantine(
      <EventList items={[toolCallItem]} showThinking={false} executor={null} />
    );
    expect(screen.getByTestId("tool-status-running")).toBeDefined();
  });

  it("shows a success indicator when output arrived with isError false", () => {
    renderWithMantine(
      <EventList
        items={[toolCallItem, toolResultItem]}
        showThinking={false}
        executor={null}
      />
    );
    expect(screen.getByTestId("tool-status-success")).toBeDefined();
  });

  it("shows a failed indicator when output arrived with isError true", () => {
    renderWithMantine(
      <EventList
        items={[toolCallItem, failedResultItem]}
        showThinking={false}
        executor={null}
      />
    );
    expect(screen.getByTestId("tool-status-failed")).toBeDefined();
  });

  it("hides the body by default and expands on header click", () => {
    renderWithMantine(
      <EventList
        items={[toolCallItem, toolResultItem]}
        showThinking={false}
        executor={null}
      />
    );
    // Collapse renders children but hides them; the chevron points right when closed
    expect(screen.getByTestId("tool-block-closed-chev")).toBeDefined();
    // Click the header to expand
    fireEvent.click(screen.getByTestId("tool-block-header"));
    // Now the chevron points down and the full command/output are present
    expect(screen.getByTestId("tool-block-open-chev")).toBeDefined();
    const cmd = screen.getByTestId("tool-block-command");
    const out = screen.getByTestId("tool-block-output");
    expect(cmd.textContent).toBe("echo hello\necho world");
    expect(out.textContent).toBe("hello\nworld");
  });

  it("applies a danger border to failed tool blocks", () => {
    renderWithMantine(
      <EventList
        items={[toolCallItem, failedResultItem]}
        showThinking={false}
        executor={null}
      />
    );
    const block = screen.getByTestId("tool-block");
    const border = getComputedStyle(block).borderColor;
    // The border color should be set (not empty/transparent) for failed blocks
    expect(border).not.toBe("");
    expect(border).not.toBe("transparent");
  });
});

describe("EventList chat spacing", () => {
  it("uses normal white-space so markdown reflows instead of preserving literal newlines", () => {
    const items: Item[] = [{ kind: "text", text: "line one\nline two" }];
    const { container } = renderWithMantine(
      <EventList items={items} showThinking={false} executor={null} />
    );
    const content = container.querySelector(".message .content");
    expect(content).not.toBeNull();
    expect(getComputedStyle(content!).whiteSpace).toBe("normal");
  });

  it("gives headings compact chat-app margins, not GitHub's 24px/16px", () => {
    const items: Item[] = [
      { kind: "text", text: "intro text\n\n## heading\n\nafter text" },
    ];
    const { container } = renderWithMantine(
      <EventList items={items} showThinking={false} executor={null} />
    );
    const heading = container.querySelector(".message .content h2");
    expect(heading).not.toBeNull();
    const style = getComputedStyle(heading!);
    expect(style.marginTop).toBe("12px");
    expect(style.marginBottom).toBe("6px");
  });

  it("gives paragraphs an 8px bottom margin", () => {
    const items: Item[] = [{ kind: "text", text: "first paragraph\n\nsecond" }];
    const { container } = renderWithMantine(
      <EventList items={items} showThinking={false} executor={null} />
    );
    const p = container.querySelector(".message .content p");
    expect(p).not.toBeNull();
    expect(getComputedStyle(p!).marginBottom).toBe("8px");
  });

  it("gives list items a 4px bottom margin", () => {
    const items: Item[] = [{ kind: "text", text: "- a\n- b\n- c" }];
    const { container } = renderWithMantine(
      <EventList items={items} showThinking={false} executor={null} />
    );
    const li = container.querySelector(".message .content li");
    expect(li).not.toBeNull();
    expect(getComputedStyle(li!).marginBottom).toBe("4px");
  });
});
