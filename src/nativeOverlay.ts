/** Open overlays that can land on top of the Preview pane's native webview:
 * Mantine's modals, drawers, menus, popovers, select lists and tooltips (all
 * portalled to `<body>`). The native view sits in front of the app's webview
 * so it takes clicks; while one of these overlaps it, it moves behind instead
 * so the overlay draws on top. */
const OVERLAYS = [
  ".mantine-Modal-root",
  ".mantine-Drawer-root",
  ".mantine-Menu-dropdown",
  ".mantine-Popover-dropdown",
  ".mantine-Combobox-dropdown",
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
].join(",");

type Box = { x: number; y: number; width: number; height: number };

/** True when a visible overlay overlaps `box` (window CSS pixels). */
export function overlayCovers(box: Box, root: ParentNode = document): boolean {
  for (const el of root.querySelectorAll(OVERLAYS)) {
    const r = el.getBoundingClientRect();
    // A closed-but-mounted overlay has no size.
    if (r.width < 1 || r.height < 1) continue;
    if (r.left < box.x + box.width && r.right > box.x && r.top < box.y + box.height && r.bottom > box.y) {
      return true;
    }
  }
  return false;
}

const HOLE_PROPS = [
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "background-repeat",
  "background-origin",
];

/** Makes `box` (window CSS pixels) see-through in `el` and everything painted
 * under it — its ancestors, and backdrops like `#backdrop` that aren't — so a
 * native view placed behind the app's webview shows there. Each such element
 * keeps its colour everywhere else, painted as four strips around the hole.
 * Returns the undo.
 * ponytail: solid background colours only; an ancestor with a background
 * image over the preview would need its image kept as an extra layer. */
export function punchHole(el: Element, box: Box): () => void {
  const restore: (() => void)[] = [];
  // Topmost first, so whatever follows `el` is painted beneath it; overlays
  // above it are left alone. jsdom has no hit testing: fall back to ancestors.
  const hits = document.elementsFromPoint?.(box.x + box.width / 2, box.y + box.height / 2) ?? [];
  const under = hits.includes(el) ? hits.slice(hits.indexOf(el)) : [];
  if (!under.length) for (let node: Element | null = el; node; node = node.parentElement) under.push(node);
  for (const node of under as HTMLElement[]) {
    const color = getComputedStyle(node).backgroundColor;
    if (!color || color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color)) continue;
    const r = node.getBoundingClientRect();
    const x = Math.max(0, box.x - r.left);
    const y = Math.max(0, box.y - r.top);
    const right = Math.max(0, r.width - x - box.width);
    const bottom = Math.max(0, r.height - y - box.height);
    const fill = `linear-gradient(${color}, ${color})`;
    const saved = HOLE_PROPS.map((prop) => [prop, node.style.getPropertyValue(prop)] as const);
    restore.push(() => {
      for (const [prop, value] of saved) {
        if (value) node.style.setProperty(prop, value);
        else node.style.removeProperty(prop);
      }
    });
    node.style.setProperty("background-color", "transparent");
    node.style.setProperty("background-image", [fill, fill, fill, fill].join(", "));
    node.style.setProperty("background-repeat", "no-repeat");
    node.style.setProperty("background-origin", "border-box");
    node.style.setProperty(
      "background-size",
      `100% ${y}px, 100% ${bottom}px, ${x}px ${box.height}px, ${right}px ${box.height}px`,
    );
    node.style.setProperty("background-position", `0 0, 0 100%, 0 ${y}px, 100% ${y}px`);
  }
  return () => restore.forEach((undo) => undo());
}
