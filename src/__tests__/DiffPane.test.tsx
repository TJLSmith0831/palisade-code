import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";

const render = (ui: ReactElement) => rtlRender(ui, { wrapper: MantineProvider });

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

  it("uses h2 for section headings, not h4 (no h1-h3 exists above these panes)", async () => {
    mockGit((cmd) => {
      if (cmd === "git_working_diff") return Promise.resolve(ONE_HUNK_DIFF);
      return undefined;
    });
    render(<DiffPane projectHash="proj-1" />);
    await waitFor(() => expect(screen.getByTestId("changes-section")).toBeDefined());
    expect(screen.getByText("Changes").tagName).toBe("H2");
    expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
  });


  it("is a diff viewer, not a second commit surface", async () => {
    // The Source Control panel owns commit, fetch/pull/push (Amendment 7).
    // This pane used to carry its own copies, which sat right beside the
    // panel's when a change was clicked open.
    mockGit(() => undefined);
    render(<DiffPane projectHash="p1" />);
    await screen.findByTestId("diff-pane");
    expect(screen.queryByTestId("commit-btn")).toBeNull();
    expect(screen.queryByTestId("commit-message")).toBeNull();
    expect(screen.queryByTestId("fetch-btn")).toBeNull();
    expect(screen.queryByTestId("pull-btn")).toBeNull();
    expect(screen.queryByTestId("push-btn")).toBeNull();
  });

  it("shows one file when focused, and everything again when cleared", async () => {
    const onClearFocus = vi.fn();
    mockGit((cmd) => {
      if (cmd === "git_status")
        return [
          { path: "a.ts", code: " M" },
          { path: "b.ts", code: " M" },
        ];
      if (cmd === "git_working_diff")
        return [
          "diff --git a/a.ts b/a.ts",
          "--- a/a.ts",
          "+++ b/a.ts",
          "@@ -1 +1 @@",
          "-one",
          "+ONE",
          "diff --git a/b.ts b/b.ts",
          "--- a/b.ts",
          "+++ b/b.ts",
          "@@ -1 +1 @@",
          "-two",
          "+TWO",
        ].join("\n");
      return undefined;
    });

    render(
      <DiffPane projectHash="p1" focusPath="a.ts" onClearFocus={onClearFocus} />
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("diff-file")).toHaveLength(1)
    );
    expect(screen.getByTestId("diff-focus-bar").textContent).toContain("a.ts");

    fireEvent.click(screen.getByTestId("diff-show-all"));
    expect(onClearFocus).toHaveBeenCalled();
  });
});

describe("DiffPane worktree review", () => {
  it("reads the named thread's worktree, not the project root", async () => {
    mockGit((cmd) => {
      if (cmd === "git_working_diff") return Promise.resolve(ONE_HUNK_DIFF);
      return undefined;
    });

    render(<DiffPane projectHash="p1" threadId="t1" />);
    await waitFor(() => expect(screen.getAllByTestId("diff-file")).toHaveLength(1));

    const call = invokeMock.mock.calls.find(([cmd]) => cmd === "git_working_diff");
    expect(call?.[1]).toMatchObject({ projectHash: "p1", threadId: "t1" });
  });

  // Staging acts on the project root. Offering it over a worktree's diff
  // would stage a file the user is not looking at.
  it("hides staging and discarding while reviewing a worktree", async () => {
    mockGit((cmd) => {
      if (cmd === "git_working_diff") return Promise.resolve(ONE_HUNK_DIFF);
      return undefined;
    });

    render(<DiffPane projectHash="p1" threadId="t1" />);
    await waitFor(() => expect(screen.getAllByTestId("diff-file")).toHaveLength(1));

    expect(screen.queryByTestId("stage-all-btn")).toBeNull();
    expect(screen.queryByTestId("discard-btn")).toBeNull();
    expect(screen.queryByTestId("hunk-action-btn")).toBeNull();
  });

  it("keeps staging available on the project's own working tree", async () => {
    mockGit((cmd) => {
      if (cmd === "git_working_diff") return Promise.resolve(ONE_HUNK_DIFF);
      return undefined;
    });

    render(<DiffPane projectHash="p1" />);
    await waitFor(() => expect(screen.getAllByTestId("diff-file")).toHaveLength(1));

    expect(screen.getByTestId("stage-all-btn")).toBeTruthy();
    expect(screen.getByTestId("hunk-action-btn")).toBeTruthy();
  });

  it("switches between inline and side-by-side", async () => {
    mockGit((cmd) => {
      if (cmd === "git_working_diff") return Promise.resolve(ONE_HUNK_DIFF);
      return undefined;
    });

    render(<DiffPane projectHash="p1" />);
    await waitFor(() => expect(screen.getByTestId("diff-rows-inline")).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: "Side by Side" }));

    await waitFor(() => expect(screen.getByTestId("diff-rows-split")).toBeTruthy());
    expect(screen.queryByTestId("diff-rows-inline")).toBeNull();
  });
});
