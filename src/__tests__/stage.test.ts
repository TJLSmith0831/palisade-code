import { describe, expect, it } from "vitest";
import { deriveStage, proposeSentSinceExplore } from "../stage";
import type { Message } from "../api";

describe("deriveStage", () => {
  it("returns 'exploring' for spec-mode with no change", () => {
    expect(deriveStage("spec", false, null)).toBe("exploring");
  });

  it("returns 'proposing' as soon as Propose is sent, before the change exists", () => {
    expect(deriveStage("spec", false, null, true)).toBe("proposing");
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

describe("proposeSentSinceExplore", () => {
  const user = (content: string, explores?: string) =>
    ({ seq: 0, ts: "", role: "user", mode: "spec", content, explores }) as Message;

  it("is true once Propose follows the Explore turn", () => {
    expect(proposeSentSinceExplore([user("Add search", "Feature"), user("grill-propose")])).toBe(true);
  });

  it("is false before Propose is sent", () => {
    expect(proposeSentSinceExplore([user("Add search", "Feature")])).toBe(false);
  });

  it("ignores a Propose from before the latest Explore", () => {
    expect(
      proposeSentSinceExplore([user("Add search", "Feature"), user("grill-propose"), user("Dark mode", "Feature")])
    ).toBe(false);
  });
});
