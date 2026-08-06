import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import DiffPane from "../DiffPane";

const ONE_HUNK_DIFF = `diff --git a/tracked.txt b/tracked.txt
index 1234567..89abcde 100644
--- a/tracked.txt
+++ b/tracked.txt
@@ -1,3 +1,3 @@
 line one
-line two
+CHANGED
 line three
`;

type Handler = (cmd: string, args?: Record<string, unknown>) => Promise<unknown> | undefined;

/** Sensible defaults (a normal repo, nothing to sync) layered under test-specific handlers. */
function mockGit(handler: Handler) {
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    const custom = handler(cmd, args);
    if (custom !== undefined) return custom;
    if (cmd === "git_is_repo") return Promise.resolve(true);
    if (cmd === "git_ahead_behind") return Promise.resolve(null);
    if (cmd === "git_status") return Promise.resolve([]);
    if (cmd === "git_working_diff") return Promise.resolve("");
    if (cmd === "git_staged_diff") return Promise.resolve("");
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
}

describe("DiffPane", () => {
  afterEach(() => {
    invokeMock.mockReset();
  });

  it("shows the empty state when the working tree is clean", async () => {
    mockGit(() => undefined);

    render(<DiffPane projectHash="proj-1" />);
    await waitFor(() => expect(screen.getByText(/working tree clean/i)).toBeDefined());
  });

  it("stages a hunk: calls git_stage_hunk with a valid patch, then reflects staged state after refresh", async () => {
    const user = userEvent.setup();
    let staged = false;
    mockGit((cmd, args) => {
      if (cmd === "git_working_diff") return Promise.resolve(staged ? "" : ONE_HUNK_DIFF);
      if (cmd === "git_staged_diff") return Promise.resolve(staged ? ONE_HUNK_DIFF : "");
      if (cmd === "git_stage_hunk") {
        expect(args?.patch).toContain("+CHANGED");
        staged = true;
        return Promise.resolve();
      }
      return undefined;
    });

    render(<DiffPane projectHash="proj-1" />);
    await waitFor(() => expect(screen.getByTestId("changes-section")).toBeDefined());
    expect(screen.queryByTestId("staged-section")).toBeNull();

    await user.click(screen.getByTestId("hunk-action-btn"));

    await waitFor(() => expect(screen.getByTestId("staged-section")).toBeDefined());
    expect(screen.queryByTestId("changes-section")).toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("git_stage_hunk", expect.objectContaining({ projectHash: "proj-1" }));
  });

  it("unstages a hunk: calls git_unstage_hunk, then it moves back to Changes", async () => {
    const user = userEvent.setup();
    let staged = true;
    mockGit((cmd, args) => {
      if (cmd === "git_working_diff") return Promise.resolve(staged ? "" : ONE_HUNK_DIFF);
      if (cmd === "git_staged_diff") return Promise.resolve(staged ? ONE_HUNK_DIFF : "");
      if (cmd === "git_unstage_hunk") {
        expect(args?.patch).toContain("+CHANGED");
        staged = false;
        return Promise.resolve();
      }
      return undefined;
    });

    render(<DiffPane projectHash="proj-1" />);
    await waitFor(() => expect(screen.getByTestId("staged-section")).toBeDefined());

    await user.click(screen.getByTestId("hunk-action-btn"));

    await waitFor(() => expect(screen.getByTestId("changes-section")).toBeDefined());
    expect(screen.queryByTestId("staged-section")).toBeNull();
  });

  it("commit button is disabled with an empty message or nothing staged, enabled once both are satisfied", async () => {
    const user = userEvent.setup();
    mockGit((cmd) => {
      if (cmd === "git_staged_diff") return Promise.resolve(ONE_HUNK_DIFF);
      if (cmd === "git_commit") return Promise.resolve();
      return undefined;
    });

    render(<DiffPane projectHash="proj-1" />);
    await waitFor(() => expect(screen.getByTestId("staged-section")).toBeDefined());

    const commitBtn = screen.getByTestId("commit-btn") as HTMLButtonElement;
    expect(commitBtn.disabled).toBe(true); // nothing typed yet

    await user.type(screen.getByTestId("commit-message"), "a real message");
    expect(commitBtn.disabled).toBe(false);

    await user.click(commitBtn);
    expect(invokeMock).toHaveBeenCalledWith(
      "git_commit",
      expect.objectContaining({ projectHash: "proj-1", message: "a real message" }),
    );
  });

  it("commit button stays disabled when there is nothing staged, even with a message typed", async () => {
    const user = userEvent.setup();
    mockGit(() => undefined);

    render(<DiffPane projectHash="proj-1" />);
    await waitFor(() => expect(screen.getByText(/working tree clean/i)).toBeDefined());

    await user.type(screen.getByTestId("commit-message"), "a real message");
    expect((screen.getByTestId("commit-btn") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows Initialize Repository instead of the diff UI when the project isn't a git repo", async () => {
    mockGit((cmd) => {
      if (cmd === "git_is_repo") return Promise.resolve(false);
      return undefined;
    });

    render(<DiffPane projectHash="proj-1" />);
    await waitFor(() => expect(screen.getByTestId("init-repo-btn")).toBeDefined());
    expect(screen.queryByTestId("commit-message")).toBeNull();
  });

  it("Initialize Repository calls git_init, then shows the normal (clean) diff UI", async () => {
    const user = userEvent.setup();
    let isRepo = false;
    mockGit((cmd) => {
      if (cmd === "git_is_repo") return Promise.resolve(isRepo);
      if (cmd === "git_init") {
        isRepo = true;
        return Promise.resolve();
      }
      return undefined;
    });

    render(<DiffPane projectHash="proj-1" />);
    await waitFor(() => expect(screen.getByTestId("init-repo-btn")).toBeDefined());

    await user.click(screen.getByTestId("init-repo-btn"));

    await waitFor(() => expect(screen.getByText(/working tree clean/i)).toBeDefined());
    expect(invokeMock).toHaveBeenCalledWith("git_init", expect.objectContaining({ projectHash: "proj-1" }));
  });

  it("Pull and Push show ahead/behind counts and call the right commands", async () => {
    const user = userEvent.setup();
    mockGit((cmd) => {
      if (cmd === "git_ahead_behind") return Promise.resolve([2, 3]);
      if (cmd === "git_pull") return Promise.resolve("");
      if (cmd === "git_push") return Promise.resolve("");
      if (cmd === "git_fetch") return Promise.resolve();
      return undefined;
    });

    render(<DiffPane projectHash="proj-1" />);
    await waitFor(() => expect(screen.getByTestId("pull-btn").textContent).toContain("3"));
    expect(screen.getByTestId("push-btn").textContent).toContain("2");

    await user.click(screen.getByTestId("fetch-btn"));
    expect(invokeMock).toHaveBeenCalledWith("git_fetch", expect.objectContaining({ projectHash: "proj-1" }));

    await user.click(screen.getByTestId("pull-btn"));
    expect(invokeMock).toHaveBeenCalledWith("git_pull", expect.objectContaining({ projectHash: "proj-1" }));

    await user.click(screen.getByTestId("push-btn"));
    expect(invokeMock).toHaveBeenCalledWith("git_push", expect.objectContaining({ projectHash: "proj-1" }));
  });

  it("discarding a file's changes asks for confirmation before calling git_discard_file", async () => {
    const user = userEvent.setup();
    let discarded = false;
    mockGit((cmd, args) => {
      if (cmd === "git_working_diff") return Promise.resolve(discarded ? "" : ONE_HUNK_DIFF);
      if (cmd === "git_discard_file") {
        expect(args).toMatchObject({ projectHash: "proj-1", path: "tracked.txt", untracked: false });
        discarded = true;
        return Promise.resolve();
      }
      return undefined;
    });

    render(<DiffPane projectHash="proj-1" />);
    await waitFor(() => expect(screen.getByTestId("discard-btn")).toBeDefined());

    await user.click(screen.getByTestId("discard-btn"));
    // Confirmation required — no call yet.
    expect(invokeMock).not.toHaveBeenCalledWith("git_discard_file", expect.anything());

    await user.click(screen.getByTestId("confirm-discard"));

    await waitFor(() => expect(screen.getByText(/working tree clean/i)).toBeDefined());
  });
});
