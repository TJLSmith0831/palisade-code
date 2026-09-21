import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect } from "react";

/**
 * Decides what a click on an `<a>` does — and it is never "navigate this
 * window". A link in an agent's message used to load its target straight into
 * Palisade's own webview, replacing the whole app with the page.
 *
 *  - `http(s)` link: opens in the Preview pane; ⌘/Ctrl-click opens the user's
 *    default browser instead.
 *  - `mailto:` and `tel:`: handed to the OS. Any other scheme (`javascript:`,
 *    `file:`, …) is swallowed — it is not a link Palisade should follow.
 *  - `#anchor`: left to the page.
 *  - a relative link (a file path in Markdown): swallowed. It resolves against
 *    the app's own origin and is not a web page.
 */
export function routeLinkClick(
  event: MouseEvent,
  openInPreview: (url: string) => void,
  openExternally: (url: string) => void = (url) => void openUrl(url).catch(() => {})
): void {
  const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor) return;
  const href = anchor.getAttribute("href") ?? "";
  if (href.startsWith("#")) return;

  event.preventDefault();

  let url: URL;
  try {
    url = new URL(anchor.href);
  } catch {
    return;
  }
  if (url.origin === window.location.origin) return;

  if (url.protocol === "http:" || url.protocol === "https:") {
    if (event.metaKey || event.ctrlKey) openExternally(url.toString());
    else openInPreview(url.toString());
    return;
  }
  if (url.protocol === "mailto:" || url.protocol === "tel:") openExternally(url.toString());
}

/** Installs `routeLinkClick` for the whole document. */
export function useLinkRouting(openInPreview: (url: string) => void) {
  useEffect(() => {
    const onClick = (event: MouseEvent) => routeLinkClick(event, openInPreview);
    // A middle-click would open a new window, which a webview turns into a navigation.
    const onAuxClick = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.("a[href]")) event.preventDefault();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onAuxClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onAuxClick, true);
    };
  }, [openInPreview]);
}
