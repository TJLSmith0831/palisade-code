import { describe, expect, it } from "vitest";
import { deriveStage } from "../stage";

describe("deriveStage", () => {
  it("returns 'exploring' for spec-mode with no change", () => {
    expect(deriveStage("spec", false, null)).toBe("exploring");
  });

  it("returns 'proposing' for spec-mode with a change, status not complete", () => {
    expect(deriveStage("spec", true, false)).toBe("proposing");
  });

  it("returns 'proposing' for spec-mode with a change, status unknown", () => {
    expect(deriveStage("spec", true, null)).toBe("proposing");
  });

  it("returns 'ready_to_apply' for spec-mode with a complete change", () => {
    expect(deriveStage("spec", true, true)).toBe("ready_to_apply");
  });

  it("returns 'implementing' for go-mode regardless of change", () => {
    expect(deriveStage("go", false, null)).toBe("implementing");
    expect(deriveStage("go", true, true)).toBe("implementing");
  });

  it("returns 'chat' for unknown modes", () => {
    expect(deriveStage("chat", false, null)).toBe("chat");
  });
});
