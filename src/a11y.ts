import type { KeyboardEvent } from "react";

/** Enter/Space activation for a `role="button"` element that isn't a real `<button>`. */
export const onActivateKey =
  (handler: () => void) => (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handler();
  };
