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
