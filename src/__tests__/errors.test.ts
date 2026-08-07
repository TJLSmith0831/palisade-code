import { describe, expect, it } from "vitest";
import { describeError } from "../errors";

describe("describeError", () => {
  it("prefixes a plain string error with a friendly lead-in, keeping the raw detail", () => {
    expect(describeError("no such file or directory: a.txt")).toBe(
      "Couldn't complete that — no such file or directory: a.txt",
    );
  });

  it("uses an Error's message, not its stringified 'Error: ...' form", () => {
    expect(describeError(new Error("network timeout"))).toBe("Couldn't complete that — network timeout");
  });

  it("falls back to String() for non-Error, non-string values", () => {
    expect(describeError(404)).toBe("Couldn't complete that — 404");
  });
});
