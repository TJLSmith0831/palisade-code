import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

describe("api.specMode", () => {
  beforeEach(() => invokeMock.mockReset());

  it("passes specType to the spec_mode IPC command", async () => {
    invokeMock.mockResolvedValue({
      id: "t1",
      projectHash: "p1",
      title: "T",
      createdAt: "",
      updatedAt: "",
      currentMode: "spec",
      openSpecChangeName: null,
    });
    // The card frames the work; the description is the work (#35).
    await api.specMode("p1", "t1", "Feature", "a CSV export", false, true);
    expect(invokeMock).toHaveBeenCalledWith("spec_mode", {
      projectHash: "p1",
      threadId: "t1",
      specType: "Feature",
      description: "a CSV export",
      bypass: false,
      start: true,
      skills: [],
    });
  });
});
