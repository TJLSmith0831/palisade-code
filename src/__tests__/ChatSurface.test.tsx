import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import "../App.css";
import { ChatSurface } from "../App";
import type {
  ExecutorEvent,
  Message,
  Preflight,
  Project,
  ThreadMeta,
} from "../api";
import type { SpecStage } from "../stage";

const renderWithMantine = (ui: ReactElement) =>
  render(ui, { wrapper: MantineProvider });

const project: Project = {
  hash: "p1",
  root: "/tmp/proj",
  displayName: "proj",
  createdAt: "2026-08-06T00:00:00Z",
  lastAccessedAt: "2026-08-06T00:00:00Z",
};

const thread: ThreadMeta = {
  id: "t1",
  projectHash: "p1",
  title: "Thread",
  createdAt: "2026-08-06T00:00:00Z",
  updatedAt: "2026-08-06T00:00:00Z",
  currentMode: "go",
  openSpecChangeName: null,
};

const flight: Preflight = {
  agents: [
    {
      id: "claude",
      name: "Claude Code",
      version: null,
      path: null,
      cmd: "claude",
    },
    {
      id: "codex",
      name: "Codex",
      version: null,
      path: null,
      cmd: "codex",
    },
  ],
  selected: "claude",
  openspec: false,
  ready: true,
  warnings: [],
  registryReachable: true,
  checkedAt: "2026-08-06T00:00:00Z",
};

const msg = (seq: number, content: string): Message => ({
  seq,
  ts: "2026-08-06T00:00:00Z",
  role: "assistant",
  mode: "go",
  content,
});

/** jsdom has no layout, so scroll metrics are all 0. Override them on the
 * messages container to simulate "at bottom" vs "scrolled up". */
const setScrollMetrics = (
  el: HTMLElement,
  {
    scrollTop,
    scrollHeight,
    clientHeight,
  }: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  }
) => {
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    writable: true,
    value: scrollTop,
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    writable: true,
    value: scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    writable: true,
    value: clientHeight,
  });
};

type SurfaceOverrides = Partial<Parameters<typeof ChatSurface>[0]>;

const renderSurface = (overrides: SurfaceOverrides = {}) => {
  const onSend = vi.fn();
  const props: Parameters<typeof ChatSurface>[0] = {
    project,
    thread,
    messages: [msg(1, "hello")],
    live: [] as ExecutorEvent[],
    sessionId: null,
    busy: false,
    executor: "claude",
    flight,
    flightSelected: true,
    models: null,
    onSelectThread: vi.fn(),
    onCloseThread: vi.fn(),
    onNewThread: vi.fn(),
    onPickExecutor: vi.fn(),
    onPickModel: vi.fn(),
    onProbeModels: vi.fn(),
    draft: "next message",
    setDraft: vi.fn(),
    onSend,
    onStop: vi.fn(),
    onRenameThread: vi.fn(),
    onSpec: vi.fn(),
    onGo: vi.fn(),
    onApply: vi.fn(),
    stage: "chat" as SpecStage,
    dragActive: false,
    newThreadPicker: false,
    onPickMode: vi.fn(),
    threadBypass: false,
    onToggleBypass: vi.fn(),
    prefsMenuOpen: false,
    setPrefsMenuOpen: vi.fn(),
    hasLiveSession: false,
    ...overrides,
  };
  return { ...renderWithMantine(<ChatSurface {...props} />), onSend, props };
};

