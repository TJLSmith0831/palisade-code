import { describe, expect, it } from "vitest";
import type { Message } from "../api";
import { mergeRefreshed } from "../messageMerge";

const msg = (seq: number, role: string, content = ""): Message =>
  ({ seq, ts: "", role, mode: "spec", content }) as Message;
const OPT = -1;

describe("mergeRefreshed", () => {
  it("keeps the user's optimistic bubble while the backend hasn't stored its row", () => {
    const prev = [msg(OPT, "user", "Show a count")];
    const merged = mergeRefreshed(prev, [msg(1, "system", "Switched to spec mode")], OPT);
    expect(merged.map((m) => m.content)).toEqual(["Switched to spec mode", "Show a count"]);
  });

  it("drops it once the real user row has landed", () => {
    const prev = [msg(OPT, "user", "Show a count")];
    const merged = mergeRefreshed(prev, [msg(1, "user", "Show a count")], OPT);
    expect(merged).toEqual([msg(1, "user", "Show a count")]);
  });

  it("does not resurrect a bubble when an older page is kept alongside newer history", () => {
    const prev = [msg(1, "user", "a"), msg(2, "assistant", "b")];
    const merged = mergeRefreshed(prev, [msg(2, "assistant", "b"), msg(3, "user", "c")], OPT);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3]);
  });
});
