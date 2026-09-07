import type { KeyboardEvent } from "react";

/** Enter/Space activation for a `role="button"` element that isn't a real `<button>`. */
export const onActivateKey =
  (handler: (event: KeyboardEvent<HTMLElement>) => void) =>
  (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    // Forwarded so a handler can read modifiers — ⌘-Enter has to mean what
    // ⌘-click means, or the keyboard path is a lesser version of the mouse.
    handler(event);
  };
