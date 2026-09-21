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

/** Which origins answer right now. */
const { up } = vi.hoisted(() => ({ up: new Set<string>() }));
vi.mock("../api", () => ({
  previewProbe: vi.fn((url: string) => Promise.resolve(up.has(new URL(url).origin) ? null : "Connection Failed")),
}));

import { useDevServers } from "../useDevServers";

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

const PROJECT = "proj";
const THREADS = ["thread-a", "thread-b"];

const pty = (text: string, terminalId = `${PROJECT}:1`) =>
  act(() => void handlers.get("terminal-output")?.({ payload: { terminalId, data: b64(text) } }));

const agent = (event: object, threadId = "thread-a") =>
  act(() => void handlers.get("executor-event")?.({ payload: { threadId, sessionId: "s", event } }));

/** Advances the clock and lets the probes that started meanwhile resolve. */
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

const mount = async (project: string | null = PROJECT, threads: string[] = THREADS) => {
  const hook = renderHook((props: { project: string | null }) => useDevServers(props.project, threads), {
    initialProps: { project },
  });
  await act(async () => {});
  return hook;
};

describe("useDevServers", () => {
  beforeEach(() => {
    handlers.clear();
    up.clear();
    vi.useFakeTimers();
  });

  describe("from a terminal", () => {
    it("offers a server whose banner appeared and which is answering", async () => {
      up.add("http://127.0.0.1:4403");
      const { result } = await mount();
      pty("Serving HTTP on 127.0.0.1 port 4403 (http://127.0.0.1:4403/) ...\r\n");
      await tick(400);
      expect(result.current.servers).toEqual([{ url: "http://127.0.0.1:4403/", origin: "terminal" }]);
    });

    it("offers nothing for a banner nothing is answering behind", async () => {
      const { result } = await mount();
      pty("Local: http://localhost:5173/\r\n");
      await tick(400);
      expect(result.current.servers).toEqual([]);
    });

    it("offers the server as soon as it starts listening, after printing its banner first", async () => {
      const { result } = await mount();
      pty("Local: http://localhost:5173/\r\n");
      await tick(400);
      expect(result.current.servers).toEqual([]);
      up.add("http://localhost:5173");
      await tick(1600);
      expect(result.current.servers).toHaveLength(1);
    });

    it("takes a wildcard bind as localhost — python's default banner", async () => {
      up.add("http://localhost:8000");
      const { result } = await mount();
      pty("Serving HTTP on :: port 8000 (http://[::]:8000/) ...\r\n");
      await tick(400);
      expect(result.current.servers[0].url).toBe("http://localhost:8000/");
    });

    it("ignores the half-drawn URL in a shell's echo of the typed command", async () => {
      up.add("http://127.0.0.1:4402");
      const { result } = await mount();
      pty("e\becho 'Local: http://127.0.0.1:44 \r[K0\r02/'[?2004l\r\r\n");
      pty("Local: http://127.0.0.1:4402/\r\n");
      await tick(400);
      expect(result.current.servers.map((s) => s.url)).toEqual(["http://127.0.0.1:4402/"]);
    });

    it("scans each terminal separately, so another tab's output cannot splice into a URL", async () => {
      up.add("http://localhost:5173");
      const { result } = await mount();
      pty("Local: http://localhost:", `${PROJECT}:1`);
      pty("noise from another tab\r\n", `${PROJECT}:2`);
      pty("5173/\r\n", `${PROJECT}:1`);
      await tick(400);
      expect(result.current.servers.map((s) => s.url)).toEqual(["http://localhost:5173/"]);
    });

    it("still scans a terminal that never goes quiet", async () => {
      up.add("http://localhost:5173");
      const { result } = await mount();
      pty("Local: http://localhost:5173/\r\n");
      for (let i = 0; i < 15; i++) {
        pty(".");
        await tick(100);
      }
      expect(result.current.servers).toHaveLength(1);
    });

    it("ignores a terminal that belongs to another project", async () => {
      up.add("http://localhost:5173");
      const { result } = await mount();
      pty("Local: http://localhost:5173/\r\n", "other:1");
      await tick(400);
      expect(result.current.servers).toEqual([]);
    });

    it("survives a payload it cannot decode instead of throwing", async () => {
      const { result } = await mount();
      act(() => void handlers.get("terminal-output")?.({ payload: { terminalId: `${PROJECT}:1`, data: "***not base64***" } }));
      await tick(400);
      expect(result.current.servers).toEqual([]);
    });
  });

  describe("from an agent", () => {
    it("offers a server the agent's message names, once it answers — the background-task case", async () => {
      up.add("http://127.0.0.1:4173");
      const { result } = await mount();
      agent({ kind: "text", text: "Server running, verified 200 response.\n\nhttp://127.0.0.1:4173/\n" });
      await tick(50);
      expect(result.current.servers).toEqual([{ url: "http://127.0.0.1:4173/", origin: "agent" }]);
    });

    it("offers a server named in a finished tool result", async () => {
      up.add("http://localhost:3000");
      const { result } = await mount();
      agent({ kind: "toolResult", id: "t", output: "ready - started server on http://localhost:3000", isError: false });
      await tick(50);
      expect(result.current.servers.map((s) => s.url)).toEqual(["http://localhost:3000/"]);
    });

    it("offers nothing for a URL in a tool result that nothing serves — a README is not a server", async () => {
      const { result } = await mount();
      agent({ kind: "toolResult", id: "t", output: "Run `npm run dev` then open http://localhost:3000", isError: false });
      await tick(50);
      expect(result.current.servers).toEqual([]);
    });

    it("offers each of several servers a message names", async () => {
      up.add("http://localhost:5173");
      up.add("http://localhost:8080");
      const { result } = await mount();
      agent({ kind: "text", text: "Frontend on http://localhost:5173, API on http://localhost:8080/api." });
      await tick(50);
      expect(result.current.servers.map((s) => s.url).sort()).toEqual(["http://localhost:5173/", "http://localhost:8080/"]);
    });

    it("ignores a thread that is not in this project", async () => {
      up.add("http://localhost:3000");
      const { result } = await mount();
      agent({ kind: "text", text: "http://localhost:3000" }, "thread-elsewhere");
      await tick(50);
      expect(result.current.servers).toEqual([]);
    });

    it("does not read streaming deltas — the finished message follows", async () => {
      up.add("http://localhost:3000");
      const { result } = await mount();
      agent({ kind: "textDelta", text: "http://localhost:3000" });
      await tick(50);
      expect(result.current.servers).toEqual([]);
    });
  });

  describe("liveness", () => {
    it("removes a server once it stops — the stale chip", async () => {
      up.add("http://localhost:5173");
      const { result } = await mount();
      pty("Local: http://localhost:5173/\r\n");
      await tick(400);
      expect(result.current.servers).toHaveLength(1);

      up.clear(); // Ctrl-C
      await tick(1500);
      expect(result.current.servers, "one missed check is not yet a stopped server").toHaveLength(1);
      await tick(1500);
      expect(result.current.servers).toEqual([]);
    });

    it("does not bring a stopped server back when the tab prints something else", async () => {
      up.add("http://localhost:5173");
      const { result } = await mount();
      pty("Local: http://localhost:5173/\r\n");
      await tick(400);
      up.clear();
      await tick(3200);
      expect(result.current.servers).toEqual([]);

      pty("^C\r\n$ ");
      await tick(400);
      await tick(1600);
      expect(result.current.servers, "scanned output is spent").toEqual([]);
    });

    it("shows a server again when it is restarted and prints its banner again", async () => {
      up.add("http://localhost:5173");
      const { result } = await mount();
      pty("Local: http://localhost:5173/\r\n");
      await tick(400);
      up.clear();
      await tick(3200);
      expect(result.current.servers).toEqual([]);

      up.add("http://localhost:5173");
      pty("Local: http://localhost:5173/\r\n");
      await tick(400);
      expect(result.current.servers).toHaveLength(1);
    });

    it("forgets everything when the project changes", async () => {
      up.add("http://localhost:5173");
      const { result, rerender } = await mount();
      pty("Local: http://localhost:5173/\r\n");
      await tick(400);
      expect(result.current.servers).toHaveLength(1);
      rerender({ project: "another" });
      await tick(50);
      expect(result.current.servers).toEqual([]);
    });

    it("lets the user dismiss a chip, and re-offers the server if it announces itself again", async () => {
      up.add("http://localhost:5173");
      const { result } = await mount();
      pty("Local: http://localhost:5173/\r\n");
      await tick(400);
      act(() => result.current.dismiss("http://localhost:5173/"));
      expect(result.current.servers).toEqual([]);

      pty("Local: http://localhost:5173/\r\n");
      await tick(400);
      expect(result.current.servers).toHaveLength(1);
    });
  });
});
