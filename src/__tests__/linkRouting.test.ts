import { afterEach, describe, expect, it, vi } from "vitest";
import { routeLinkClick } from "../linkRouting";

const click = (href: string, init: MouseEventInit = {}) => {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  a.textContent = "link";
  document.body.appendChild(a);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  const preview = vi.fn();
  const external = vi.fn();
  a.addEventListener("click", (e) => routeLinkClick(e, preview, external));
  a.dispatchEvent(event);
  a.remove();
  return { event, preview, external };
};

afterEach(() => (document.body.innerHTML = ""));

describe("routeLinkClick", () => {
  it("opens an http link in Preview, and never lets the window navigate", () => {
    const { event, preview, external } = click("http://127.0.0.1:4173/");
    expect(preview).toHaveBeenCalledWith("http://127.0.0.1:4173/");
    expect(external).not.toHaveBeenCalled();
    expect(event.defaultPrevented, "the default action is what replaced the app with the page").toBe(true);
  });

  it("opens an https link in Preview too", () => {
    const { preview } = click("https://example.com/docs");
    expect(preview).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("opens the default browser instead on ⌘-click", () => {
    const { preview, external, event } = click("http://localhost:4000/", { metaKey: true });
    expect(external).toHaveBeenCalledWith("http://localhost:4000/");
    expect(preview).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens the default browser on Ctrl-click", () => {
    const { external } = click("https://example.com/", { ctrlKey: true });
    expect(external).toHaveBeenCalledWith("https://example.com/");
  });

  it("hands mailto: to the OS", () => {
    const { external, preview } = click("mailto:someone@example.com");
    expect(external).toHaveBeenCalledWith("mailto:someone@example.com");
    expect(preview).not.toHaveBeenCalled();
  });

  it("never follows javascript: or file: — swallowed, not handed to the OS", () => {
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "tauri://localhost/"]) {
      const { preview, external, event } = click(href);
      expect(preview, href).not.toHaveBeenCalled();
      expect(external, href).not.toHaveBeenCalled();
      expect(event.defaultPrevented, href).toBe(true);
    }
  });

  it("swallows a relative link: it resolves to the app's own origin, not a web page", () => {
    const { preview, external, event } = click("src/App.tsx");
    expect(preview).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves an in-page #anchor alone", () => {
    const { event, preview, external } = click("#section");
    expect(event.defaultPrevented).toBe(false);
    expect(preview).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
  });

  it("finds the link when the click lands on an element inside it", () => {
    const a = document.createElement("a");
    a.setAttribute("href", "http://localhost:5173/");
    const inner = document.createElement("code");
    a.appendChild(inner);
    document.body.appendChild(a);
    const preview = vi.fn();
    inner.addEventListener("click", (e) => routeLinkClick(e, preview, vi.fn()));
    inner.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(preview).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("ignores a click that is not on a link", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    const preview = vi.fn();
    div.addEventListener("click", (e) => routeLinkClick(e, preview, vi.fn()));
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    div.dispatchEvent(event);
    expect(preview).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
