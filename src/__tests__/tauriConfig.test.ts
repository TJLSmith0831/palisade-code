import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const config = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../src-tauri/tauri.conf.json"),
    "utf-8",
  ),
);
const capabilities = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../src-tauri/capabilities/default.json"),
    "utf-8",
  ),
);

describe("Tauri window config (merged-design v2)", () => {
  it("has decorations disabled for CSS window shell", () => {
    const win = config.app.windows[0];
    expect(win.decorations).toBe(false);
  });

  it("allows the close-request listener to destroy a confirmed window", () => {
    expect(capabilities.permissions).toContain("core:window:allow-destroy");
  });

  it("has minimum window size set", () => {
    const win = config.app.windows[0];
    expect(win.minWidth).toBeGreaterThanOrEqual(800);
    expect(win.minHeight).toBeGreaterThanOrEqual(500);
  });

  it("has titleBarStyle transparent for macOS", () => {
    const win = config.app.windows[0];
    expect(win.titleBarStyle).toBe("Transparent");
  });
});
