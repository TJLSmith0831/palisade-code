import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));

import { useDevServerPreview } from "../useDevServerPreview";

const b64 = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** The tagged payload the backend actually emits, now that a project can
 *  have several terminals open at once. */
const pty = (text: string, terminalId = "proj:1") =>
  act(() => {
    handlers.get("terminal-output")?.({ payload: { terminalId, data: b64(text) } });
  });

const settle = () => act(() => void vi.advanceTimersByTime(400));

describe("useDevServerPreview", () => {
  beforeEach(() => {
    handlers.clear();
    vi.useFakeTimers();
  });

  it("reports a dev-server URL printed in the terminal", async () => {
    const seen: string[] = [];
    renderHook(() => useDevServerPreview((url) => seen.push(url)));
    await act(async () => {});

    pty("Serving HTTP on 127.0.0.1 port 4403 (http://127.0.0.1:4403/) ...\r\n");
    settle();

    expect(seen).toEqual(["http://127.0.0.1:4403/"]);
  });

  // A shell's line editor repaints the command you typed with cursor escapes,
  // so mid-burst the buffer holds a half-drawn URL. Reported as-is it reads as
  // a different URL, sails past the dedup, and navigates to a bogus port.
  it("ignores the half-drawn URL in a shell's echo of the typed command", async () => {
    const seen: string[] = [];
    renderHook(() => useDevServerPreview((url) => seen.push(url)));
    await act(async () => {});

    pty("e\becho 'Local: http://127.0.0.1:44 \r[K0\r02/'[?2004l\r\r\n");
    pty("Local: http://127.0.0.1:4402/\r\n");
    settle();

    expect(seen).toEqual(["http://127.0.0.1:4402/"]);
  });

  it("does not re-report a URL it already reported (D11)", async () => {
    const seen: string[] = [];
    renderHook(() => useDevServerPreview((url) => seen.push(url)));
    await act(async () => {});

    pty("Local: http://localhost:5173/\r\n");
    settle();
    pty("Local: http://localhost:5173/\r\n");
    settle();

    expect(seen).toEqual(["http://localhost:5173/"]);
  });

  it("reports a genuinely different URL", async () => {
    const seen: string[] = [];
    renderHook(() => useDevServerPreview((url) => seen.push(url)));
    await act(async () => {});

    pty("Local: http://localhost:5173/\r\n");
    settle();
    pty("Local: http://localhost:4173/\r\n");
    settle();

    expect(seen).toEqual(["http://localhost:5173/", "http://localhost:4173/"]);
  });

  it("reports a URL an agent's tool call printed, with no terminal involved", async () => {
    const seen: string[] = [];
    renderHook(() => useDevServerPreview((url) => seen.push(url)));
    await act(async () => {});

    act(() => {
      handlers.get("executor-event")?.({
        payload: {
          sessionId: "s1",
          threadId: "t1",
          event: {
            kind: "toolResult",
            id: "1",
            output: "Serving HTTP on 127.0.0.1 port 4400 (http://127.0.0.1:4400/)",
            isError: false,
          },
        },
      });
    });

    expect(seen).toEqual(["http://127.0.0.1:4400/"]);
  });

  it("reads the tab-tagged payload the backend emits", async () => {
    // Regression: terminal output gained a `terminalId` when one project
    // became able to hold several shells. This hook still called
    // `atob(payload)` on the object, which threw InvalidCharacterError out
    // of an event handler and blanked the whole window.
    const seen: string[] = [];
    renderHook(() => useDevServerPreview((url) => seen.push(url)));
    await act(async () => {});

    pty("Local: http://127.0.0.1:5173/\r\n", "proj:2");
    settle();

    expect(seen).toEqual(["http://127.0.0.1:5173/"]);
  });

  it("watches every terminal, not just the first", async () => {
    // A dev server is as likely to be started in the second tab as the first.
    const seen: string[] = [];
    renderHook(() => useDevServerPreview((url) => seen.push(url)));
    await act(async () => {});

    pty("Local: http://127.0.0.1:3000/\r\n", "proj:3");
    settle();

    expect(seen).toEqual(["http://127.0.0.1:3000/"]);
  });

  it("survives a payload it cannot decode instead of throwing", async () => {
    // An event handler that throws takes the render tree down with it.
    const seen: string[] = [];
    renderHook(() => useDevServerPreview((url) => seen.push(url)));
    await act(async () => {});

    expect(() =>
      act(() => {
        handlers.get("terminal-output")?.({ payload: "not base64 at all !!!" });
        handlers.get("terminal-output")?.({ payload: null });
      })
    ).not.toThrow();

    pty("Local: http://127.0.0.1:4444/\r\n");
    settle();
    expect(seen).toEqual(["http://127.0.0.1:4444/"]);
  });
});
