import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { updateProjectSettings } from "../projectSettings";

describe("updateProjectSettings", () => {
  beforeEach(() => invokeMock.mockReset());

  it("refuses malformed non-empty settings without overwriting unrelated data", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "read_file_content") return Promise.resolve('{"formatOnSave":');
      return Promise.resolve();
    });

    await expect(
      updateProjectSettings("project", (settings) => {
        settings.verifyPins = { change: ["test"] };
      })
    ).rejects.toThrow(SyntaxError);

    expect(invokeMock).not.toHaveBeenCalledWith(
      "write_file_content",
      expect.anything()
    );
  });

  it("treats a missing or blank file as empty and guards every write", async () => {
    let reads = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command !== "read_file_content") return Promise.resolve();
      reads += 1;
      return reads === 1
        ? Promise.reject(new Error("no such file"))
        : Promise.resolve(" \n\t ");
    });

    await updateProjectSettings("project", (settings) => {
      settings.verifyPins = { change: ["test"] };
    });
    await updateProjectSettings("project", (settings) => {
      settings.appearance = {};
    });

    const writes = invokeMock.mock.calls.filter(([command]) => command === "write_file_content");
    expect(writes[0][1]).toMatchObject({
      content: expect.stringContaining('"verifyPins"'),
      expectedPrevious: null,
    });
    expect(writes[1][1]).toMatchObject({
      content: expect.stringContaining('"appearance"'),
      expectedPrevious: " \n\t ",
    });
  });
});
