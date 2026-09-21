/** Open overlays that can land on top of the Preview pane's native webview:
 * Mantine's modals, drawers, menus, popovers and select lists (all portalled
 * to `<body>`). A native view draws above every HTML element, so anything
 * matching these that overlaps it has to make it step aside. */
const OVERLAYS = [
  ".mantine-Modal-root",
  ".mantine-Drawer-root",
  ".mantine-Menu-dropdown",
  ".mantine-Popover-dropdown",
  ".mantine-Combobox-dropdown",
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
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
