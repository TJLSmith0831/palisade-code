import { describe, expect, it, vi } from "vitest";
import {
  approvedTopLevelMenus,
  createCommandBridge,
  type CommandState,
} from "../nativeMenu";

describe("native menu command bridge", () => {
  it("exposes the eight approved macOS top-level menus and dispatches only enabled commands", () => {
    expect(approvedTopLevelMenus).toEqual([
      "Palisade", "File", "Edit", "View", "Go", "Run", "Window", "Help",
    ]);

    const run = vi.fn();
    const bridge = createCommandBridge({
      "view.terminal": { enabled: true, run },
      "file.new": { enabled: false, run: vi.fn() },
    });

    expect(bridge.dispatchCommand("view.terminal")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    expect(bridge.dispatchCommand("file.new")).toBe(false);
    expect(bridge.dispatchCommand("unknown.command")).toBe(false);
    expect(bridge.menuState()).toEqual({
      "view.terminal": { enabled: true },
      "file.new": { enabled: false },
    } satisfies Record<string, CommandState>);
  });

  it("keeps dynamic labels and checked state on the same command seam", () => {
    const bridge = createCommandBridge({
      "app.checkUpdates": {
        enabled: true,
        label: "Restart to Update",
        checked: true,
        run: vi.fn(),
      },
    });

    expect(bridge.menuState()["app.checkUpdates"]).toEqual({
      enabled: true,
      checked: true,
      label: "Restart to Update",
    });
  });

  it("drops vanished recent and run rows from the published menu state", () => {
    const populated = createCommandBridge({
      "project.recent.0": { enabled: true, label: "Alpha", run: vi.fn() },
      "project.recent.1": { enabled: true, label: "Bravo", run: vi.fn() },
      "run.config.0": { enabled: true, label: "Test", run: vi.fn() },
    });
    expect(Object.keys(populated.menuState())).toEqual([
      "project.recent.0", "project.recent.1", "run.config.0",
    ]);

    // This is the next render after the focused window's project list/run
    // configuration list shrinks. The native adapter must remove the rows
    // absent from this public state instead of leaving their old actions.
    const shrunk = createCommandBridge({
      "project.recent.0": { enabled: true, label: "Alpha", run: vi.fn() },
    });
    expect(shrunk.menuState()).toEqual({
      "project.recent.0": { enabled: true, label: "Alpha" },
    });
  });
});
