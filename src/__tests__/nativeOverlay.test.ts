import { describe, expect, it } from "vitest";
import { overlayCovers } from "../nativeOverlay";

const preview = { x: 800, y: 100, width: 300, height: 700 };

/** A stand-in for an open overlay: getBoundingClientRect is all it reads. */
const overlay = (className: string, rect: { left: number; top: number; width: number; height: number }) => {
  const el = document.createElement("div");
  el.className = className;
  el.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top }) as DOMRect;
  document.body.appendChild(el);
  return el;
};

describe("overlayCovers", () => {
  it("is false with nothing open", () => {
    expect(overlayCovers(preview)).toBe(false);
  });

  it("is true for a modal that spans the window", () => {
    const el = overlay("mantine-Modal-root", { left: 0, top: 0, width: 1280, height: 800 });
    expect(overlayCovers(preview)).toBe(true);
    el.remove();
  });

  it("is true for a menu that hangs down over the pane", () => {
    const el = overlay("mantine-Menu-dropdown", { left: 780, top: 90, width: 160, height: 120 });
    expect(overlayCovers(preview)).toBe(true);
    el.remove();
  });

  it("is true for a tooltip over the pane", () => {
    const el = overlay("", { left: 780, top: 90, width: 160, height: 32 });
    el.setAttribute("role", "tooltip");
    expect(overlayCovers(preview)).toBe(true);
    el.remove();
  });

  it("ignores an overlay that sits beside the pane", () => {
    const el = overlay("mantine-Popover-dropdown", { left: 20, top: 90, width: 200, height: 300 });
    expect(overlayCovers(preview)).toBe(false);
    el.remove();
  });

  it("ignores a mounted-but-closed overlay with no size", () => {
    const el = overlay("mantine-Modal-root", { left: 0, top: 0, width: 0, height: 0 });
    expect(overlayCovers(preview)).toBe(false);
    el.remove();
  });
});