describe("ChatSurface auto-scroll", () => {
  it("shows a thread skeleton while a project switch is fetching its list", () => {
    renderSurface({ loading: true, thread: null, messages: [] });
    expect(screen.getByTestId("thread-loading")).toBeTruthy();
    expect(screen.queryByTestId("mode-picker")).toBeNull();
  });

  it("starts with auto-scroll on", () => {
    renderSurface();
    const messages = screen.getByTestId("messages");
    expect(messages.getAttribute("data-autoscroll")).toBe("true");
  });

  it("disables auto-scroll when the user scrolls up", () => {
    renderSurface();
    const messages = screen.getByTestId("messages");
    // Simulate being scrolled away from the bottom.
    setScrollMetrics(messages, {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 200,
    });
    fireEvent.scroll(messages);
    expect(messages.getAttribute("data-autoscroll")).toBe("false");
  });

  it("re-enables auto-scroll when scrolled back to the bottom", () => {
    renderSurface();
    const messages = screen.getByTestId("messages");
    // Scroll up first.
    setScrollMetrics(messages, {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 200,
    });
    fireEvent.scroll(messages);
    expect(messages.getAttribute("data-autoscroll")).toBe("false");
    // Scroll back to bottom (within threshold).
    setScrollMetrics(messages, {
      scrollTop: 800,
      scrollHeight: 1000,
      clientHeight: 200,
    });
    fireEvent.scroll(messages);
    expect(messages.getAttribute("data-autoscroll")).toBe("true");
  });

  it("re-enables auto-scroll when the user sends a new message", () => {
    const { onSend } = renderSurface();
    const messages = screen.getByTestId("messages");
    // Scroll up to disable auto-scroll.
    setScrollMetrics(messages, {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 200,
    });
    fireEvent.scroll(messages);
    expect(messages.getAttribute("data-autoscroll")).toBe("false");
    // Send a message.
    fireEvent.click(screen.getByTestId("composer-send"));
    expect(onSend).toHaveBeenCalledOnce();
    expect(messages.getAttribute("data-autoscroll")).toBe("true");
  });

  it("re-enables auto-scroll when switching to a different thread", () => {
    // ChatSurface isn't remounted on thread switch, so scrolling up in one
    // thread must not leave the next thread opened mid-scroll.
    const { rerender, props } = renderSurface();
    const messages = screen.getByTestId("messages");
    setScrollMetrics(messages, {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 200,
    });
    fireEvent.scroll(messages);
    expect(messages.getAttribute("data-autoscroll")).toBe("false");

    const otherThread: ThreadMeta = { ...thread, id: "t2", title: "Other" };
    rerender(
      <ChatSurface {...props} thread={otherThread} messages={[msg(1, "hi")]} />
    );
    expect(screen.getByTestId("messages").getAttribute("data-autoscroll")).toBe(
      "true"
    );
  });
});

describe("worktree isolation control", () => {
  it("names the active destination instead of relying on an icon alone", () => {
    renderSurface({ worktreeEnabled: true });
    expect(screen.getByTestId("worktree-mode-btn")).toHaveTextContent("Isolated");
  });

  it("names the project directory when isolation is off", () => {
    renderSurface({ worktreeEnabled: false });
    expect(screen.getByTestId("worktree-mode-btn")).toHaveTextContent("Project root");
  });
});

describe("executor switch during a live session (Amendment 5)", () => {
  // `prefsMenuOpen` is App state, so the menu is opened by prop here; the
  // App-level test covers the real open-then-close path.
  const pick = async (id: string) =>
    fireEvent.click(await screen.findByTestId(`executor-opt-${id}`));

  it("explains that the switch applies to the next session, outside the menu", async () => {
    renderSurface({ hasLiveSession: true, busy: true, prefsMenuOpen: true });
    await pick("codex");

    // The menu — and the hint inside it — is gone by now; the banner is what
    // survives, which is the entire point of the fix.
    const banner = screen.getByTestId("executor-switch-banner");
    expect(banner.textContent).toContain("Codex");
    expect(banner.textContent).toContain("Claude Code");
  });

  it("says nothing when there is no live session to be confused about", async () => {
    renderSurface({ hasLiveSession: false, prefsMenuOpen: true });
    await pick("codex");
    expect(screen.queryByTestId("executor-switch-banner")).toBeNull();
  });

  it("says nothing when the picked agent is the one already selected", async () => {
    renderSurface({ hasLiveSession: true, prefsMenuOpen: true });
    await pick("claude");
    expect(screen.queryByTestId("executor-switch-banner")).toBeNull();
  });

  it("can be dismissed, and stays dismissed", async () => {
    renderSurface({ hasLiveSession: true, prefsMenuOpen: true });
    await pick("codex");
    fireEvent.click(screen.getByTestId("executor-switch-dismiss"));
    expect(screen.queryByTestId("executor-switch-banner")).toBeNull();
  });

  it("still calls through to the picker — the banner is an explanation, not a gate", async () => {
    const { props } = renderSurface({ hasLiveSession: true, prefsMenuOpen: true });
    await pick("codex");
    expect(props.onPickExecutor).toHaveBeenCalledWith("codex");
  });
});

