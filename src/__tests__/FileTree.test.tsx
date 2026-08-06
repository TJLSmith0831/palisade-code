import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn((cmd: string, args?: Record<string, unknown>) => {
  if (cmd === "list_directory") {
    if (args?.projectHash === "bad") return Promise.reject(new Error("no such file or directory"));
    return Promise.resolve([{ name: "README.md", is_dir: false, path: "README.md" }]);
  }
  return Promise.reject(new Error(`unexpected command ${cmd}`));
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: [string, Record<string, unknown>?]) => invokeMock(...args),
}));

import FileTree from "../FileTree";

describe("FileTree", () => {
  it("clears a stale error from the previous project when the project switches", async () => {
    const { rerender } = render(
      <FileTree projectHash="bad" projectName="broken-project" onSelectFile={vi.fn()} activePath={null} />,
    );
    await waitFor(() => expect(screen.getByText(/no such file or directory/i)).toBeDefined());

    rerender(<FileTree projectHash="good" projectName="good-project" onSelectFile={vi.fn()} activePath={null} />);

    await waitFor(() => expect(screen.getByText("README.md")).toBeDefined());
    expect(screen.queryByText(/no such file or directory/i)).toBeNull();
  });
});
