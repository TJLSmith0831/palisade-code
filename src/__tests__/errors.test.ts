import { describe, expect, it } from "vitest";
import { describeError, isAuthError } from "../errors";

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
