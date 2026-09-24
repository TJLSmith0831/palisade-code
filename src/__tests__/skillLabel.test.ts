import { describe, expect, it } from "vitest";
import { displaySkillCommand } from "../skillLabel";

describe("displaySkillCommand", () => {
  it("hides the skill name for stored apply and propose turns", () => {
    expect(displaySkillCommand("grill-apply add-search-clear-button")).toBe("Build **Add search clear button**");
    expect(displaySkillCommand("grill-apply")).toBe("Build the proposal");
    expect(displaySkillCommand("grill-propose")).toBe("Write up the proposal");
  });
  it("leaves anything the user actually typed alone", () => {
    expect(displaySkillCommand("please grill-apply this")).toBe("please grill-apply this");
    expect(displaySkillCommand("fix it")).toBe("fix it");
  });
});
