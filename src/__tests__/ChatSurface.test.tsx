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
  ],
  selected: "claude",
  openspec: false,
  graphify: false,
  ready: true,
  warnings: [],
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
    busy: false,
    showThinking: false,
    executor: "claude",
    flight,
    flightSelected: true,
    models: null,
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