describe("add-agent section in the provider picker", () => {
  const addableFlight: Preflight = {
    ...flight,
    addable: [
      { id: "gemini-acp", name: "Gemini", description: "Google's Gemini, via its ACP adapter.", version: null },
    ],
  };

  it("offers addable agents below the installed ones and enables one on click", async () => {
    const onAddAgent = vi.fn();
    renderSurface({ flight: addableFlight, onAddAgent, prefsMenuOpen: true });
    const row = await screen.findByTestId("executor-add-agent-opt-gemini-acp");
    expect(row).toHaveTextContent("Gemini");
    fireEvent.click(row);
    expect(onAddAgent).toHaveBeenCalledWith("gemini-acp");
  });

  it("shows nothing extra when there is nothing addable", async () => {
    renderSurface({ flight, onAddAgent: vi.fn(), prefsMenuOpen: true });
    await screen.findByTestId("executor-menu");
    expect(screen.queryByText(/add an agent/i)).not.toBeInTheDocument();
  });
});

describe("model selection", () => {
  it("does not submit the draft when a model is picked", async () => {
    const { onSend, props } = renderSurface({
      models: {
        configId: "model",
        current: "m1",
        models: [
          { id: "m1", name: "Model One" },
          { id: "m2", name: "Model Two" },
        ],
      },
    });

    fireEvent.click(screen.getByTestId("model-btn"));
    fireEvent.click(await screen.findByTestId("model-opt-m2"));

    expect(props.onPickModel).toHaveBeenCalledWith("m2");
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("thread tab strip (mockup parity)", () => {
  const threads: ThreadMeta[] = [
    { ...thread, id: "t1", title: "Add LSP status", currentMode: "spec" },
    { ...thread, id: "t2", title: "Thread 2", currentMode: "go" },
  ];

  it("lists the project's threads with their mode, marking the active one", () => {
    renderSurface({ threads, thread: threads[0] });
    const tabs = screen.getAllByTestId("thread-tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toContain("Add LSP status");
    // The badge maps onto the real spec/go state machine — no third mode.
    expect(tabs[0].textContent?.toLowerCase()).toContain("spec");
    expect(tabs[1].textContent?.toLowerCase()).toContain("go");
    expect(tabs[0]).toHaveAttribute("aria-current", "true");
    expect(tabs[1]).not.toHaveAttribute("aria-current", "true");
  });

  it("switches threads from the strip", () => {
    const { props } = renderSurface({ threads, thread: threads[0] });
    fireEvent.click(screen.getAllByTestId("thread-tab")[1]);
    expect(props.onSelectThread).toHaveBeenCalledWith(threads[1]);
  });

  it("closes a thread from its tab, like any other tab", () => {
    const { props } = renderSurface({ threads, thread: threads[0] });
    fireEvent.click(screen.getAllByTestId("thread-tab-close")[1]);
    expect(props.onCloseThread).toHaveBeenCalledWith(threads[1]);
    // Closing a tab is not selecting it.
    expect(props.onSelectThread).not.toHaveBeenCalled();
  });

  it("starts a new thread from the strip's +", () => {
    const { props } = renderSurface({ threads, thread: threads[0] });
    fireEvent.click(screen.getByTestId("thread-tab-new"));
    expect(props.onNewThread).toHaveBeenCalled();
  });

  it("is not rendered when the project has no threads yet", () => {
    renderSurface({ threads: [], thread: null });
    expect(screen.queryByTestId("thread-tab")).toBeNull();
  });
});
