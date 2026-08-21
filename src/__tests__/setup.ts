import "@testing-library/jest-dom/vitest";

// jsdom has no layout engine, so Range doesn't implement rect measurement.
// CodeMirror 6 calls these every animation frame to measure text; without a
// polyfill it throws (see clientRectsFor in @codemirror/view).
Range.prototype.getClientRects = () => ({
  length: 0,
  item: () => null,
  [Symbol.iterator]: function* () {},
}) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => ({
  x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON() {},
});

// jsdom has no ResizeObserver (it has no layout to observe). TerminalPane
// uses one to refit xterm on container resize — a no-op stub is enough for
// tests, which never rely on a real resize firing.
// jsdom has no layout, so Element.scrollIntoView is unimplemented. Mantine's
// Select/Combobox calls it when the keyboard-highlighted option changes.
Element.prototype.scrollIntoView ??= () => {};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// jsdom has no rendering engine, so it can't evaluate media queries.
// TerminalPane listens for an OS light/dark change to re-theme xterm — a
// stub that never fires is enough for tests, which don't simulate that.
window.matchMedia ??=
  ((query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
