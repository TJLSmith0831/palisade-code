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


/** The working-tree diff now lives behind its file's row, so a test that
 *  wants to see hunks opens them first — the same click a reviewer makes. */
async function expandChangedFiles() {
  const rows = await screen.findAllByTestId("diff-row-expand");
  for (const row of rows) fireEvent.click(row);
}

describe("DiffPane", () => {
  afterEach(() => {
    invokeMock.mockReset();
  });

  it("shows the empty state when the working tree is clean", async () => {
    mockGit(() => undefined);

    render(<DiffPane projectHash="proj-1" />);
    await expandChangedFiles().catch(() => undefined);
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
    await expandChangedFiles().catch(() => undefined);
    await waitFor(() => expect(screen.getByTestId("diff-scan-list")).toBeDefined());
    expect(screen.queryByTestId("staged-section")).toBeNull();

    await user.click(screen.getByTestId("hunk-action-btn"));

    await waitFor(() => expect(screen.getByTestId("staged-section")).toBeDefined());
    expect(screen.queryByTestId("diff-scan-list")).toBeNull();
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
    await expandChangedFiles().catch(() => undefined);
    await waitFor(() => expect(screen.getByTestId("staged-section")).toBeDefined());

    await user.click(screen.getByTestId("hunk-action-btn"));

    await waitFor(() => expect(screen.getByTestId("diff-scan-list")).toBeDefined());
    expect(screen.queryByTestId("staged-section")).toBeNull();
  });



  it("shows Initialize Repository instead of the diff UI when the project isn't a git repo", async () => {
    mockGit((cmd) => {
      if (cmd === "git_is_repo") return Promise.resolve(false);
      return undefined;
    });

    render(<DiffPane projectHash="proj-1" />);
    await expandChangedFiles().catch(() => undefined);
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
    await expandChangedFiles().catch(() => undefined);
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
    await expandChangedFiles().catch(() => undefined);
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
    await expandChangedFiles().catch(() => undefined);
    await waitFor(() => expect(screen.getByTestId("diff-scan-list")).toBeDefined());
    expect(screen.getByText("Changed Files").tagName).toBe("H2");
    expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
  });


  it("is a diff viewer, not a second commit surface", async () => {
    // The Source Control panel owns commit, fetch/pull/push (Amendment 7).
    // This pane used to carry its own copies, which sat right beside the
    // panel's when a change was clicked open.
    mockGit(() => undefined);
    render(<DiffPane projectHash="p1" />);
    await expandChangedFiles().catch(() => undefined);
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
      expect(screen.getAllByTestId("diff-scan-file")).toHaveLength(1)
    );
    await expandChangedFiles();
    expect(screen.getAllByTestId("diff-file")).toHaveLength(1);
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
    await expandChangedFiles().catch(() => undefined);
    await waitFor(() => expect(screen.getAllByTestId("diff-file")).toHaveLength(1));

    const call = invokeMock.mock.calls.find(([cmd]) => cmd === "git_working_diff");
    expect(call?.[1]).toMatchObject({ projectHash: "p1", threadId: "t1" });
  });

  // Staging acts on the project root. Offering it over a worktree's diff
  // would stage a file the user is not looking at.
  /** Staging used to be hidden here, because every write went to the project
   *  root regardless of which tree was on screen. Writes are routed by thread
   *  now, so the buttons are back — and they must carry the thread through. */
  it("stages into the worktree it is showing, not the project root", async () => {
    const calls: { cmd: string; args: Record<string, unknown> }[] = [];
    mockGit((cmd, args) => {
      calls.push({ cmd, args: args as Record<string, unknown> });
      if (cmd === "git_working_diff") return Promise.resolve(ONE_HUNK_DIFF);
      return undefined;
    });

    render(<DiffPane projectHash="p1" threadId="t1" />);
    await expandChangedFiles().catch(() => undefined);
    await waitFor(() => expect(screen.getAllByTestId("diff-file")).toHaveLength(1));

    fireEvent.click(screen.getByTestId("stage-all-btn"));
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "git_stage_file")).toBe(true)
    );
    const staged = calls.find((c) => c.cmd === "git_stage_file")!;
    expect(staged.args.threadId).toBe("t1");
  });

  it("keeps staging available on the project's own working tree", async () => {
    mockGit((cmd) => {
      if (cmd === "git_working_diff") return Promise.resolve(ONE_HUNK_DIFF);
      return undefined;
    });

    render(<DiffPane projectHash="p1" />);
    await expandChangedFiles().catch(() => undefined);
    await waitFor(() => expect(screen.getAllByTestId("diff-file")).toHaveLength(1));

    expect(screen.getByTestId("stage-all-btn")).toBeTruthy();
    expect(screen.getByTestId("hunk-action-btn")).toBeTruthy();
  });

  /** An added file has no "before", so side-by-side rendered a full-height
   *  column of blank cells beside it — indistinguishable from a broken
   *  render. GitHub and VS Code both fall back to unified here. */
  it("renders an added file unified even in side-by-side", async () => {
    const NEW_FILE_DIFF = [
      "diff --git a/new.md b/new.md",
      "new file mode 100644",
      "index 0000000..8c7e5a6",
      "--- /dev/null",
      "+++ b/new.md",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "",
    ].join("\n");
    localStorage.setItem("palisade.diffView", "split");
    mockGit((cmd) => {
      if (cmd === "git_working_diff") return Promise.resolve(NEW_FILE_DIFF);
      if (cmd === "git_status")
        return Promise.resolve([{ path: "new.md", code: "??" }]);
      return undefined;
    });

    render(<DiffPane projectHash="p1" />);
    await expandChangedFiles().catch(() => undefined);
    await waitFor(() => expect(screen.getAllByTestId("diff-file")).toHaveLength(1));

    expect(screen.queryByTestId("diff-rows-split")).toBeNull();
    expect(screen.getByTestId("diff-rows-inline")).toBeTruthy();
    // The toggle still reads "split" — this is a per-file fallback, not a
    // silent change to the reviewer's own preference.
    expect(localStorage.getItem("palisade.diffView")).toBe("split");
    localStorage.removeItem("palisade.diffView");
  });

  it("switches between inline and side-by-side", async () => {
    mockGit((cmd) => {
      if (cmd === "git_working_diff") return Promise.resolve(ONE_HUNK_DIFF);
      return undefined;
    });

    render(<DiffPane projectHash="p1" />);
    await expandChangedFiles().catch(() => undefined);
    await waitFor(() => expect(screen.getByTestId("diff-rows-inline")).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: "Side by Side" }));

    await waitFor(() => expect(screen.getByTestId("diff-rows-split")).toBeTruthy());
    expect(screen.queryByTestId("diff-rows-inline")).toBeNull();
  });

  it("clears the previous commit's patches while a newly selected commit loads", async () => {
    const secondDiff = `diff --git a/second.txt b/second.txt
index 1234567..89abcde 100644
--- a/second.txt
+++ b/second.txt
@@ -1 +1 @@
-before
+after
`;
    let resolveSecond: ((diff: string) => void) | undefined;
    mockGit((cmd, args) => {
      if (cmd !== "git_commit_diff") return undefined;
      if (args?.hash === "first") return Promise.resolve(ONE_HUNK_DIFF);
      return new Promise<string>((resolve) => {
        resolveSecond = resolve;
      });
    });
    const first = { hash: "first", parents: [], subject: "First", author: "T", date: "", refs: [] };
    const second = { hash: "second", parents: [], subject: "Second", author: "T", date: "", refs: [] };
    const { rerender } = render(<DiffPane projectHash="p1" commit={first} />);

    await waitFor(() => expect(screen.getByTestId("diff-file")).toHaveTextContent("tracked.txt"));
    rerender(<DiffPane projectHash="p1" commit={second} />);

    await screen.findByText("Loading commit…");
    expect(screen.queryByTestId("diff-file")).toBeNull();

    resolveSecond?.(secondDiff);
    await waitFor(() => expect(screen.getByTestId("diff-file")).toHaveTextContent("second.txt"));
  });

  // Scan-then-edit: the list is for finding the file that matters, and the
  // file opens as the real buffer — reviewing and fixing are the same view.
  it("lists changed files with their size, and opens one as an editable buffer", async () => {
    const user = userEvent.setup();
    mockGit((cmd) => {
      if (cmd === "git_status") return Promise.resolve([{ path: "tracked.txt", code: " M" }]);
      if (cmd === "git_working_diff") return Promise.resolve(ONE_HUNK_DIFF);
      if (cmd === "read_file_content")
        return Promise.resolve("line one\nCHANGED\nline three\n");
      return undefined;
    });

    render(<DiffPane projectHash="proj-1" threadId="t1" />);
    await expandChangedFiles().catch(() => undefined);
    const row = await screen.findByTestId("diff-scan-file");
    expect(row).toHaveAttribute("data-path", "tracked.txt");
    expect(row).toHaveTextContent("+1 −1");

    // The pencil is the visible way in; the filename is the shortcut.
    await user.click(screen.getByTestId("diff-row-edit"));
    await waitFor(() => expect(screen.getByTestId("editable-diff")).toBeDefined());
    // The buffer reads the tree it was rendered from, not the project root.
    expect(invokeMock).toHaveBeenCalledWith(
      "read_file_content",
      expect.objectContaining({ threadId: "t1", relativePath: "tracked.txt" }),
    );

    await user.click(screen.getByTestId("editable-diff-back"));
    await waitFor(() => expect(screen.getByTestId("diff-scan-list")).toBeDefined());
  });


  // One control for the common case: read everything, or clear the deck.
  it("expands and collapses every changed file at once", async () => {
    const user = userEvent.setup();
    mockGit((cmd) => {
      if (cmd === "git_status") return Promise.resolve([{ path: "tracked.txt", code: " M" }]);
      if (cmd === "git_working_diff") return Promise.resolve(ONE_HUNK_DIFF);
      return undefined;
    });

    render(<DiffPane projectHash="p1" />);
    const toggle = await screen.findByTestId("diff-expand-all");
    expect(toggle).toHaveTextContent("Expand all");
    expect(screen.queryByTestId("diff-file")).toBeNull();

    await user.click(toggle);
    expect(screen.getAllByTestId("diff-file")).toHaveLength(1);
    // The label follows the state, so the next click is the opposite action.
    expect(screen.getByTestId("diff-expand-all")).toHaveTextContent("Collapse all");

    await user.click(screen.getByTestId("diff-expand-all"));
    expect(screen.queryByTestId("diff-file")).toBeNull();
  });


  // The single-file view is the file, not its hunks: a reviewer who wants to
  // change a line the agent never touched can, without leaving the pane.
  it("opens the whole file, not just the changed region", async () => {
    const user = userEvent.setup();
    const whole = "line one\nCHANGED\nline three\nuntouched tail\n";
    mockGit((cmd) => {
      if (cmd === "git_status") return Promise.resolve([{ path: "tracked.txt", code: " M" }]);
      if (cmd === "git_working_diff") return Promise.resolve(ONE_HUNK_DIFF);
      if (cmd === "read_file_content") return Promise.resolve(whole);
      return undefined;
    });

    render(<DiffPane projectHash="p1" />);
    await user.click(await screen.findByTestId("diff-row-edit"));
    const editor = await screen.findByTestId("editable-diff-editor");
    // Including the line no hunk mentions.
    await waitFor(() => expect(editor.textContent).toContain("untouched tail"));
    expect(screen.getByTestId("editable-diff-changed")).toHaveTextContent("full file");
  });

});
