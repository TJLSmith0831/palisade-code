import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render as rtlRender, screen, act } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import userEvent from "@testing-library/user-event";

const render = (ui: React.ReactNode) => rtlRender(ui, { wrapper: MantineProvider });

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

const preview = vi.hoisted(() => ({
  previewProbe: vi.fn((_url: string) => Promise.resolve<string | null>(null)),
  previewOpen: vi.fn((_url: string, _bounds: unknown) => Promise.resolve()),
  previewBounds: vi.fn(() => Promise.resolve()),
  previewHide: vi.fn(() => Promise.resolve()),
  previewReload: vi.fn(() => Promise.resolve()),
  previewHistory: vi.fn(() => Promise.resolve()),
}));
vi.mock("../api", () => preview);

import PreviewPane from "../PreviewPane";

const PANE = { left: 800, top: 100, width: 300, height: 700 };
const rectOf = (r: { left: number; top: number; width: number; height: number }) =>
  ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height }) as DOMRect;

/** jsdom has no layout: give the placeholder a real box, and let a test add an overlay with its own. */
beforeEach(() => {
  handlers.clear();
  for (const fn of Object.values(preview)) fn.mockClear();
  preview.previewProbe.mockImplementation(() => Promise.resolve(null));
  openUrl.mockClear();
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.getAttribute("data-testid") === "preview-frame") return rectOf(PANE);
    if (this.classList.contains("mantine-Modal-root")) return rectOf({ left: 0, top: 0, width: 1280, height: 800 });
    return rectOf({ left: 0, top: 0, width: 0, height: 0 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const frame = () => act(() => void vi.advanceTimersToNextFrame());
const flush = () => act(async () => {});

describe("PreviewPane", () => {
  it("opens the native view over the placeholder for the URL it is given", async () => {
    render(<PreviewPane projectHash="proj" url="http://localhost:5173/" onNavigate={() => {}} />);
    await flush();
    expect(preview.previewProbe).toHaveBeenCalledWith("http://localhost:5173/");
    expect(preview.previewOpen).toHaveBeenCalledWith("proj", "http://localhost:5173/", {
      x: 800,
      y: 100,
      width: 300,
      height: 700,
    });
  });

  it("shows the empty state, and no native view, before there is a URL", () => {
    render(<PreviewPane projectHash="proj" url={null} onNavigate={() => {}} />);
    expect(screen.getByTestId("preview-empty")).toHaveTextContent("start a dev server");
    expect(preview.previewOpen).not.toHaveBeenCalled();
  });

  it("shows where the page actually is once it reports, not only where it was sent", () => {
    render(<PreviewPane projectHash="proj" url="http://localhost:5173/" onNavigate={() => {}} />);
    act(() =>
      handlers.get("preview-state")?.({
        payload: { projectHash: "proj", url: "http://localhost:5173/login", loading: false, title: "Sign in" },
      })
    );
    expect(screen.getByTestId("preview-url")).toHaveValue("http://localhost:5173/login");
  });

  it("ignores what another project's browser reports while it keeps loading in the background", () => {
    render(<PreviewPane projectHash="proj" url="http://localhost:5173/" onNavigate={() => {}} />);
    act(() =>
      handlers.get("preview-state")?.({
        payload: { projectHash: "other", url: "http://localhost:9000/elsewhere", loading: false, title: "Other" },
      })
    );
    expect(screen.getByTestId("preview-url")).toHaveValue("http://localhost:5173/");
  });

  it("drives only its own project's browser", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    render(<PreviewPane projectHash="proj-b" url="http://localhost:5173/" onNavigate={() => {}} />);
    await user.click(screen.getByTestId("preview-back"));
    await user.click(screen.getByTestId("preview-reload"));
    expect(preview.previewHistory).toHaveBeenCalledWith("proj-b", -1);
    expect(preview.previewReload).toHaveBeenCalledWith("proj-b");
  });

  it("shows a spinner only while the page is loading", () => {
    render(<PreviewPane projectHash="proj" url="http://localhost:5173/" onNavigate={() => {}} />);
    act(() => handlers.get("preview-state")?.({ payload: { projectHash: "proj", url: "http://localhost:5173/", loading: true, title: null } }));
    expect(screen.getByTestId("preview-loading")).toBeInTheDocument();
    act(() => handlers.get("preview-state")?.({ payload: { projectHash: "proj", url: "http://localhost:5173/", loading: false, title: null } }));
    expect(screen.queryByTestId("preview-loading")).toBeNull();
  });

  it("navigates to a new address on Enter, adding the scheme people leave off", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<PreviewPane projectHash="proj" url="http://localhost:5173/" onNavigate={onNavigate} />);
    const input = screen.getByTestId("preview-url");
    await user.clear(input);
    await user.type(input, "localhost:4000{Enter}");
    expect(onNavigate).toHaveBeenCalledWith("http://localhost:4000");
  });

  it("reloads instead of navigating when Enter is pressed on the address already showing", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<PreviewPane projectHash="proj" url="http://localhost:5173/" onNavigate={onNavigate} />);
    await user.type(screen.getByTestId("preview-url"), "{Enter}");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(preview.previewReload).toHaveBeenCalled();
  });

  it("sends back, forward and reload to the native view", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    render(<PreviewPane projectHash="proj" url="http://localhost:5173/" onNavigate={() => {}} />);
    await user.click(screen.getByTestId("preview-back"));
    await user.click(screen.getByTestId("preview-forward"));
    await user.click(screen.getByTestId("preview-reload"));
    expect(preview.previewHistory.mock.calls).toEqual([["proj", -1], ["proj", 1]]);
    expect(preview.previewReload).toHaveBeenCalledTimes(1);
  });

  it("opens the page it is actually on in the system browser", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    render(<PreviewPane projectHash="proj" url="http://localhost:5173/" onNavigate={() => {}} />);
    act(() => handlers.get("preview-state")?.({ payload: { projectHash: "proj", url: "http://localhost:5173/login", loading: false, title: null } }));
    await user.click(screen.getByTestId("preview-external"));
    expect(openUrl).toHaveBeenCalledWith("http://localhost:5173/login");
  });

  it("hides the native view when the tab is left, so it cannot float over other content", () => {
    const { unmount } = render(<PreviewPane projectHash="proj" url="http://localhost:5173/" onNavigate={() => {}} />);
    preview.previewHide.mockClear();
    unmount();
    expect(preview.previewHide).toHaveBeenCalled();
  });

  it("follows the placeholder when it moves without resizing", () => {
    render(<PreviewPane projectHash="proj" url="http://localhost:5173/" onNavigate={() => {}} />);
    frame();
    expect(preview.previewBounds).toHaveBeenCalledWith("proj", { x: 800, y: 100, width: 300, height: 700 });

    PANE.left = 640; // a sidebar collapsed: same size, new position
    frame();
    expect(preview.previewBounds).toHaveBeenLastCalledWith("proj", { x: 640, y: 100, width: 300, height: 700 });
    PANE.left = 800;
  });

  it("steps aside while an overlay is open over it, and comes back when it closes", () => {
    render(<PreviewPane projectHash="proj" url="http://localhost:5173/" onNavigate={() => {}} />);
    frame();
    preview.previewHide.mockClear();
    preview.previewBounds.mockClear();

    const modal = document.createElement("div");
    modal.className = "mantine-Modal-root";
    document.body.appendChild(modal);
    frame();
    expect(preview.previewHide, "a native view draws above a dialog").toHaveBeenCalledTimes(1);

    frame();
    expect(preview.previewHide, "hidden once, not on every frame").toHaveBeenCalledTimes(1);

    modal.remove();
    frame();
    expect(preview.previewBounds, "shown again at its bounds").toHaveBeenCalledWith("proj", { x: 800, y: 100, width: 300, height: 700 });
  });

  describe("when nothing is answering", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
    });

    it("says so instead of showing a blank page, and keeps the native view hidden", async () => {
      preview.previewProbe.mockResolvedValue("Connection Failed");
      render(<PreviewPane projectHash="proj" url="http://127.0.0.1:4173/" onNavigate={() => {}} />);
      await flush();

      expect(screen.getByTestId("preview-unreachable")).toHaveTextContent("Can't reach 127.0.0.1:4173");
      expect(preview.previewOpen).not.toHaveBeenCalled();
      expect(preview.previewHide).toHaveBeenCalled();

      preview.previewBounds.mockClear();
      frame();
      expect(preview.previewBounds, "the placeholder loop must not un-hide a view with nothing to show").not.toHaveBeenCalled();
    });

    it("retries on its own and shows the page as soon as the server comes up", async () => {
      preview.previewProbe.mockResolvedValueOnce("Connection Failed").mockResolvedValue(null);
      render(<PreviewPane projectHash="proj" url="http://127.0.0.1:4173/" onNavigate={() => {}} />);
      await flush();
      expect(screen.getByTestId("preview-unreachable")).toBeInTheDocument();
      expect(preview.previewOpen).not.toHaveBeenCalled();

      await act(async () => void vi.advanceTimersByTime(2100));
      await flush();

      expect(screen.queryByTestId("preview-unreachable")).toBeNull();
      expect(preview.previewOpen).toHaveBeenCalledWith("proj", "http://127.0.0.1:4173/", expect.anything());
    });

    it("retries immediately when asked", async () => {
      preview.previewProbe.mockResolvedValueOnce("Connection Failed").mockResolvedValue(null);
      render(<PreviewPane projectHash="proj" url="http://127.0.0.1:4173/" onNavigate={() => {}} />);
      await flush();
      act(() => screen.getByTestId("preview-retry").click());
      await flush();
      expect(preview.previewProbe).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId("preview-unreachable")).toBeNull();
    });

    it("does not probe, or block, a page that is not local", async () => {
      render(<PreviewPane projectHash="proj" url="https://example.com/" onNavigate={() => {}} />);
      await flush();
      expect(preview.previewProbe).not.toHaveBeenCalled();
      expect(preview.previewOpen).toHaveBeenCalledWith("proj", "https://example.com/", expect.anything());
    });
  });
});
