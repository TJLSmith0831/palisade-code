import { expect, test, vi } from "vitest";
test("immutable account storage preserves legacy originals and isolates the same repository", async () => {
  vi.resetModules();
  window.localStorage.clear();
  const { bindProfileStorage, profileStorage } =
    await import("../profileStorage");
  window.localStorage.setItem("palisade:session:repo", "legacy");
  bindProfileStorage("a".repeat(64), true);
  expect(profileStorage.getItem("palisade:session:repo")).toBe("legacy");
  profileStorage.setItem("palisade:session:repo", "account A");
  expect(window.localStorage.getItem("palisade:session:repo")).toBe("legacy");
  expect(() => bindProfileStorage("b".repeat(64))).toThrow("Restart");
  vi.resetModules();
  const second = await import("../profileStorage");
  second.bindProfileStorage("b".repeat(64));
  expect(second.profileStorage.getItem("palisade:session:repo")).toBeNull();
  second.profileStorage.setItem("palisade:session:repo", "account B");
  expect(
    window.localStorage.getItem(
      `palisade-profile:${"a".repeat(64)}:palisade:session:repo`
    )
  ).toBe("account A");
});

test("failed preference import rolls back new copies and leaves legacy data available", async () => {
  vi.resetModules();
  window.localStorage.clear();
  const { bindProfileStorage } = await import("../profileStorage");
  window.localStorage.setItem("palisade:first", "one");
  window.localStorage.setItem("palisade:second", "two");
  const original = Storage.prototype.setItem;
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key.endsWith(":palisade:second")) throw new Error("Storage full");
      original.call(this, key, value);
    });
  try {
    expect(() => bindProfileStorage("a".repeat(64), true)).toThrow(
      "Storage full"
    );
    expect(
      Object.keys(window.localStorage).filter((key) =>
        key.startsWith("palisade-profile:")
      ),
      "partial profile copies must be removed"
    ).toEqual([]);
    expect(
      window.localStorage.getItem("palisade:first"),
      "the original remains available for retry"
    ).toBe("one");
  } finally {
    write.mockRestore();
  }
});
