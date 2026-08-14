import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  allDiagnostics,
  clearDiagnostics,
  sortDiagnostics,
  toDiagnostics,
  type Diagnostic,
} from "../lspClients";

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  clearDiagnostics();
});

const row = (over: Partial<Diagnostic>): Diagnostic => ({
  path: "a.ts",
  line: 1,
  severity: "error",
  message: "boom",
  source: null,
  ...over,
});

describe("toDiagnostics", () => {
  it("makes the path project-relative and the line 1-based", () => {
    const rows = toDiagnostics(
      {
        uri: "file:///tmp/proj/src/App.tsx",
        diagnostics: [
          {
            range: { start: { line: 41 } },
            severity: 1,
            message: "Cannot find name 'foo'.",
            source: "ts",
          },
        ],
      },
      "/tmp/proj"
    );
    expect(rows).toEqual([
      {
        path: "src/App.tsx",
        // LSP counts lines from 0; a gutter that says 41 for line 42 is a bug.
        line: 42,
        severity: "error",
        message: "Cannot find name 'foo'.",
        source: "ts",
      },
    ]);
  });

  it("decodes an escaped URI back to a readable path", () => {
    const rows = toDiagnostics(
      { uri: "file:///tmp/my%20proj/a%20b.ts", diagnostics: [{}] },
      "/tmp/my proj"
    );
    expect(rows[0].path).toBe("a b.ts");
  });

  it("maps every LSP severity, defaulting to error when absent", () => {
    const rows = toDiagnostics(
      {
        uri: "file:///tmp/proj/a.ts",
        diagnostics: [
          { severity: 1 },
          { severity: 2 },
          { severity: 3 },
          { severity: 4 },
          {},
        ],
      },
      "/tmp/proj"
    );
    expect(rows.map((r) => r.severity)).toEqual([
      "error",
      "warning",
      "info",
      "hint",
      "error",
    ]);
  });

  it("returns nothing for a file the server just cleared", () => {
    expect(
      toDiagnostics({ uri: "file:///tmp/proj/a.ts", diagnostics: [] }, "/tmp/proj")
    ).toEqual([]);
  });
});

describe("sortDiagnostics", () => {
  it("puts errors first, then groups by file and line", () => {
    const sorted = sortDiagnostics([
      row({ path: "b.ts", line: 9, severity: "hint" }),
      row({ path: "b.ts", line: 2, severity: "error" }),
      row({ path: "a.ts", line: 400, severity: "error" }),
      row({ path: "a.ts", line: 1, severity: "warning" }),
    ]);
    expect(sorted.map((r) => `${r.severity} ${r.path}:${r.line}`)).toEqual([
      "error a.ts:400",
      "error b.ts:2",
      "warning a.ts:1",
      "hint b.ts:9",
    ]);
  });
});

describe("the diagnostics store", () => {
  it("starts empty and clears back to empty", () => {
    expect(allDiagnostics()).toEqual([]);
    clearDiagnostics();
    expect(allDiagnostics()).toEqual([]);
  });
});
