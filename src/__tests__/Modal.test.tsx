import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import Modal from "../Modal";

describe("Modal", () => {
  it("renders with dialog semantics", () => {
    render(
      <Modal onClose={vi.fn()} label="Test dialog">
        <button>First</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Test dialog");
  });

  it("traps Tab focus within the dialog, wrapping last -> first and first -> last on Shift+Tab", () => {
    render(
      <Modal onClose={vi.fn()} label="Test dialog">
        <button>First</button>
        <button>Second</button>
        <button>Last</button>
      </Modal>,
    );
    const [first, , last] = screen.getAllByRole("button");

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("doesn't steal focus from a child that already claimed it via autoFocus", () => {
    render(
      <Modal onClose={vi.fn()} label="Test dialog">
        <button>First</button>
        <input autoFocus placeholder="already focused" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByPlaceholderText("already focused"));
  });

  it("closes on overlay click but not on a click inside the dialog", () => {
    const onClose = vi.fn();
    render(
      <Modal onClose={onClose} label="Test dialog">
        <button data-testid="inner">Inner</button>
      </Modal>,
    );

    fireEvent.click(screen.getByTestId("inner"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
