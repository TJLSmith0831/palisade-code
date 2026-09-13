import { describe, expect, it } from "vitest";
import { describeError, errorKind, errorMessage, isAuthError, recoveryHint } from "../errors";

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

describe("isAuthError", () => {
  it("recognises the wording agents use for an expired or missing login", () => {
    for (const message of [
      "prompt failed: Failed to authenticate: OAuth session expired and could not be refreshed",
      "prompt failed: Authentication required",
      "Unauthorized",
      "401 from the provider",
      "You are not logged in",
    ]) {
      expect(isAuthError(message), message).toBe(true);
    }
  });

  /** #19: the backend now explains which agent to sign in and how Palisade
   *  launched it. That message has to keep the re-auth affordance the raw
   *  agent error used to trigger. */
  it("recognises the backend's own auth guidance", () => {
    expect(
      isAuthError(
        "Claude Agent needs to be signed in — Authentication required. Palisade runs it as `npx @agentclientprotocol/claude-agent-acp`; sign in for that agent, then retry.",
      ),
    ).toBe(true);
  });

  /** The agent's own words may not contain any of the stock phrases — the
   *  guidance Palisade wraps around them still has to read as an auth issue. */
  it("recognises the guidance even when the agent's detail says nothing familiar", () => {
    expect(
      isAuthError(
        "Devin needs to be signed in — the provider rejected the request. Palisade runs it as `devin acp`; sign in for that agent, then retry.",
      ),
    ).toBe(true);
  });

  it("does not flag ordinary failures", () => {
    for (const message of [
      "prompt failed: context window exceeded",
      "session/new failed: no such directory",
      "tool call failed: exit status 1",
    ]) {
      expect(isAuthError(message), message).toBe(false);
    }
  });
});

describe("one error path, and copy that matches what happened", () => {
  const backendError = (kind: string, message: string) => ({ kind, message });

  it("branches on kind without looking at the words", () => {
    // Source Control asked "/not a git repository/i.test(String(err))". The
    // classification happens once now, in Rust, against git's own output.
    expect(errorKind(backendError("notAGitRepo", "fatal: whatever git said"))).toBe("notAGitRepo");
    expect(errorKind(backendError("notFound", "no such file: a.ts"))).toBe("notFound");
    // Anything that is not a backend error is simply unknown — no sniffing.
    expect(errorKind(new Error("not a git repository"))).toBe("unknown");
    expect(errorKind("a bare string")).toBe("unknown");
  });

  it("says a load failed when nothing was attempted, and an action failed when it was", () => {
    const err = backendError("unknown", "connection refused");
    const load = describeError(err, { loading: "the commit graph" });
    const action = describeError(err, { action: "push that branch" });

    // VerifyPane and SpecChangeTab said "Couldn't complete that" on a read,
    // when the user had done nothing at all.
    expect(load).toContain("Couldn't load the commit graph");
    expect(load).not.toMatch(/complete that/i);
    expect(action).toContain("Couldn't push that branch");
    expect(load).not.toBe(action);
    // The detail is never hidden, whichever way it reads.
    expect(load).toContain("connection refused");
    expect(action).toContain("connection refused");
  });

  it("varies the copy by kind, not just by context", () => {
    const missing = describeError(backendError("notFound", "src/gone.ts"), {
      loading: "that file",
    });
    const generic = describeError(backendError("unknown", "src/gone.ts"), {
      loading: "that file",
    });
    expect(missing).not.toBe(generic);
    expect(describeError(backendError("outsideProject", "/etc/passwd"))).toContain(
      "outside the project"
    );
  });

  it("still has something to say with no context at all", () => {
    expect(describeError(backendError("unknown", "boom"))).toBe(
      "Couldn't complete that — boom"
    );
    expect(describeError(new Error("boom"))).toBe("Couldn't complete that — boom");
  });

  it("offers a way out where one exists, and stays quiet where none does", () => {
    expect(recoveryHint(backendError("notAGitRepo", "x"))).toMatch(/Initialise a repository/);
    expect(recoveryHint(backendError("notFound", "x"))).toMatch(/renamed or deleted/);
    expect(recoveryHint(backendError("unknown", "x"))).toBeNull();
  });

  it("leaves the agent-text regex alone, because that half is not ours to type", () => {
    // Third-party CLIs, whose wording nobody here controls.
    expect(isAuthError("Please log in again to continue")).toBe(true);
    expect(isAuthError("401 Unauthorized")).toBe(true);
    expect(isAuthError("compilation failed")).toBe(false);
  });
});
