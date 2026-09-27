import { describe, expect, it } from "vitest";
import { overlayCovers, punchHole } from "../nativeOverlay";

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

describe("punchHole", () => {
  it("clears the hole in a backdrop painted under the preview that is not its ancestor, and undoes it", () => {
    const backdrop = document.createElement("div");
    backdrop.style.backgroundColor = "rgb(220, 230, 220)";
    const frame = document.createElement("div");
    document.body.append(backdrop, frame);
    backdrop.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1280, height: 800 }) as DOMRect;
    // jsdom has no hit testing: stand in for "frame on top of backdrop".
    document.elementsFromPoint = () => [frame, backdrop];

    const undo = punchHole(frame, preview);
    expect(backdrop.style.backgroundColor, "the backdrop no longer paints over the native view").toBe("transparent");
    expect(backdrop.style.backgroundSize).toBe("100% 100px, 100% 0px, 800px 700px, 180px 700px");

    undo();
    expect(backdrop.style.backgroundColor, "its own colour is back").toBe("rgb(220, 230, 220)");
    expect(backdrop.style.backgroundImage).toBe("");
    // @ts-expect-error jsdom has none of its own
    delete document.elementsFromPoint;
    backdrop.remove();
    frame.remove();
  });
});
