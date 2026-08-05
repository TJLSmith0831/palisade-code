import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EventList, filterForTab, type Item } from "../EventView";

const chatItem: Item = { kind: "plain", role: "assistant", mode: "spec", text: "hi" };
const editItem: Item = { kind: "fileEdit", id: "1", path: "a.ts", before: "x", after: "y" };

describe("filterForTab", () => {
  it("keeps everything for the chat tab", () => {
    expect(filterForTab([chatItem, editItem], "chat")).toEqual([chatItem, editItem]);
  });

  it("keeps only file edits for the diff tab", () => {
    expect(filterForTab([chatItem, editItem], "diff")).toEqual([editItem]);
  });
});

describe("EventList markdown rendering", () => {
  it("renders markdown emphasis as real elements, not literal asterisks", () => {
    const items: Item[] = [{ kind: "text", text: "**bold** and *italic*" }];
    render(<EventList items={items} showThinking={false} executor={null} />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
  });
});
