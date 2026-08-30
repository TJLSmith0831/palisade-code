import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

const { listeners, checkMock, relaunchMock, invokeMock, downloadAndInstall } =
  vi.hoisted(() => ({
    listeners: new Map<string, ((event: { payload: unknown }) => void)[]>(),
    checkMock: vi.fn(),
    relaunchMock: vi.fn(),
    invokeMock: vi.fn(),
    downloadAndInstall: vi.fn(),
  }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    return Promise.resolve(() => {});
  }),
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.2.0") }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: relaunchMock }));

import BetaBadge from "../BetaBadge";

const emit = (name: string, payload: unknown) => {
  for (const handler of listeners.get(name) ?? []) handler({ payload });
};

const render = (ui: ReactElement) =>
  rtlRender(<MantineProvider>{ui}</MantineProvider>);

describe("BetaBadge", () => {
  beforeEach(() => {
    listeners.clear();
    vi.clearAllMocks();
    checkMock.mockResolvedValue(null);
    invokeMock.mockResolvedValue({
      appVersion: "0.2.0",
      osVersion: "macOS 15.0",
      arch: "aarch64",
      executor: "claude",
      modelInstalled: true,
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  it("shows the beta badge when no update is waiting", async () => {
    render(<BetaBadge />);
    expect(await screen.findByTestId("beta-badge")).toHaveTextContent("Beta");
    expect(screen.queryByTestId("restart-to-update")).toBeNull();
  });

  it("offers a restart once an update is found", async () => {
    checkMock.mockResolvedValue({ version: "0.2.1", downloadAndInstall });
    downloadAndInstall.mockResolvedValue(undefined);
    render(<BetaBadge />);

    const button = await screen.findByTestId("restart-to-update");
    await act(async () => {
      fireEvent.click(button);
    });

    expect(downloadAndInstall).toHaveBeenCalled();
    expect(relaunchMock).toHaveBeenCalled();
  });

  it("a failed update check leaves the badge alone", async () => {
    // A tester cannot act on it, and it retries in half an hour.
    checkMock.mockRejectedValue(new Error("offline"));
    render(<BetaBadge />);
    expect(await screen.findByTestId("beta-badge")).toBeInTheDocument();
  });

  it("reports model install progress and clears it when ready", async () => {
    render(<BetaBadge />);
    await screen.findByTestId("beta-badge");

    await act(async () => {
      emit("model-install", { stage: "downloading", done: 50, total: 100 });
    });
    expect(screen.getByTestId("beta-badge")).toHaveTextContent("setting up");
    expect(screen.getByTestId("model-progress")).toBeInTheDocument();

    await act(async () => {
      emit("model-install", { stage: "ready", done: 100, total: 100 });
    });
    expect(screen.getByTestId("beta-badge")).toHaveTextContent("Beta");
    expect(screen.queryByTestId("model-progress")).toBeNull();
  });

  it("sends a report with diagnostics attached", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ number: 7, url: "https://gh/7" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<BetaBadge />);
    fireEvent.click(await screen.findByTestId("open-feedback"));
    // The modal is portaled behind a transition, so it is awaited.
    fireEvent.change(await screen.findByTestId("feedback-title"), {
      target: { value: "Editor froze" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("send-feedback"));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.title).toBe("Editor froze");
    expect(sent.body).toContain("macOS 15.0");
    expect(sent.body).toContain("Agents: claude");
  });

  it("surfaces the worker's own message when a report is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: "Too many reports too quickly." }),
      })
    );

    render(<BetaBadge />);
    fireEvent.click(await screen.findByTestId("open-feedback"));
    // The modal is portaled behind a transition, so it is awaited.
    fireEvent.change(await screen.findByTestId("feedback-title"), {
      target: { value: "again" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("send-feedback"));
    });

    expect(await screen.findByTestId("feedback-error")).toHaveTextContent(
      "Too many reports too quickly."
    );
  });

  it("a report still sends when diagnostics fail", async () => {
    invokeMock.mockRejectedValue(new Error("no backend"));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ number: 8, url: "https://gh/8" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<BetaBadge />);
    fireEvent.click(await screen.findByTestId("open-feedback"));
    // The modal is portaled behind a transition, so it is awaited.
    fireEvent.change(await screen.findByTestId("feedback-title"), {
      target: { value: "still works" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("send-feedback"));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).body).not.toContain("macOS");
  });
});
