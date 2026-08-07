import { describe, expect, it } from "vitest";
import { shouldRedraw } from "../GraphView";

describe("shouldRedraw", () => {
  it("stops the paint loop once the simulation has settled and nothing else changed", () => {
    expect(shouldRedraw({ simulationAlpha: 0.0005, alphaMin: 0.001, dirty: false })).toBe(false);
  });

  it("keeps painting while the force simulation is still moving nodes", () => {
    expect(shouldRedraw({ simulationAlpha: 0.5, alphaMin: 0.001, dirty: false })).toBe(true);
  });

  it("keeps painting when something else changed (pan/zoom/resize) even if the simulation settled", () => {
    expect(shouldRedraw({ simulationAlpha: 0.0005, alphaMin: 0.001, dirty: true })).toBe(true);
  });
});
