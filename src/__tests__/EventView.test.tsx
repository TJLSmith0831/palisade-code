import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import "../App.css";
import {
  EventList,
  filterForTab,
  itemsFromMessages,
  scrollToSession,
  sessionAnchorId,
  type Item,
} from "../EventView";
import type { Message } from "../api";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const chatItem: Item = {
  kind: "plain",
  role: "assistant",
  mode: "spec",
  text: "hi",
};
const editItem: Item = {
  kind: "fileEdit",
  id: "1",
  path: "a.ts",
  before: "x",
  after: "y",
};

const renderWithMantine = (ui: React.ReactElement) =>
  render(ui, { wrapper: MantineProvider });

describe("filterForTab", () => {
  it("keeps everything for the chat tab", () => {
    expect(filterForTab([chatItem, editItem], "chat")).toEqual([
      chatItem,
      editItem,
    ]);
  });

  it("keeps only file edits for the diff tab", () => {
    expect(filterForTab([chatItem, editItem], "diff")).toEqual([editItem]);
  });
});

describe("EventList markdown rendering", () => {
  it("renders markdown emphasis as real elements, not literal asterisks", () => {
    const items: Item[] = [{ kind: "text", text: "**bold** and *italic*" }];
    renderWithMantine(
      <EventList items={items} executor={null} />
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
  });

  it("renders file diffs at full width", () => {
    renderWithMantine(
      <EventList items={[editItem]} executor={null} />
    );
    expect(getComputedStyle(screen.getByTestId("file-edit")).width).toBe(
      "100%"
    );
  });
});

describe("ToolBlock rendering", () => {
  const toolCallItem: Item = {
    kind: "toolCall",
    id: "t1",
    name: "Bash",
    command: "echo hello\necho world",
  };
  const toolResultItem: Item = {
    kind: "toolResult",
    id: "t1",
    output: "hello\nworld",
    isError: false,
  };
  const failedResultItem: Item = {
    kind: "toolResult",
    id: "t1",
    output: "command not found",
    isError: true,
  };

  it("renders the tool name as a badge and command preview in the header", () => {
    renderWithMantine(
      <EventList items={[toolCallItem]} executor={null} />
    );
    const block = screen.getByTestId("tool-block");
    expect(block).toBeDefined();
    expect(screen.getByText("Bash")).toBeDefined();
    // Command preview shows the first line
    expect(screen.getByText("echo hello")).toBeDefined();
  });

  it("shows a running indicator when no output has arrived", () => {
    renderWithMantine(
      <EventList items={[toolCallItem]} executor={null} />
    );
    expect(screen.getByTestId("tool-status-running")).toBeDefined();
  });

  it("shows a success indicator when output arrived with isError false", () => {
    renderWithMantine(
      <EventList
        items={[toolCallItem, toolResultItem]}
        executor={null}
      />
    );
    expect(screen.getByTestId("tool-status-success")).toBeDefined();
  });

  it("shows a failed indicator when output arrived with isError true", () => {
    renderWithMantine(
      <EventList
        items={[toolCallItem, failedResultItem]}
        executor={null}
      />
    );
    expect(screen.getByTestId("tool-status-failed")).toBeDefined();
  });

  it("hides the body by default and expands on header click", () => {
    renderWithMantine(
      <EventList
        items={[toolCallItem, toolResultItem]}
        executor={null}
      />
    );
    // Collapse renders children but hides them; the chevron points right when closed
    expect(screen.getByTestId("tool-block-closed-chev")).toBeDefined();
    // Click the header to expand
    fireEvent.click(screen.getByTestId("tool-block-header"));
    // Now the chevron points down and the full command/output are present
    expect(screen.getByTestId("tool-block-open-chev")).toBeDefined();
    const cmd = screen.getByTestId("tool-block-command");
    const out = screen.getByTestId("tool-block-output");
    expect(cmd.textContent).toBe("echo hello\necho world");
    expect(out.textContent).toBe("hello\nworld");
  });

  it("applies a danger border to failed tool blocks", () => {
    renderWithMantine(
      <EventList
        items={[toolCallItem, failedResultItem]}
        executor={null}
      />
    );
    const block = screen.getByTestId("tool-block");
    const border = getComputedStyle(block).borderColor;
    // The border color should be set (not empty/transparent) for failed blocks
    expect(border).not.toBe("");
    expect(border).not.toBe("transparent");
  });

  it("a running tool block shows output before it finishes", () => {
    const items: Item[] = [
      toolCallItem,
      { kind: "toolOutputDelta", id: "t1", chunk: "Compiling...\n" },
      { kind: "toolOutputDelta", id: "t1", chunk: "Linking...\n" },
    ];
    renderWithMantine(<EventList items={items} executor={null} />);
    fireEvent.click(screen.getByTestId("tool-block-header"));
    const out = screen.getByTestId("tool-block-output");
    expect(out.textContent).toBe("Compiling...\nLinking...\n");
    // Still running — the deltas are not a final result.
    expect(screen.getByTestId("tool-status-running")).toBeDefined();
  });

  it("the final result replaces the streamed output", () => {
    const items: Item[] = [
      toolCallItem,
      { kind: "toolOutputDelta", id: "t1", chunk: "Compiling...\n" },
      toolResultItem,
    ];
    renderWithMantine(<EventList items={items} executor={null} />);
    fireEvent.click(screen.getByTestId("tool-block-header"));
    const out = screen.getByTestId("tool-block-output");
    expect(out.textContent).toBe("hello\nworld");
  });
});

describe("ToolBlock pending-approval UI (tool-approval-prompt)", () => {
  const toolCallItem: Item = {
    kind: "toolCall",
    id: "t1",
    name: "Bash",
    command: "cargo build",
  };
  const permissionRequestItem: Item = {
    kind: "permissionRequest",
    id: "req-1",
    toolCallId: "t1",
    toolKind: "execute",
    command: "cargo build",
    paths: [],
    warning: null,
  };

  it("renders Allow/Deny/Allow-for-session actions in place of the status icon while pending", () => {
    renderWithMantine(
      <EventList
        items={[toolCallItem, permissionRequestItem]}
        executor={null}
      />
    );
    expect(screen.getByTestId("permission-prompt")).toBeDefined();
    expect(screen.getByTestId("permission-allow")).toBeDefined();
    expect(screen.getByTestId("permission-deny")).toBeDefined();
    expect(screen.getByTestId("permission-allow-session")).toBeDefined();
    expect(screen.queryByTestId("tool-status-running")).toBeNull();
  });

  it("clears the pending state locally once a decision is sent, without a sessionId to answer against", () => {
    renderWithMantine(
      <EventList
        items={[toolCallItem, permissionRequestItem]}
        executor={null}
      />
    );
    fireEvent.click(screen.getByTestId("permission-allow"));
    expect(screen.queryByTestId("permission-prompt")).toBeNull();
    // Falls back to the ordinary running indicator once resolved locally.
    expect(screen.getByTestId("tool-status-running")).toBeDefined();
  });

  it("a tool call with no matching permissionRequest renders its ordinary status, not a prompt", () => {
    renderWithMantine(
      <EventList items={[toolCallItem]} executor={null} />
    );
    expect(screen.queryByTestId("permission-prompt")).toBeNull();
    expect(screen.getByTestId("tool-status-running")).toBeDefined();
  });

  it("shows the port/DB conflict warning inline in the same prompt when one is attached", () => {
    renderWithMantine(
      <EventList
        items={[
          toolCallItem,
          { ...permissionRequestItem, warning: "Another session in this project is already running a command on port 3000." },
        ]}
        executor={null}
      />
    );
    expect(screen.getByTestId("permission-conflict-warning").textContent).toContain("port 3000");
  });

  it("renders no conflict warning when none is attached", () => {
    renderWithMantine(
      <EventList items={[toolCallItem, permissionRequestItem]} executor={null} />
    );
    expect(screen.queryByTestId("permission-conflict-warning")).toBeNull();
  });
});

describe("ReasoningBlock rendering (reasoning-collapse-ux)", () => {
  const reasoningItem: Item = {
    kind: "reasoning",
    text: "step one\nstep two",
    elapsedSecs: 7,
  };

  it("renders collapsed by default, showing 'Thought for Ns' with no reasoning text visible", () => {
    renderWithMantine(
      <EventList items={[reasoningItem]} executor={null} />
    );
    expect(screen.getByTestId("reasoning-block")).toBeDefined();
    expect(screen.getByText("Thought for 7s")).toBeDefined();
    expect(screen.queryByTestId("reasoning-block-text")).toBeNull();
    expect(screen.getByTestId("reasoning-block-closed-chev")).toBeDefined();
  });

  it("expands to show the full reasoning text on click", () => {
    renderWithMantine(
      <EventList items={[reasoningItem]} executor={null} />
    );
    fireEvent.click(screen.getByTestId("reasoning-block-header"));
    expect(screen.getByTestId("reasoning-block-open-chev")).toBeDefined();
    expect(screen.getByTestId("reasoning-block-text").textContent).toBe(
      "step one\nstep two"
    );
  });

  it("renders reasoning content as Markdown after expanding", () => {
    const markdownReasoning: Item = {
      kind: "reasoning",
      text: "**Preparing the project**",
      elapsedSecs: 7,
    };
    renderWithMantine(
      <EventList items={[markdownReasoning]} executor={null} />
    );

    fireEvent.click(screen.getByTestId("reasoning-block-header"));

    expect(screen.getByText("Preparing the project").tagName).toBe("STRONG");
  });
});

describe("EventList chat spacing", () => {
  it("uses normal white-space so markdown reflows instead of preserving literal newlines", () => {
    const items: Item[] = [{ kind: "text", text: "line one\nline two" }];
    const { container } = renderWithMantine(
      <EventList items={items} executor={null} />
    );
    const content = container.querySelector(".message .content");
    expect(content).not.toBeNull();
    expect(getComputedStyle(content!).whiteSpace).toBe("normal");
  });

  it("gives headings compact chat-app margins, not GitHub's 24px/16px", () => {
    const items: Item[] = [
      { kind: "text", text: "intro text\n\n## heading\n\nafter text" },
    ];
    const { container } = renderWithMantine(
      <EventList items={items} executor={null} />
    );
    const heading = container.querySelector(".message .content h2");
    expect(heading).not.toBeNull();
    const style = getComputedStyle(heading!);
    expect(style.marginTop).toBe("12px");
    expect(style.marginBottom).toBe("6px");
  });

  it("gives paragraphs an 8px bottom margin", () => {
    const items: Item[] = [{ kind: "text", text: "first paragraph\n\nsecond" }];
    const { container } = renderWithMantine(
      <EventList items={items} executor={null} />
    );
    const p = container.querySelector(".message .content p");
    expect(p).not.toBeNull();
    expect(getComputedStyle(p!).marginBottom).toBe("8px");
  });

  it("gives list items a 4px bottom margin", () => {
    const items: Item[] = [{ kind: "text", text: "- a\n- b\n- c" }];
    const { container } = renderWithMantine(
      <EventList items={items} executor={null} />
    );
    const li = container.querySelector(".message .content li");
    expect(li).not.toBeNull();
    expect(getComputedStyle(li!).marginBottom).toBe("4px");
  });
});

// A crashed turn shows up as a persisted "system" message — previously
// rendered as a raw internal-error dump with no way to act on it. An
// auth-shaped one now gets a plain-language line and a Retry button that
// resends the prompt that led to the crash.
describe("EventList crash banner", () => {
  const items: Item[] = [
    { kind: "plain", role: "user", mode: "spec", text: "Hello?" },
    {
      kind: "plain",
      role: "system",
      mode: "spec",
      text: 'prompt failed: Internal error: Failed to authenticate: OAuth session expired and could not be refreshed: { "errorKind": "authentication_failed" }',
    },
  ];

  it("adds a plain-language summary and a Retry button for an auth-shaped crash", () => {
    renderWithMantine(
      <EventList items={items} executor={null} onRetry={() => {}} />
    );
    expect(screen.getByTestId("crash-banner-auth-summary")).toHaveTextContent(
      /login expired or failed to refresh/i
    );
    expect(screen.getByTestId("crash-banner")).toHaveTextContent(
      "authentication_failed"
    );
    expect(screen.getByTestId("crash-banner-retry")).toHaveTextContent(
      "Retry"
    );
  });

  it("resends the prompt that led to the crash when Retry is clicked", () => {
    const onRetry = vi.fn();
    renderWithMantine(
      <EventList items={items} executor={null} onRetry={onRetry} />
    );
    fireEvent.click(screen.getByTestId("crash-banner-retry"));
    expect(onRetry).toHaveBeenCalledWith("Hello?");
  });

  it("still finds the prompt to retry when the agent left a partial reply before crashing", () => {
    // The exact shape a live crash actually persists as: the agent's own
    // text (its last words before the RPC itself failed) sits between the
    // user's turn and the system crash marker. Retry must walk past that
    // assistant item, not stop at it.
    const withPartialReply: Item[] = [
      { kind: "plain", role: "user", mode: "go", text: "Hello?" },
      {
        kind: "plain",
        role: "assistant",
        mode: "go",
        text: "Failed to authenticate: OAuth session expired and could not be refreshed",
      },
      {
        kind: "plain",
        role: "system",
        mode: "go",
        text: 'prompt failed: Internal error: Failed to authenticate: OAuth session expired and could not be refreshed: { "errorKind": "authentication_failed" }',
      },
    ];
    const onRetry = vi.fn();
    renderWithMantine(
      <EventList items={withPartialReply} executor={null} onRetry={onRetry} />
    );
    expect(screen.getByTestId("crash-banner-retry")).toBeDefined();
    fireEvent.click(screen.getByTestId("crash-banner-retry"));
    expect(onRetry).toHaveBeenCalledWith("Hello?");
  });

  it("omits the summary and Retry for a non-auth crash", () => {
    const genericItems: Item[] = [
      { kind: "plain", role: "user", mode: "spec", text: "Hello?" },
      {
        kind: "plain",
        role: "system",
        mode: "spec",
        text: "prompt failed: connection reset",
      },
    ];
    renderWithMantine(
      <EventList items={genericItems} executor={null} onRetry={() => {}} />
    );
    expect(
      screen.queryByTestId("crash-banner-auth-summary")
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("crash-banner-retry")).not.toBeInTheDocument();
  });

  it("omits Retry when no onRetry handler is wired up (read-only render paths)", () => {
    renderWithMantine(<EventList items={items} executor={null} />);
    expect(screen.getByTestId("crash-banner-auth-summary")).toBeDefined();
    expect(screen.queryByTestId("crash-banner-retry")).not.toBeInTheDocument();
  });
});


/** #19: an agent whose login expired can be signed in from inside Palisade —
 *  ACP agents advertise an interactive login for the client to run, and
 *  Palisade has a terminal to run it in. Without this the banner could only
 *  tell the user to go elsewhere. */
describe("EventList agent sign-in", () => {
  const crash: Item[] = [
    { kind: "plain", role: "user", mode: "go", text: "do the thing" },
    {
      kind: "plain",
      role: "system",
      mode: "go",
      text: "Claude Agent needs to be signed in — Internal error: Failed to authenticate: OAuth session expired.",
    },
  ];
  const logins = [
    { methodId: "claude-ai-login", label: "Claude Subscription", shellLine: "npx -y pkg --cli auth login --claudeai" },
    { methodId: "console-login", label: "Anthropic Console", shellLine: "npx -y pkg --cli auth login --console" },
  ];

  it("offers one sign-in button per advertised login on an auth failure", () => {
    renderWithMantine(
      <EventList items={crash} executor={null} agentLogins={logins} onAgentLogin={() => {}} />
    );
    const buttons = screen.getAllByTestId("crash-banner-signin");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Sign in with Claude Subscription",
      "Sign in with Anthropic Console",
    ]);
  });

  it("hands the chosen login back so the app can run it", () => {
    const ran: unknown[] = [];
    renderWithMantine(
      <EventList
        items={crash}
        executor={null}
        agentLogins={logins}
        onAgentLogin={(login) => ran.push(login)}
      />
    );
    fireEvent.click(screen.getAllByTestId("crash-banner-signin")[1]);
    expect(ran).toEqual([logins[1]]);
  });

  /** An agent that advertises no client-runnable login gets no button — the
   *  banner must not promise a sign-in that does not exist. */
  it("offers nothing when the agent advertises no login", () => {
    renderWithMantine(
      <EventList items={crash} executor={null} agentLogins={[]} onAgentLogin={() => {}} />
    );
    expect(screen.queryByTestId("crash-banner-signin")).toBeNull();
  });

  it("offers nothing on a failure that is not an auth failure", () => {
    const other: Item[] = [
      { kind: "plain", role: "user", mode: "go", text: "do the thing" },
      { kind: "plain", role: "system", mode: "go", text: "prompt failed: context window exceeded" },
    ];
    renderWithMantine(
      <EventList items={other} executor={null} agentLogins={logins} onAgentLogin={() => {}} />
    );
    expect(screen.queryByTestId("crash-banner-signin")).toBeNull();
  });

  /** The old copy told the user to leave the app. With a login available it
   *  has to say what the button does instead. */
  it("stops telling the user to sign in outside Palisade when it can do it here", () => {
    renderWithMantine(
      <EventList items={crash} executor={null} agentLogins={logins} onAgentLogin={() => {}} />
    );
    const summary = screen.getByTestId("crash-banner-auth-summary");
    expect(summary.textContent).not.toMatch(/outside Palisade/);
    expect(summary.textContent).toMatch(/terminal/i);
  });
});

