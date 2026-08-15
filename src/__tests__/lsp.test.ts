import { beforeEach, describe, expect, it, vi } from "vitest";

const { listenMock, emit } = vi.hoisted(() => {
  const handlers: ((event: { payload: unknown }) => void)[] = [];
  return {
    listenMock: vi.fn((_name: string, handler: (e: { payload: unknown }) => void) => {
      handlers.push(handler);
      return Promise.resolve(() => {
        handlers.splice(handlers.indexOf(handler), 1);
      });
    }),
    emit: (payload: unknown) => handlers.forEach((h) => h({ payload })),
  };
});

vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  documentLanguageId,
  fileUri,
  languageForPath,
  makeTransport,
  stateLabel,
  stateTone,
} from "../lsp";

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
});

describe("languageForPath", () => {
  it("maps a file to the server language, by extension", () => {
    expect(languageForPath("src/App.tsx")).toBe("typescript");
    expect(languageForPath("main.rs")).toBe("rust");
    expect(languageForPath("a/b/c.yml")).toBe("yaml");
  });

  it("returns null for a file no server covers, rather than guessing", () => {
    expect(languageForPath("notes.txt")).toBeNull();
    expect(languageForPath("Makefile")).toBeNull();
  });
});

describe("documentLanguageId", () => {
  it("opens JSX files as their react language ids", () => {
    // Opening a .tsx as plain "typescript" makes the server read `<div>` as
    // a comparison and fill the Problems tab with phantom syntax errors.
    expect(documentLanguageId("src/App.tsx")).toBe("typescriptreact");
    expect(documentLanguageId("src/App.jsx")).toBe("javascriptreact");
  });

  it("matches the server key everywhere else", () => {
    expect(documentLanguageId("src/api.ts")).toBe("typescript");
    expect(documentLanguageId("main.rs")).toBe("rust");
    expect(documentLanguageId("notes.txt")).toBeNull();
  });
});

describe("fileUri", () => {
  it("builds a file URI from the project root and a relative path", () => {
    expect(fileUri("/tmp/proj", "src/App.tsx")).toBe(
      "file:///tmp/proj/src/App.tsx"
    );
  });

  it("keeps separators intact while escaping the segments", () => {
    // A space in a directory name must not end the URI, and the slashes
    // must survive — encoding the whole path would eat them.
    expect(fileUri("/tmp/my proj", "src/a b.ts")).toBe(
      "file:///tmp/my%20proj/src/a%20b.ts"
    );
  });

  it("tolerates a trailing slash on the root", () => {
    expect(fileUri("/tmp/proj/", "a.ts")).toBe("file:///tmp/proj/a.ts");
  });
});

describe("makeTransport", () => {
  it("sends through the IPC command for its own language", async () => {
    const transport = makeTransport("p1", "rust");
    transport.send('{"jsonrpc":"2.0"}');
    expect(invokeMock).toHaveBeenCalledWith("lsp_send", {
      projectHash: "p1",
      language: "rust",
      body: '{"jsonrpc":"2.0"}',
    });
    transport.dispose();
  });

  it("delivers only its own language's messages to subscribers", async () => {
    const transport = makeTransport("p1", "rust");
    const seen: string[] = [];
    transport.subscribe((body) => seen.push(body));

    emit({ language: "python", body: "not mine" });
    emit({ language: "rust", body: "mine" });

    expect(seen).toEqual(["mine"]);
    transport.dispose();
  });

  it("stops delivering after unsubscribe and after dispose", async () => {
    const transport = makeTransport("p1", "rust");
    const seen: string[] = [];
    const handler = (body: string) => seen.push(body);
    transport.subscribe(handler);
    transport.unsubscribe(handler);
    emit({ language: "rust", body: "one" });
    expect(seen).toEqual([]);

    transport.subscribe(handler);
    transport.dispose();
    emit({ language: "rust", body: "two" });
    expect(seen).toEqual([]);
  });

  it("does not throw when the server is gone — the status bar reports that", () => {
    invokeMock.mockRejectedValue(new Error("no language server running"));
    const transport = makeTransport("p1", "rust");
    expect(() => transport.send("{}")).not.toThrow();
    transport.dispose();
  });
});

describe("status labels", () => {
  it("names the reason for every state, never just 'off'", () => {
    const base = { language: "rust", server: "rust-analyzer", restarts: 0 };
    expect(stateLabel({ ...base, state: "running", detail: null })).toContain(
      "running"
    );
    expect(
      stateLabel({ ...base, state: "notInstalled", detail: null })
    ).toContain("not installed");
    expect(
      stateLabel({ ...base, state: "disabled", restarts: 3, detail: null })
    ).toContain("3 crashes");
    expect(
      stateLabel({ ...base, state: "crashed", restarts: 1, detail: null })
    ).toContain("restarting (1/3)");
    expect(
      stateLabel({ ...base, state: "unsupported", server: null, detail: null })
    ).toContain("No language server");
  });

  it("pairs each state with a semantic tone", () => {
    expect(stateTone("running")).toBe("success");
    expect(stateTone("crashed")).toBe("warn");
    expect(stateTone("disabled")).toBe("bad");
    expect(stateTone(null)).toBe("muted");
  });
});