/**
 * Node click-through (critique P1, acceptance step 7). A chain node's session
 * IS a thread session, so its turns already live in the thread transcript —
 * what was missing was any way to *reach* them. `itemsFromMessages` dropped
 * `Message.sessionId` on the floor, leaving the rendered list with no session
 * identity to scroll to.
 */
describe("session anchors", () => {
  const msg = (seq: number, sessionId: string | null, text: string): Message => ({
    seq,
    ts: `2026-09-10T00:00:0${seq}Z`,
    role: "assistant",
    mode: "go",
    content: text,
    sessionId,
  });

  it("emits one anchor at the first message of each session", () => {
    const items = itemsFromMessages([
      msg(1, "s-a", "first"),
      msg(2, "s-a", "still a"),
      msg(3, "s-b", "now b"),
    ]);
    const anchors = items.filter((i) => i.kind === "sessionAnchor");
    expect(anchors).toEqual([
      { kind: "sessionAnchor", sessionId: "s-a" },
      { kind: "sessionAnchor", sessionId: "s-b" },
    ]);
  });

  it("keeps every original message item, in order, around the anchors", () => {
    const items = itemsFromMessages([msg(1, "s-a", "first"), msg(2, "s-b", "second")]);
    expect(items.map((i) => (i.kind === "sessionAnchor" ? `@${i.sessionId}` : "msg"))).toEqual([
      "@s-a",
      "msg",
      "@s-b",
      "msg",
    ]);
  });

  it("emits no anchor for messages written before sessions had identities", () => {
    const items = itemsFromMessages([msg(1, null, "old"), msg(2, undefined as never, "older")]);
    expect(items.some((i) => i.kind === "sessionAnchor")).toBe(false);
  });

  it("re-anchors when a session resumes after another one interleaves", () => {
    const items = itemsFromMessages([msg(1, "s-a", "a"), msg(2, "s-b", "b"), msg(3, "s-a", "a again")]);
    expect(
      items.filter((i) => i.kind === "sessionAnchor").map((i) => (i as { sessionId: string }).sessionId)
    ).toEqual(["s-a", "s-b", "s-a"]);
  });

  it("renders each anchor as a reachable, non-visual element carrying its session id", () => {
    const { container } = renderWithMantine(
      <EventList
        items={itemsFromMessages([msg(1, "s-a", "hello")])}
        executor="claude"
      />
    );
    const anchor = container.querySelector(`#${CSS.escape(sessionAnchorId("s-a"))}`);
    expect(anchor).not.toBeNull();
    // It must be laid out (scrollIntoView is a no-op on display:none) but must
    // not add visible space to the transcript.
    expect((anchor as HTMLElement).style.height).toBe("0px");
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("scrollToSession scrolls the anchor for that session into view", () => {
    renderWithMantine(
      <EventList items={itemsFromMessages([msg(1, "s-a", "hello")])} executor="claude" />
    );
    const anchor = document.getElementById(sessionAnchorId("s-a"))!;
    const spy = vi.fn();
    anchor.scrollIntoView = spy;
    expect(scrollToSession("s-a")).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it("scrollToSession reports failure for a session with nothing on screen", () => {
    expect(scrollToSession("s-nowhere")).toBe(false);
  });
});

/**
 * A chain node runs whatever agent it is bound to, which is routinely not the
 * thread's agent. The banner used one thread-scoped login list for every crash,
 * so a Claude Agent auth failure offered "Sign in with ChatGPT" — an action
 * that signs in a different agent and fixes nothing.
 */
describe("sign-in buttons follow the agent that actually failed", () => {
  const crashFor = (agentName: string): Item[] => [
    {
      kind: "plain",
      role: "system",
      mode: "go",
      text: `${agentName} needs to be signed in — Internal error: Failed to authenticate: OAuth session expired.`,
    },
  ];
  const codexLogins = [
    { methodId: "chatgpt", label: "ChatGPT", kind: "terminal" as const, shellLine: "codex login" },
  ];
  const claudeLogins = [
    { methodId: "claude-ai", label: "Claude Subscription", kind: "terminal" as const, shellLine: "claude login" },
  ];
  /** Stands in for App.tsx matching the crash text against installed agents. */
  const loginsFor = (text: string) =>
    text.startsWith("Codex") ? codexLogins : text.startsWith("Claude Agent") ? claudeLogins : [];

  it("offers the failing agent's own logins, not the thread agent's", () => {
    renderWithMantine(
      <EventList
        items={crashFor("Claude Agent")}
        executor={null}
        agentLogins={codexLogins}
        agentLoginsFor={loginsFor}
        onAgentLogin={() => {}}
      />
    );
    expect(screen.getAllByTestId("crash-banner-signin").map((b) => b.textContent)).toEqual([
      "Sign in with Claude Subscription",
    ]);
    expect(screen.queryByText("Sign in with ChatGPT")).toBeNull();
  });

  it("offers no sign-in at all rather than a wrong one for an unknown agent", () => {
    renderWithMantine(
      <EventList
        items={crashFor("Some Other Agent")}
        executor={null}
        agentLogins={codexLogins}
        agentLoginsFor={loginsFor}
        onAgentLogin={() => {}}
      />
    );
    expect(screen.queryAllByTestId("crash-banner-signin")).toHaveLength(0);
    expect(screen.getByTestId("crash-banner-auth-summary").textContent).toMatch(
      /can't complete an interactive login on its own/i
    );
  });

  it("falls back to the thread's list when no resolver is supplied", () => {
    renderWithMantine(
      <EventList
        items={crashFor("Codex")}
        executor={null}
        agentLogins={codexLogins}
        onAgentLogin={() => {}}
      />
    );
    expect(screen.getAllByTestId("crash-banner-signin").map((b) => b.textContent)).toEqual([
      "Sign in with ChatGPT",
    ]);
  });
});
